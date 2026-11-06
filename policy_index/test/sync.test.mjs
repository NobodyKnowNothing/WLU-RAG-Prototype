import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA } from "../src/schema.mjs";
import { cloudflareStore } from "../src/store-cloudflare.mjs";
import { sqliteStore } from "../src/store-sqlite.mjs";
import { FINGERPRINT, prepareRows, sync } from "../src/sync.mjs";
import { search } from "../src/search.mjs";
import { localAdapter } from "../src/server.mjs";
import { BASE, fakeEmbedder, fakeSite, PAGES, policyHtml } from "./helpers.mjs";

const A = `${BASE}12.2-student-code-of-conduct.html`;
const B = `${BASE}9.3-classroom-use-of-electronic-devices.html`;
const C = `${BASE}procedures-for-student-code-of-conduct.html`;
const run = (store, site, embedder, extra = {}) => sync({ store, get: site.get, embedder, curated: [], ...extra });
const ftsCount = (store, word) => store.db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?").get(word).n;

test("first run embeds every chunk; an unchanged second run writes nothing", async () => {
  const store = sqliteStore();
  const site = fakeSite(PAGES);
  const emb = fakeEmbedder();
  const r1 = await run(store, site, emb);
  assert.equal(r1.added.length, 3);
  assert.equal(r1.errors.length, 0);
  const { chunks, embedded } = await store.stats();
  assert.equal(r1.embedded, chunks);
  assert.equal(embedded, chunks);
  assert.equal(await store.getMeta("fingerprint"), FINGERPRINT);

  const texts = emb.texts;
  const r2 = await run(store, site, emb);
  assert.deepEqual([r2.added.length, r2.changed.length, r2.unchanged, r2.embedded, r2.rowsWritten], [0, 0, 3, 0, 0]);
  assert.equal(emb.texts, texts);
});

test("an edited, an added and a removed section are re-embedded, embedded and deleted", async () => {
  const store = sqliteStore();
  const site = fakeSite(PAGES);
  const emb = fakeEmbedder();
  await run(store, site, emb);
  const before = await store.stats();

  // edit one clause, add a section, drop a section
  site.pages.set(
    A,
    PAGES[A].replace("a written warning or a zero on the work", "a written warning, a zero on the work, or a transcript notation")
      .replace("<h2>4.00 Policy</h2><p>4.01 Students are responsible for the integrity of their work.</p>", "")
      .replace("<h2>Appendix", "<h2>6.00 Appeals</h2><p>6.01 Students may appeal a finding within 10 business days.</p>\n<h2>Appendix")
  );
  const textsBefore = emb.texts;
  const r = await run(store, site, emb);
  assert.equal(r.changed.length, 1);
  assert.equal(r.unchanged, 2);
  const s = r.changed[0].sections;
  assert.deepEqual(s.changed, ["5.00 Penalties (5.01)"]);
  assert.deepEqual(s.added, ["6.00 Appeals (6.01)"]);
  assert.deepEqual(s.removed, ["4.00 Policy (4.01)"]);
  assert.equal(emb.texts - textsBefore, 2, "only the edited and the new section are embedded");
  assert.equal(r.chunksDeleted, 1);
  assert.equal((await store.stats()).chunks, before.chunks);

  // the keyword index followed the rows
  assert.equal(ftsCount(store, "notation"), 1);
  assert.equal(ftsCount(store, "integrity"), 0);
  assert.equal(ftsCount(store, "appeal"), 1);
  const hit = await search(localAdapter({ store, embedder: emb }), "Can I appeal a misconduct finding?", { k: 1 });
  assert.equal(hit.results[0].section, "6.00 Appeals");
  assert.equal(hit.results[0].citation, "12.2 Student Code of Conduct: Academic Misconduct > 6.00 Appeals, 6.01");
});

test("a page that leaves the sitemap is deleted; a mass disappearance is refused without --force", async () => {
  const store = sqliteStore();
  const site = fakeSite(PAGES);
  const emb = fakeEmbedder();
  await run(store, site, emb);

  site.listed = [A, C];
  // one of three pages is 33%, above the default 20% guard meant for a ~190-page register
  assert.equal((await run(store, site, emb, { dryRun: true })).removed.length, 0);
  const r = await run(store, site, emb, { maxRemovalShare: 0.5 });
  assert.deepEqual(r.removed.map((p) => p.page_id), ["policy:9.3-classroom-use-of-electronic-devices"]);
  assert.equal(ftsCount(store, "lectures"), 0);
  assert.equal((await store.listPages()).length, 2);

  site.listed = [];
  site.pages.clear();
  const refused = await run(store, site, emb);
  assert.equal(refused.removed.length, 0);
  assert.match(refused.errors[0].error, /refusing to delete 2 of 2 pages/);
  const forced = await run(store, site, emb, { force: true });
  assert.equal(forced.removed.length, 2);
  assert.equal((await store.stats()).chunks, 0);
});

