// Cloudflare store for the weekly sync, over the REST API (so it runs from GitHub Actions or a
// laptop): D1 holds pages, chunks and the FTS5 keyword index (the same schema and SQL as the local
// store), Vectorize holds the vectors. The Worker in cloudflare/ reads both through bindings.
//
// Writes go to Vectorize first and D1 second. D1 is what the sync compares against, so if a run
// dies between the two, the next run sees the chunks as unchanged-in-D1-but-new and redoes them.
// A vector whose D1 row is gone is dropped at query time (chunksByIds finds no row for it).
import { CHUNK_COLUMNS, PAGE_COLUMNS, SCHEMA, SQL } from "./schema.mjs";

const API = "https://api.cloudflare.com/client/v4";
const D1_BATCH = 40; // statements per request

export function cloudflareStore({ accountId, apiToken, databaseId, indexName, fetchImpl = fetch } = {}) {
  for (const [k, v] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken, D1_DATABASE_ID: databaseId, VECTORIZE_INDEX: indexName })) {
    if (!v) throw new Error(`cloudflare store needs ${k}`);
  }
  const auth = { Authorization: `Bearer ${apiToken}` };

  async function call(path, init) {
    const res = await fetchImpl(`${API}/accounts/${accountId}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) throw new Error(`Cloudflare API ${path}: HTTP ${res.status} ${JSON.stringify(body.errors || body).slice(0, 400)}`);
    return body.result;
  }

  // [{ sql, params }] -> results of each statement, D1_BATCH statements per request.
  async function d1(statements) {
    const out = [];
    for (let i = 0; i < statements.length; i += D1_BATCH) {
      const batch = statements.slice(i, i + D1_BATCH).map(({ sql, params = [] }) => ({ sql, params }));
      const result = await call(`/d1/database/${databaseId}/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch }) });
      out.push(...result.map((r) => r.results || []));
    }
    return out;
  }
  const one = async (sql, params = []) => (await d1([{ sql, params }]))[0];

  const vectorize = {
    async upsert(vectors) {
      for (let i = 0; i < vectors.length; i += 1000) {
        const ndjson = vectors.slice(i, i + 1000).map((v) => JSON.stringify(v)).join("\n");
        const form = new FormData();
        form.append("vectors", new Blob([ndjson], { type: "application/x-ndjson" }), "vectors.ndjson");
        await call(`/vectorize/v2/indexes/${indexName}/upsert`, { method: "POST", body: form });
      }
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += 1000) {
        await call(`/vectorize/v2/indexes/${indexName}/delete_by_ids`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.slice(i, i + 1000) }) });
      }
    },
    info: () => call(`/vectorize/v2/indexes/${indexName}/info`, { method: "GET" }),
  };

  return {
    kind: "cloudflare",
    vectorize,
    d1,
    async init() {
      await d1(SCHEMA.map((sql) => ({ sql })));
      return vectorize.info();
    },
    async getMeta(key) {
      return (await one(SQL.getMeta, [key]))[0]?.value ?? null;
    },
    async setMeta(key, value) {
      await one(SQL.setMeta, [key, String(value)]);
    },
    listPages: () => one(SQL.listPages),
    async chunkState(pageId) {
      return new Map((await one(SQL.chunkState, [pageId])).map((r) => [r.id, r]));
    },
    async applyPage(page, rows, vectors, deleteIds) {
      if (vectors.size) {
        await vectorize.upsert([...vectors].map(([id, v]) => ({ id, values: Array.from(v, (x) => Math.round(x * 1e7) / 1e7), metadata: { page_id: page.page_id, kind: page.kind } })));
      }
      if (deleteIds.length) await vectorize.deleteByIds(deleteIds);
      await d1([
        ...deleteIds.map((id) => ({ sql: SQL.deleteChunk, params: [id] })),
        { sql: SQL.upsertPage, params: PAGE_COLUMNS.map((c) => page[c] ?? null) },
        ...rows.map((r) => ({ sql: SQL.upsertChunk, params: CHUNK_COLUMNS.map((c) => r[c] ?? null) })),
        { sql: SQL.setMeta, params: ["index_version", String(Date.now())] },
      ]);
    },
    async deletePage(pageId) {
      const ids = (await one(SQL.chunkState, [pageId])).map((r) => r.id);
      if (ids.length) await vectorize.deleteByIds(ids);
      await d1([{ sql: SQL.deletePageChunks, params: [pageId] }, { sql: SQL.deletePage, params: [pageId] }]);
      return ids;
    },
    async touchPage(pageId, checkedAt, lastmod, error = null) {
      await one(SQL.touchPage, [pageId, checkedAt, lastmod ?? null, error]);
    },
    async stats() {
      const [row] = await one(SQL.stats);
      const info = await vectorize.info().catch((e) => ({ error: String(e.message || e) }));
      return { ...row, embedded: info.vectorCount ?? row.embedded, vectorize: info };
    },
  };
}

export function cloudflareStoreFromEnv(env = process.env) {
  return cloudflareStore({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, databaseId: env.D1_DATABASE_ID, indexName: env.VECTORIZE_INDEX || "wlu-policies" });
}
