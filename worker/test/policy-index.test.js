// searchLaurier with the policy index bound: indexed sections replace the live catalog fetches.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { searchLaurier } from "../src/laurier.js";
import { localAdapter } from "../../policy_index/src/server.mjs";
import { sqliteStore } from "../../policy_index/src/store-sqlite.mjs";
import { sync } from "../../policy_index/src/sync.mjs";
import { fakeEmbedder, fakeSite, PAGES } from "../../policy_index/test/helpers.mjs";

let index;
before(async () => {
  const store = sqliteStore();
  const embedder = fakeEmbedder();
  await sync({ store, get: fakeSite(PAGES).get, embedder, curated: [] });
  index = localAdapter({ store, embedder });
});
const opts = (extra) => ({ k: 3, ctx: { waitUntil() {} }, siteSearchOn: false, ...extra });

test("simple mode cites indexed sections with their clauses and links, keyword search only", async () => {
  let embedded = 0;
  const counting = { ...index, embed: (t) => (embedded++, index.embed(t)) };
  const r = await searchLaurier("first offence penalty", opts({ question: "What is the penalty for a first offence?", mode: "simple", index: counting, rerank: () => assert.fail("simple mode never reranks") }));
  assert.equal(embedded, 0);
  assert.equal(r.sources[0].pageId, "policy:12.2-student-code-of-conduct");
  assert.equal(r.sources[0].viaIndex, true);
  assert.ok(r.sources.some((s) => s.section === "5.00 Penalties (5.01)" && /#:~:text=5\.00%20Penalties$/.test(s.url)));
  assert.equal(r.sources[0].revised, "June 2, 2024");
  assert.ok(r.pages.every((p) => p.viaIndex && p.fetchedAt));
});

test("full mode adds vector search and lets the cross-encoder pick", async () => {
  let pool;
  const rerank = async (q, texts) => ((pool = texts), texts.map((t, index) => ({ index, score: /electronic devices/.test(t) ? 0.9 : 0.02 })).sort((a, b) => b.score - a.score));
  const r = await searchLaurier("phones in class (digital devices)", opts({ question: "Can instructors ban phones in class?", mode: "full", index, rerank }));
  assert.ok(pool.length > 1);
  assert.equal(r.sources[0].pageId, "policy:9.3-classroom-use-of-electronic-devices");
  assert.equal(r.sources[0].score, 0.9);
});

test("if the index fails, the live catalog path takes over and the failure is listed", async () => {
  const broken = { ...index, lexical: async () => { throw new Error("D1_ERROR: no such table"); } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  try {
    const r = await searchLaurier("penalty for plagiarism", opts({ question: "What is the penalty for plagiarism?", mode: "simple", index: broken }));
    assert.ok(r.pages.some((p) => p.id === "policy-index" && /no such table/.test(p.error)));
    assert.ok(r.pages.some((p) => p.error === "HTTP 503"), "fell back to fetching catalog pages");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("full mode never settles for keyword-only index results when vector search fails", async () => {
  const noVectors = { ...index, embed: async () => { throw new Error("4006: you have used up your daily free allocation"); } };
  const quota = async () => { throw new Error("rerank: 4006: daily free allocation"); };
  await assert.rejects(searchLaurier("penalty for plagiarism", opts({ question: "What is the penalty for plagiarism?", mode: "full", index: noVectors, rerank: quota })), /4006/);
  const simple = await searchLaurier("first offence penalty", opts({ question: "What is the penalty for a first offence?", mode: "simple", index: noVectors, rerank: quota }));
  assert.ok(simple.sources[0].viaIndex, "Simple mode is keyword search by design");
});