test("a page that fails to load keeps its old chunks", async () => {
  const store = sqliteStore();
  const site = fakeSite(PAGES);
  await run(store, site, fakeEmbedder());
  const before = (await store.stats()).chunks;
  site.fail.add(B);
  const r = await run(store, site, fakeEmbedder());
  assert.deepEqual(r.errors.map((e) => [e.page_id, e.error]), [["policy:9.3-classroom-use-of-electronic-devices", "HTTP 503"]]);
  assert.equal((await store.stats()).chunks, before);
  assert.equal((await store.listPages()).find((p) => p.url === B).error, "HTTP 503");
});

test("--changed-only skips pages whose sitemap date is unchanged; dry runs write nothing", async () => {
  const store = sqliteStore();
  const site = fakeSite(PAGES);
  await run(store, site, fakeEmbedder());
  site.requests.length = 0;
  const r = await run(store, site, fakeEmbedder(), { changedOnly: true });
  assert.equal(r.skipped, 3);
  assert.ok(!site.requests.includes(A));

  site.pages.set(B, policyHtml({ title: "9.3 Classroom Use of Electronic Devices", revised: "May 5, 2026", sections: [["3.00 Policy", "<p>3.01 Devices are allowed.</p>"]] }));
  const emb = fakeEmbedder();
  const dry = await run(store, site, emb, { dryRun: true });
  assert.equal(dry.changed.length, 1);
  assert.equal(emb.texts, 0);
  assert.equal(ftsCount(store, "lectures"), 1, "dry run left the old text");
});

test("changing the model or chunker fingerprint changes every chunk hash", () => {
  const chunk = { id: "x", section: "s", enriched: "T | s\ntext", text: "text" };
  assert.notEqual(prepareRows([chunk], "T")[0].hash, prepareRows([chunk], "T", "other-model/mean/384/chunker-v1")[0].hash);
});

// A fake Cloudflare API: D1 queries run on a real SQLite database, Vectorize keeps vectors in a Map.
function fakeCloudflare() {
  const db = new DatabaseSync(":memory:");
  const vectors = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/client\/v4\/accounts\/acc/, "");
    calls.push(path);
    const ok = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
    if (init.headers.Authorization !== "Bearer tok") return new Response(JSON.stringify({ success: false, errors: [{ message: "auth" }] }), { status: 403 });
    if (path === "/d1/database/db1/query") {
      const { batch } = JSON.parse(init.body);
      return ok(batch.map(({ sql, params }) => ({ success: true, results: /^\s*(SELECT|WITH)/i.test(sql) ? db.prepare(sql).all(...params) : (db.prepare(sql).run(...params), []) })));
    }
    if (path === "/vectorize/v2/indexes/idx/upsert") {
      const file = init.body.get("vectors");
      for (const line of (await file.text()).split("\n")) {
        const v = JSON.parse(line);
        assert.ok(v.id.length <= 64 && v.values.length && v.metadata.page_id && v.metadata.kind);
        vectors.set(v.id, v);
      }
      return ok({ mutationId: "m1" });
    }
    if (path === "/vectorize/v2/indexes/idx/delete_by_ids") {
      for (const id of JSON.parse(init.body).ids) vectors.delete(id);
      return ok({ mutationId: "m2" });
    }
    if (path === "/vectorize/v2/indexes/idx/info") return ok({ dimensions: 64, vectorCount: vectors.size });
    return new Response("{}", { status: 404 });
  };
  return { db, vectors, calls, fetchImpl };
}

test("the Cloudflare store keeps D1 rows and Vectorize vectors in step", async () => {
  const cf = fakeCloudflare();
  const store = cloudflareStore({ accountId: "acc", apiToken: "tok", databaseId: "db1", indexName: "idx", fetchImpl: cf.fetchImpl });
  await store.init();
  for (const s of SCHEMA) assert.ok(s); // schema applied through the API
  const site = fakeSite(PAGES);
  const r1 = await run(store, site, fakeEmbedder());
  const n = cf.db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n;
  assert.equal(r1.embedded, n);
  assert.equal(cf.vectors.size, n);
  assert.equal((await store.stats()).embedded, n);

  site.pages.set(A, PAGES[A].replace("<h2>4.00 Policy</h2><p>4.01 Students are responsible for the integrity of their work.</p>", ""));
  site.listed = [A, C];
  const r2 = await run(store, site, fakeEmbedder(), { maxRemovalShare: 0.5 });
  assert.equal(r2.changed.length, 1);
  assert.equal(r2.removed.length, 1);
  const ids = cf.db.prepare("SELECT id FROM chunks").all().map((r) => r.id).sort();
  assert.deepEqual([...cf.vectors.keys()].sort(), ids);
  assert.equal(cf.db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'lectures'").get().n, 0);

  const r3 = await run(store, site, fakeEmbedder());
  assert.equal(r3.unchanged, 2);
  assert.ok(!cf.calls.slice(-5).some((p) => p.includes("vectorize")), "nothing sent to Vectorize when nothing changed");
});

test("the Cloudflare store reports API errors", async () => {
  const cf = fakeCloudflare();
  const store = cloudflareStore({ accountId: "acc", apiToken: "wrong", databaseId: "db1", indexName: "idx", fetchImpl: cf.fetchImpl });
  await assert.rejects(store.init(), /HTTP 403/);
});
