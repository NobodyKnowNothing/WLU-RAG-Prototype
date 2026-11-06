// Local store: one SQLite file (node:sqlite, no native addon) holding pages, chunks, the FTS5
// keyword index and the vectors. Vector search is brute force over all vectors held in memory:
// a few thousand 384-dim vectors take a couple of milliseconds.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CHUNK_COLUMNS, PAGE_COLUMNS, SCHEMA, SQL } from "./schema.mjs";
import { dot, fromBlob, toBlob } from "./embed.mjs";

export function sqliteStore(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path); // default rollback journal: the index stays one self-contained file
  for (const s of SCHEMA) db.exec(s);
  const stmt = new Map();
  const q = (sql) => stmt.get(sql) || stmt.set(sql, db.prepare(sql)).get(sql);
  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  let matrix = null; // { version, ids, vecs: Float32Array (n * dims), dims }
  const bump = () => q(SQL.setMeta).run("index_version", String(Date.now() + Math.random()));

  const store = {
    kind: "sqlite",
    path,
    db,
    async init() {},
    async getMeta(key) {
      return q(SQL.getMeta).get(key)?.value ?? null;
    },
    async setMeta(key, value) {
      q(SQL.setMeta).run(key, String(value));
    },
    async listPages() {
      return q(SQL.listPages).all();
    },
    async chunkState(pageId) {
      return new Map(q(SQL.chunkState).all(pageId).map((r) => [r.id, r]));
    },
    // Writes one page: its record, the chunk rows that changed, new vectors and deletions.
    async applyPage(page, rows, vectors, deleteIds) {
      tx(() => {
        for (const id of deleteIds) q(SQL.deleteChunk).run(id);
        q(SQL.upsertPage).run(...PAGE_COLUMNS.map((c) => page[c] ?? null));
        for (const r of rows) q(SQL.upsertChunk).run(...CHUNK_COLUMNS.map((c) => r[c] ?? null));
        for (const [id, v] of vectors) q(SQL.setEmbedding).run(id, toBlob(v));
        bump();
      });
    },
    async deletePage(pageId) {
      return tx(() => {
        const ids = q(SQL.chunkState).all(pageId).map((r) => r.id);
        q(SQL.deletePageChunks).run(pageId);
        q(SQL.deletePage).run(pageId);
        bump();
        return ids;
      });
    },
    async touchPage(pageId, checkedAt, lastmod, error = null) {
      q(SQL.touchPage).run(pageId, checkedAt, lastmod ?? null, error);
    },
    async stats() {
      return { ...q(SQL.stats).get(), version: await store.getMeta("index_version") };
    },

    // ---- search adapter (see search.mjs) ----
    async lexical(match, limit, kinds) {
      return q(SQL.lexical).all(match, limit, kinds ? JSON.stringify(kinds) : null).map((r) => ({ id: r.id, score: -r.score }));
    },
    async dense(vector, limit, kinds) {
      const m = loadMatrix();
      const allowed = kinds ? new Set(q(`SELECT c.id FROM chunks c JOIN pages p USING (page_id) WHERE p.kind IN (SELECT value FROM json_each(?1))`).all(JSON.stringify(kinds)).map((r) => r.id)) : null;
      const scores = [];
      for (let i = 0; i < m.ids.length; i++) {
        if (allowed && !allowed.has(m.ids[i])) continue;
        scores.push({ id: m.ids[i], score: dot(vector, m.vecs.subarray(i * m.dims, (i + 1) * m.dims)) });
      }
      return scores.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    async chunksByIds(ids) {
      return ids.length ? q(SQL.chunksByIds).all(JSON.stringify(ids)) : [];
    },
    async sectionOf(id, around) {
      return q(SQL.sectionOf).all(id, around);
    },
    async catalog(kinds) {
      return q(SQL.catalog).all(kinds ? JSON.stringify(kinds) : null);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };

  function loadMatrix() {
    const version = q(SQL.getMeta).get("index_version")?.value ?? "0";
    if (matrix?.version === version) return matrix;
    const rows = q(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY rowid`).all();
    const dims = rows.length ? rows[0].embedding.byteLength / 4 : 0;
    const vecs = new Float32Array(rows.length * dims);
    rows.forEach((r, i) => vecs.set(fromBlob(r.embedding), i * dims));
    matrix = { version, ids: rows.map((r) => r.id), vecs, dims };
    return matrix;
  }

  return store;
}
