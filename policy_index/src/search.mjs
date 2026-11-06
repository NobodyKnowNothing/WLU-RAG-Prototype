// Hybrid search over the index: FTS5 keyword ranking and vector similarity, fused with reciprocal
// rank fusion, optionally reranked by a cross-encoder, at most `perPage` sections per page.
//
// Runtime-agnostic: no Node built-ins. The same code runs in the local server (SQLite adapter) and
// in the Cloudflare Worker (D1 + Vectorize + Workers AI adapter). An adapter provides:
//   lexical(match, limit, kinds) -> [{ id, score }]      FTS5 MATCH expression
//   embed(text) -> number[]                                query vector (optional)
//   dense(vector, limit, kinds) -> [{ id, score }]         (optional)
//   rerank(query, texts) -> [{ index, score }] best first  (optional)
//   chunksByIds(ids), sectionOf(id, around), catalog(kinds) -> rows
import { expandQuery, rrf, tokenize } from "../../worker/src/retrieval.js";
import { authorityLabel, citationOf } from "./cite.mjs";

export const KINDS = ["policy", "procedure", "other", "calendar", "guidance"];
export const DEFAULTS = { k: 5, pool: 50, rerankPool: 30, perPage: 2 };

// Every content word of the question as an OR of quoted FTS5 terms, so punctuation in a question
// can't be read as query syntax. The assistant's stopwords apply (including "Laurier", which is on
// every page); stemming is left to FTS5's porter tokenizer. "12.2" stays a phrase ("12" "2").
export function ftsQuery(text) {
  const words = (String(text).toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)*/g) || []).filter((w) => w.length > 1 && tokenize(w).length);
  return [...new Set(words)].map((w) => `"${w}"`).join(" OR ");
}

export function formatHit(row, score) {
  return {
    id: row.id,
    citation: citationOf(row),
    title: row.title,
    section: row.section,
    clauses: row.clauses || "",
    url: row.url,
    page_url: row.page_url,
    page_id: row.page_id,
    publisher: row.publisher,
    authority: row.authority,
    kind: row.kind,
    number: row.number || null,
    revised: row.revised || null,
    text: row.text,
    score: Math.round(score * 1e4) / 1e4,
    fetched_at: row.fetched_at,
  };
}

// The source shape worker/src/answer.js expects for a Laurier page, so search results can replace
// the Worker's live page fetches without touching the prompt or the quote checks.
export const toAssistantSource = (h) => ({
  kind: "laurier",
  pageId: h.page_id,
  title: h.title,
  publisher: h.publisher,
  authority: h.authority,
  ...(h.revised && { revised: h.revised }),
  section: h.clauses && !h.section.split(" > ").at(-1).startsWith(`${h.clauses} `) ? `${h.section} (${h.clauses})` : h.section,
  url: h.url,
  fetchedAt: h.fetched_at,
  text: h.text,
  score: h.score,
});

const cleanKinds = (kinds) => {
  const k = (Array.isArray(kinds) ? kinds : kinds ? String(kinds).split(",") : []).map((x) => String(x).trim()).filter((x) => KINDS.includes(x));
  return k.length ? k : null;
};

export async function search(adapter, query, opts = {}) {
  const { k, pool, rerankPool, perPage } = { ...DEFAULTS, ...opts };
  const kinds = cleanKinds(opts.kinds);
  const useRerank = opts.rerank !== false && typeof adapter.rerank === "function";
  const useDense = opts.dense !== false && typeof adapter.embed === "function";
  const t0 = Date.now();
  const expanded = expandQuery(query);
  const match = ftsQuery(expanded);
  // Vector search needs a query embedding, which fails once Workers AI's daily allowance is used up.
  // Keyword search needs only the database, so the results degrade instead of disappearing.
  let degraded;
  const [lexical, dense] = await Promise.all([
    match ? adapter.lexical(match, pool, kinds) : [],
    useDense
      ? adapter.embed(expanded).then((v) => adapter.dense(v, pool, kinds)).catch((e) => {
          if (!match) throw e;
          degraded = `keyword results only: vector search failed (${String(e.message || e).slice(0, 200)})`;
          return [];
        })
      : [],
  ]);
  const t1 = Date.now();
  const fused = rrf([lexical.map((r) => [r.id, r.score]), dense.map((r) => [r.id, r.score])]).slice(0, rerankPool);
  const rows = new Map((await adapter.chunksByIds(fused)).map((r) => [r.id, r]));
  let ranked = fused.filter((id) => rows.has(id)).map((id, i) => ({ row: rows.get(id), score: 1 / (60 + i + 1) }));
  if (useRerank && ranked.length) {
    // The cross-encoder reads the student's own question; the synonym list is for the retrievers.
    const scored = await adapter.rerank(query, ranked.map(({ row }) => `${row.title} | ${row.section}\n${row.text}`));
    ranked = scored.map((s) => ({ row: ranked[s.index].row, score: s.score }));
  }
  const perPageCount = new Map();
  const results = [];
  for (const r of ranked) {
    const n = perPageCount.get(r.row.page_id) || 0;
    if (n >= perPage) continue;
    perPageCount.set(r.row.page_id, n + 1);
    results.push(formatHit(r.row, r.score));
    if (results.length >= k) break;
  }
  return {
    query,
    expanded: expanded !== query ? expanded : undefined,
    kinds,
    reranked: useRerank,
    ...(degraded && { degraded }),
    results,
    candidates: { lexical: lexical.length, dense: dense.length, fused: fused.length },
    timings: { retrieveMs: t1 - t0, totalMs: Date.now() - t0 },
  };
}

// The chunk plus `around` neighbours on each side, in page order, for reading a section in full.
export async function getSection(adapter, id, around = 1) {
  const rows = await adapter.sectionOf(id, Math.max(0, Math.min(5, Number(around) || 0)));
  if (!rows.length) return null;
  const { title, page_url, publisher, authority, kind, number, revised, fetched_at } = rows[0];
  return { id, title, page_url, publisher, authority, kind, number, revised, fetched_at, chunks: rows.map((r) => ({ ...formatHit(r, 0), score: undefined, requested: r.id === id || undefined })) };
}

export async function catalog(adapter, kinds) {
  return adapter.catalog(cleanKinds(kinds));
}

// Plain-text rendering for an agent's context window.
export function renderResults({ results, degraded }) {
  if (!results.length) return "No indexed Laurier policy section matches this query.";
  return (degraded ? `Note: ${degraded}\n\n` : "") + results
    .map((h, i) => `[${i + 1}] ${h.citation}\n(${h.publisher}; ${authorityLabel(h.authority)}${h.revised ? `, last revised ${h.revised}` : ""})\nURL: ${h.url}\nid: ${h.id}\n${h.text}`)
    .join("\n\n");
}
