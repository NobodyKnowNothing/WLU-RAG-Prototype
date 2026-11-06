// The search adapter (see search.mjs) over Cloudflare bindings: D1 for rows and FTS5, Vectorize for
// vectors, Workers AI for query embeddings and (optionally) reranking. Used by the standalone search
// Worker (cloudflare/worker.js) and by the PC141 assistant Worker (worker/src/index.js).
import { SQL } from "./schema.mjs";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"; // must match embed.mjs (mean pooling, the default)
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

export function cloudflareAdapter({ db, vectorize, ai, rerank = false }) {
  const all = async (sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
  const kindsJson = (kinds) => (kinds ? JSON.stringify(kinds) : null);
  return {
    lexical: async (match, limit, kinds) => (await all(SQL.lexical, match, limit, kindsJson(kinds))).map((r) => ({ id: r.id, score: -r.score })),
    embed: async (text) => (await ai.run(EMBED_MODEL, { text: [text] })).data[0],
    dense: async (vector, limit, kinds) => {
      const res = await vectorize.query(vector, { topK: Math.min(limit, 100), ...(kinds && { filter: { kind: { $in: kinds } } }) });
      return res.matches.map((m) => ({ id: m.id, score: m.score }));
    },
    ...(rerank && {
      rerank: async (query, texts) => {
        const res = await ai.run(RERANK_MODEL, { query, contexts: texts.map((text) => ({ text })), top_k: texts.length });
        return res.response.map((r) => ({ index: r.id, score: r.score })).sort((a, b) => b.score - a.score);
      },
    }),
    chunksByIds: async (ids) => (ids.length ? all(SQL.chunksByIds, JSON.stringify(ids)) : []),
    sectionOf: (id, around) => all(SQL.sectionOf, id, around),
    catalog: (kinds) => all(SQL.catalog, kindsJson(kinds)),
    stats: async () => {
      const s = await db.prepare(SQL.stats).first();
      const last = await db.prepare(SQL.getMeta).bind("last_sync").first();
      return { pages: s.pages, chunks: s.chunks, last_sync: last?.value ?? null };
    },
  };
}
