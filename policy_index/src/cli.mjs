#!/usr/bin/env node
// policy-index: build, update, search and serve the Laurier policy index.
//
//   node src/cli.mjs sync [--store sqlite|cloudflare] [--db PATH] [--changed-only] [--dry-run]
//                         [--only TEXT] [--limit N] [--force] [--report FILE] [--delay MS]
//   node src/cli.mjs search "question" [--k 5] [--kinds policy,procedure] [--rerank] [--json]
//   node src/cli.mjs section ID [--around 1]
//   node src/cli.mjs stats [--store sqlite|cloudflare]
//   node src/cli.mjs serve [--port 8790] [--host 127.0.0.1] [--rerank] [--sync-every DAYS]
//   node src/cli.mjs mcp                      MCP over stdio, for local agents
//   node src/cli.mjs eval [--k 3] [--rerank]  page-level retrieval check on data/web_eval.json
//   node src/cli.mjs init --store cloudflare  create the D1 tables and check the Vectorize index
//
// Cloudflare settings come from the environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
// D1_DATABASE_ID, VECTORIZE_INDEX (default wlu-policies). EMBEDDER=local|workers-ai (default local).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embedderFromEnv } from "./embed.mjs";
import { localReranker } from "./rerank.mjs";
import { getSection, renderResults, search } from "./search.mjs";
import { localAdapter, serve } from "./server.mjs";
import { politeFetcher } from "./sources.mjs";
import { cloudflareStoreFromEnv } from "./store-cloudflare.mjs";
import { sqliteStore } from "./store-sqlite.mjs";
import { summarize, sync } from "./sync.mjs";
import { handleMcp } from "./tool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const DEFAULT_DB = process.env.POLICY_DB || join(here, "..", "data", "policies.sqlite");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const openStore = (args) => (args.store === "cloudflare" ? cloudflareStoreFromEnv() : sqliteStore(resolve(args.db || DEFAULT_DB)));
const reranker = (args) => (args.rerank || process.env.RERANK === "local" ? localReranker({ cacheDir: process.env.MODEL_CACHE_DIR }) : null);
const err = (...a) => console.error(...a);

