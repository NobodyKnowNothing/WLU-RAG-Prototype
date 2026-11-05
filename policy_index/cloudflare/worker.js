// Policy search on Cloudflare's free plan: D1 (rows + FTS5 keyword index), Vectorize (vectors),
// Workers AI (query embedding and reranking). Same routes and MCP tools as src/server.mjs; the
// index is filled by `node src/cli.mjs sync --store cloudflare` (weekly, from GitHub Actions).
//
// Per search: 1 embedding call, 1 Vectorize query, 2 D1 queries (and 1 rerank call if RERANK is
// "on"). No page fetching or HTML parsing, so it stays inside the free plan's 50 subrequests and
// does little CPU work of its own.
import { catalog, getSection, search } from "../src/search.mjs";
import { SQL } from "../src/schema.mjs";
import { mcpHttp } from "../src/tool.mjs";

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"; // must match src/embed.mjs (mean pooling, the default)
const RERANK_MODEL = "@cf/baai/bge-reranker-base";

export function cloudflareAdapter(env) {
  const all = async (sql, ...params) => (await env.DB.prepare(sql).bind(...params).all()).results;
  const kindsJson = (kinds) => (kinds ? JSON.stringify(kinds) : null);
  return {
    lexical: async (match, limit, kinds) => (await all(SQL.lexical, match, limit, kindsJson(kinds))).map((r) => ({ id: r.id, score: -r.score })),
    embed: async (text) => (await env.AI.run(EMBED_MODEL, { text: [text] })).data[0],
    dense: async (vector, limit, kinds) => {
      const res = await env.VECTORIZE.query(vector, { topK: Math.min(limit, 100), ...(kinds && { filter: { kind: { $in: kinds } } }) });
      return res.matches.map((m) => ({ id: m.id, score: m.score }));
    },
    // Off unless RERANK = "on": on the eval questions hybrid retrieval alone ranked the expected page
    // first 17/17 times, and the cross-encoder 14/17 (results/policy_index_eval.json).
    ...(env.RERANK === "on" && {
      rerank: async (query, texts) => {
        const res = await env.AI.run(RERANK_MODEL, { query, contexts: texts.map((text) => ({ text })), top_k: texts.length });
        return res.response.map((r) => ({ index: r.id, score: r.score })).sort((a, b) => b.score - a.score);
      },
    }),
    chunksByIds: async (ids) => (ids.length ? all(SQL.chunksByIds, JSON.stringify(ids)) : []),
    sectionOf: (id, around) => all(SQL.sectionOf, id, around),
    catalog: (kinds) => all(SQL.catalog, kindsJson(kinds)),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
    const cors = origin && allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" } : {};
    const json = (body, status = 200, extra = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { ...cors, ...extra, ...(body !== null && { "Content-Type": "application/json" }) } });
    if (request.method === "OPTIONS") return json(null, 204);
    const adapter = cloudflareAdapter(env);
    try {
      if (url.pathname === "/health") {
        const s = await env.DB.prepare(SQL.stats).first();
        const last = await env.DB.prepare(SQL.getMeta).bind("last_sync").first();
        return json({ ok: true, pages: s.pages, chunks: s.chunks, last_sync: last?.value ?? null });
      }
      if (env.API_TOKEN && request.headers.get("Authorization") !== `Bearer ${env.API_TOKEN}`) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/mcp") {
        const r = await mcpHttp(adapter, request.method, request.method === "POST" ? await request.text() : "");
        return json(r.body, r.status, r.headers);
      }
      if (url.pathname === "/search" && request.method === "POST") {
        const q = await request.json().catch(() => null);
        if (typeof q?.query !== "string" || !q.query.trim() || q.query.length > 500) return json({ error: "query must be a non-empty string under 500 characters" }, 400);
        return json(await search(adapter, q.query.trim(), { k: Math.max(1, Math.min(20, Number(q.k) || 5)), kinds: q.kinds, rerank: q.rerank }));
      }
      const m = url.pathname.match(/^\/section\/([\w-]+)$/);
      if (m && request.method === "GET") {
        const s = await getSection(adapter, m[1], url.searchParams.get("around") ?? 1);
        return s ? json(s) : json({ error: "no such section" }, 404);
      }
      if (url.pathname === "/policies" && request.method === "GET") return json({ pages: await catalog(adapter, url.searchParams.get("kinds")) });
      return json({ error: "routes: GET /health, POST /search, GET /section/:id, GET /policies, POST /mcp" }, 404);
    } catch (e) {
      const detail = String(e.message || e);
      if (/\b4006\b|daily free allocation/.test(detail)) return json({ error: "daily_limit", detail }, 429);
      return json({ error: "search failed", detail }, 502);
    }
  },
};
