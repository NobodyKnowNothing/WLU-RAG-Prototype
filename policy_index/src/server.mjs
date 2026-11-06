// Self-hosted search API and MCP endpoint over the local SQLite index (for Hugging Face Spaces,
// Render, Cloud Run, a VM or a laptop). The Cloudflare Worker in cloudflare/ serves the same routes.
//
//   GET  /health                 index size and last sync
//   POST /search                 {"query", "k"?, "kinds"?, "rerank"?} -> ranked sections
//   GET  /section/:id?around=1   a section with its neighbours
//   GET  /policies?kinds=...     every indexed page
//   POST /mcp                    MCP (Streamable HTTP, stateless) with the three tools in tool.mjs
//
// Set API_TOKEN to require "Authorization: Bearer <token>" on everything except /health, and
// ALLOWED_ORIGINS (comma-separated) for browser access.
import { createServer } from "node:http";
import { catalog, getSection, search } from "./search.mjs";
import { mcpHttp } from "./tool.mjs";

export function localAdapter({ store, embedder, reranker }) {
  return {
    lexical: store.lexical,
    dense: store.dense,
    chunksByIds: store.chunksByIds,
    sectionOf: store.sectionOf,
    catalog: store.catalog,
    ...(embedder && { embed: async (text) => (await embedder.embed([text]))[0] }),
    ...(reranker && { rerank: (q, texts) => reranker.rerank(q, texts) }),
  };
}

export function createApp({ store, adapter, apiToken = process.env.API_TOKEN, allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean), onSync }) {
  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const origin = req.headers.origin;
    const cors = origin && allowedOrigins.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" } : {};
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...cors, ...extra, ...(body !== null && { "Content-Type": "application/json" }) });
      res.end(body === null ? undefined : JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") return send(204, null);
      if (url.pathname === "/health") return send(200, { ok: true, ...(await store.stats()), last_sync: await store.getMeta("last_sync") });
      if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) return send(401, { error: "unauthorized" });
      const body = req.method === "POST" ? await readBody(req) : "";
      if (url.pathname === "/mcp") {
        const r = await mcpHttp(adapter, req.method, body);
        return send(r.status, r.body, r.headers);
      }
      if (url.pathname === "/search" && req.method === "POST") {
        let q;
        try {
          q = JSON.parse(body || "{}");
        } catch {
          return send(400, { error: "invalid JSON" });
        }
        if (typeof q.query !== "string" || !q.query.trim() || q.query.length > 500) return send(400, { error: "query must be a non-empty string under 500 characters" });
        return send(200, await search(adapter, q.query.trim(), { k: Math.max(1, Math.min(20, Number(q.k) || 5)), kinds: q.kinds, rerank: q.rerank }));
      }
      const m = url.pathname.match(/^\/section\/([\w-]+)$/);
      if (m && req.method === "GET") {
        const s = await getSection(adapter, m[1], url.searchParams.get("around") ?? 1);
        return s ? send(200, s) : send(404, { error: "no such section" });
      }
      if (url.pathname === "/policies" && req.method === "GET") return send(200, { pages: await catalog(adapter, url.searchParams.get("kinds")) });
      if (url.pathname === "/sync" && req.method === "POST" && onSync) return send(202, { started: true, ...(await onSync()) });
      return send(404, { error: "routes: GET /health, POST /search, GET /section/:id, GET /policies, POST /mcp" });
    } catch (e) {
      console.error(e);
      return send(500, { error: String(e.message || e) });
    }
  };
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

export function serve(opts, port = 8790, host = "127.0.0.1") {
  const server = createServer(createApp(opts));
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