async function runSync(store, args, log = err) {
  const report = await sync({
    store,
    get: politeFetcher({ delayMs: Number(args.delay ?? 1000) }),
    embedder: embedderFromEnv(),
    only: args.only,
    limit: args.limit && Number(args.limit),
    changedOnly: !!args["changed-only"],
    dryRun: !!args["dry-run"],
    force: !!args.force,
    log,
  });
  if (args.report) {
    mkdirSync(dirname(resolve(args.report)), { recursive: true });
    writeFileSync(resolve(args.report), JSON.stringify(report, null, 1) + "\n");
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];

  if (cmd === "sync") {
    const store = openStore(args);
    await store.init();
    const report = await runSync(store, args);
    store.close?.();
    console.log(summarize(report));
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Policy index sync\n\n\`\`\`\n${summarize(report)}\n\`\`\`\n`, { flag: "a" });
    process.exitCode = report.errors.some((e) => !e.page_id) ? 1 : 0;
    return;
  }
  if (cmd === "init") {
    const store = openStore(args);
    console.log(JSON.stringify(await store.init(), null, 1) ?? "ok");
    return;
  }
  if (cmd === "stats") {
    const store = openStore(args);
    console.log(JSON.stringify({ ...(await store.stats()), last_sync: await store.getMeta("last_sync"), fingerprint: await store.getMeta("fingerprint") }, null, 1));
    return;
  }
  if (cmd === "search") {
    const store = sqliteStore(resolve(args.db || DEFAULT_DB));
    const adapter = localAdapter({ store, embedder: args["no-dense"] ? null : embedderFromEnv(), reranker: reranker(args) });
    const r = await search(adapter, args._.slice(1).join(" "), { k: Number(args.k) || 5, kinds: args.kinds });
    console.log(args.json ? JSON.stringify(r, null, 1) : `${renderResults(r)}\n\n(${r.timings.totalMs} ms, ${r.candidates.lexical} keyword + ${r.candidates.dense} vector candidates${r.reranked ? ", reranked" : ""})`);
    return;
  }
  if (cmd === "section") {
    const store = sqliteStore(resolve(args.db || DEFAULT_DB));
    console.log(JSON.stringify(await getSection(localAdapter({ store }), args._[1], args.around ?? 1), null, 1));
    return;
  }
  if (cmd === "serve") {
    const store = sqliteStore(resolve(args.db || DEFAULT_DB));
    const adapter = localAdapter({ store, embedder: embedderFromEnv(), reranker: reranker(args) });
    let running = null;
    const onSync = () => {
      if (!running) running = runSync(store, args, (m) => err(`[sync] ${m}`)).then((r) => (err(summarize(r)), r)).finally(() => (running = null));
      return { running: true };
    };
    const days = Number(args["sync-every"] || process.env.SYNC_EVERY_DAYS || 0);
    if (!(await store.stats()).chunks) {
      err("index is empty: building it now (about 5 minutes at one page a second); search works when it finishes");
      onSync();
    }
    if (days > 0) setInterval(onSync, days * 86400e3).unref();
    const port = Number(args.port || process.env.PORT || 8790);
    const host = args.host || process.env.HOST || "127.0.0.1";
    await serve({ store, adapter, onSync: process.env.ALLOW_SYNC_ENDPOINT === "1" ? onSync : undefined }, port, host);
    err(`policy index on http://${host}:${port} (${JSON.stringify(await store.stats())})`);
    return;
  }
  if (cmd === "mcp") {
    const store = sqliteStore(resolve(args.db || DEFAULT_DB));
    const adapter = localAdapter({ store, embedder: embedderFromEnv(), reranker: reranker(args) });
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        continue;
      }
      const out = await handleMcp(adapter, msg);
      if (out) process.stdout.write(JSON.stringify(out) + "\n");
    }
    return;
  }
  if (cmd === "eval") {
    const store = sqliteStore(resolve(args.db || DEFAULT_DB));
    const adapter = localAdapter({ store, embedder: args["no-dense"] ? null : embedderFromEnv(), reranker: reranker(args) });
    const items = JSON.parse(readFileSync(join(repo, "data", "web_eval.json"), "utf8")).filter((q) => q.laurier && !q.id.startsWith("S"));
    const k = Number(args.k) || 3;
    const rows = [];
    for (const it of items) {
      const r = await search(adapter, it.question, { k: 5 });
      const hitAt = r.results.findIndex((h) => it.laurier.some((w) => w === h.page_id || h.page_url.includes(w)));
      rows.push({ id: it.id, question: it.question, want: it.laurier, rank: hitAt + 1 || null, top: r.results.map((h) => h.citation), ms: r.timings.totalMs });
      console.log(`${it.id.padEnd(4)} ${hitAt >= 0 && hitAt < k ? "hit " : hitAt >= 0 ? "top5" : "MISS"} ${hitAt >= 0 ? `#${hitAt + 1}` : "  "}  ${it.question}\n       ${r.results[0]?.citation || "(nothing)"}`);
    }
    const at = (n) => rows.filter((r) => r.rank && r.rank <= n).length;
    const summary = { questions: rows.length, [`top${k}`]: at(k), top5: at(5), reranked: !!reranker(args), dense: !args["no-dense"] };
    console.log(`\nexpected page in top ${k}: ${at(k)}/${rows.length}; in top 5: ${at(5)}/${rows.length}`);
    const out = join(repo, "results", "policy_index_eval.json");
    const prev = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
    const key = `${summary.dense ? "hybrid" : "keyword"}${summary.reranked ? "+rerank" : ""}`;
    writeFileSync(out, JSON.stringify({ ...prev, [key]: { date: new Date().toISOString().slice(0, 10), summary, rows } }, null, 1) + "\n");
    return;
  }
  err(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e) => {
  err(e);
  process.exit(1);
});
