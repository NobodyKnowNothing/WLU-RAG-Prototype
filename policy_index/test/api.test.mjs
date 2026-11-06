import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../cloudflare/worker.js";
import { ftsQuery, search, toAssistantSource } from "../src/search.mjs";
import { localAdapter, serve } from "../src/server.mjs";
import { sqliteStore } from "../src/store-sqlite.mjs";
import { sync } from "../src/sync.mjs";
import { handleMcp, TOOLS } from "../src/tool.mjs";
import { fakeEmbedder, fakeSite, PAGES } from "./helpers.mjs";

let store, emb, adapter, server, base;
before(async () => {
  store = sqliteStore();
  emb = fakeEmbedder();
  await sync({ store, get: fakeSite(PAGES).get, embedder: emb, curated: [] });
  adapter = localAdapter({ store, embedder: emb });
  server = await serve({ store, adapter, apiToken: "secret" }, 0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("keyword queries drop stopwords and keep policy numbers as phrases", () => {
  assert.equal(ftsQuery("What does Laurier's policy 12.2 say about cheating?"), '"policy" OR "12.2" OR "say" OR "about" OR "cheating"');
  assert.equal(ftsQuery('cheating" OR NEAR(* AND x)'), '"cheating" OR "near"');
  assert.equal(ftsQuery("the of and"), "");
});

test("hybrid search returns cited sections, best first, at most two per page", async () => {
  const r = await search(adapter, "Can my instructor ban phones in lectures?", { k: 3 });
  assert.equal(r.results[0].citation, "9.3 Classroom Use of Electronic Devices > 3.00 Policy, 3.01");
  assert.match(r.results[0].url, /9\.3-classroom-use-of-electronic-devices\.html#:~:text=3\.00%20Policy$/);
  assert.equal(r.results[0].revised, "June 2, 2024");
  assert.ok(r.candidates.lexical > 0 && r.candidates.dense > 0);
  const many = await search(adapter, "academic misconduct penalty offence plagiarism", { k: 10 });
  const perPage = Object.values(Object.groupBy(many.results, (h) => h.page_id)).map((g) => g.length);
  assert.ok(Math.max(...perPage) <= 2);
  const onlyProcedures = await search(adapter, "academic misconduct", { k: 5, kinds: ["procedure"] });
  assert.ok(onlyProcedures.results.length && onlyProcedures.results.every((h) => h.kind === "procedure"));
  const src = toAssistantSource(r.results[0]);
  assert.deepEqual(Object.keys(src).sort(), ["authority", "fetchedAt", "kind", "pageId", "publisher", "revised", "score", "section", "text", "title", "url"]);
  assert.equal(src.section, "3.00 Policy (3.01)");
});

test("HTTP API: auth, search, section, policies", async () => {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal((await fetch(`${base}/search`, { method: "POST", body: "{}" })).status, 401);
  const auth = { Authorization: "Bearer secret", "Content-Type": "application/json" };
  const r = await (await fetch(`${base}/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "first offence penalty", k: 2 }) })).json();
  assert.equal(r.results.length, 2);
  const sec = await (await fetch(`${base}/section/${r.results[0].id}?around=1`, { headers: auth })).json();
  assert.ok(sec.chunks.some((c) => c.requested) && sec.chunks.length >= 2);
  const pages = await (await fetch(`${base}/policies?kinds=procedure`, { headers: auth })).json();
  assert.deepEqual(pages.pages.map((p) => p.kind), ["procedure"]);
  assert.equal((await fetch(`${base}/search`, { method: "POST", headers: auth, body: JSON.stringify({ query: "" }) })).status, 400);
});

test("MCP: an SDK client lists and calls the tools over Streamable HTTP", async () => {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: "Bearer secret" } } }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["search_policies", "get_policy_section", "list_policies"]);
  const res = await client.callTool({ name: "search_policies", arguments: { query: "What is the penalty for a first offence of plagiarism?", k: 3 } });
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /^\[1\] 12\.2 Student Code of Conduct: Academic Misconduct > /);
  const top = res.structuredContent.results[0];
  const sec = await client.callTool({ name: "get_policy_section", arguments: { id: top.id, around: 1 } });
  assert.match(sec.content[0].text, />> /);
  const bad = await client.callTool({ name: "get_policy_section", arguments: { id: "nope" } });
  assert.equal(bad.isError, true);
  await client.close();
});

test("MCP handler: version negotiation, notifications, errors", async () => {
  const init = await handleMcp(adapter, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal((await handleMcp(adapter, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).result.protocolVersion, "2025-11-25");
  assert.equal(await handleMcp(adapter, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await handleMcp(adapter, { jsonrpc: "2.0", id: 3, method: "resources/list" })).error.code, -32601);
  assert.equal((await handleMcp(adapter, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_policies", arguments: { query: "" } } })).result.isError, true);
  assert.ok(TOOLS.every((t) => t.inputSchema.type === "object" && t.annotations.readOnlyHint));
});

// Stand-ins for the Worker's bindings, backed by the same SQLite index.
function workerEnv() {
  const d1 = {
    prepare: (sql) => {
      const stmt = { params: [] };
      stmt.bind = (...p) => ((stmt.params = p), stmt);
      stmt.all = async () => ({ results: store.db.prepare(sql).all(...stmt.params) });
      stmt.first = async () => store.db.prepare(sql).get(...stmt.params) ?? null;
      return stmt;
    },
  };
  const calls = [];
  return {
    calls,
    env: {
      DB: d1,
      VECTORIZE: { query: async (v, opts) => (calls.push(["vectorize", opts]), { matches: await store.dense(v, opts.topK, opts.filter?.kind?.$in) }) },
      AI: {
        run: async (model, input) => {
          calls.push([model]);
          if (model.includes("bge-small")) return { shape: [1, 64], data: await emb.embed(input.text).then((vs) => vs.map((v) => [...v])) };
          const words = new Set(input.query.toLowerCase().match(/[a-z]{4,}/g));
          return { response: input.contexts.map((c, id) => ({ id, score: (c.text.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => words.has(w)).length / 10 })) };
        },
      },
      ALLOWED_ORIGINS: "https://nobodyknownothing.github.io",
    },
  };
}

test("Worker: search, MCP and CORS through the bindings", async () => {
  const { env, calls } = workerEnv();
  const post = (path, body, headers = {}) => worker.fetch(new Request(`https://w.example${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
  const plain = await (await post("/search", { query: "Can instructors restrict electronic devices in class?", k: 2 })).json();
  assert.equal(plain.reranked, false);
  assert.deepEqual(calls.splice(0).map((c) => c[0]), ["@cf/baai/bge-small-en-v1.5", "vectorize"]);
  env.RERANK = "on";
  const res = await post("/search", { query: "Can instructors restrict electronic devices in class?", k: 2 }, { Origin: "https://nobodyknownothing.github.io" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://nobodyknownothing.github.io");
  const r = await res.json();
  assert.equal(r.reranked, true);
  assert.equal(r.results[0].page_id, "policy:9.3-classroom-use-of-electronic-devices");
  assert.deepEqual(calls.map((c) => c[0]), ["@cf/baai/bge-small-en-v1.5", "vectorize", "@cf/baai/bge-reranker-base"]);

  const filtered = await (await post("/search", { query: "misconduct", kinds: ["procedure"] })).json();
  assert.deepEqual(calls.at(-2)[1].filter, { kind: { $in: ["procedure"] } });
  assert.ok(filtered.results.every((h) => h.kind === "procedure"));

  const list = await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  assert.equal(list.result.tools.length, 3);
  const note = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal((await worker.fetch(new Request("https://w.example/mcp"), env)).status, 405);
  const health = await (await worker.fetch(new Request("https://w.example/health"), env)).json();
  assert.ok(health.ok && health.chunks > 0);

  env.API_TOKEN = "t";
  assert.equal((await post("/search", { query: "x" })).status, 401);
  assert.equal((await post("/search", { query: "devices" }, { Authorization: "Bearer t" })).status, 200);
});
