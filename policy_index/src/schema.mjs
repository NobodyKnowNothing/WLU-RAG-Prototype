// One schema for both stores: a local SQLite file (node:sqlite) and Cloudflare D1, which is SQLite
// with FTS5. The SQL here runs unchanged on both, so the local store tests the D1 queries too.
// Vectors live in the `embedding` column locally and in Vectorize on Cloudflare.

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS pages (
    page_id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    publisher TEXT, authority TEXT, kind TEXT, number TEXT,
    approved TEXT, revised TEXT, office TEXT, lastmod TEXT, origin TEXT,
    content_hash TEXT, chunk_count INTEGER,
    fetched_at TEXT, changed_at TEXT, checked_at TEXT, error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    page_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    title TEXT NOT NULL,
    section TEXT NOT NULL,
    heading TEXT, anchor TEXT, clauses TEXT,
    part INTEGER, parts INTEGER,
    url TEXT NOT NULL,
    text TEXT NOT NULL,
    hash TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    embedding BLOB,
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS chunks_page ON chunks(page_id, ordinal)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(title, section, text, content='chunks', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2')`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, title, section, text) VALUES (new.rowid, new.title, new.section, new.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, title, section, text) VALUES ('delete', old.rowid, old.title, old.section, old.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF title, section, text ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, title, section, text) VALUES ('delete', old.rowid, old.title, old.section, old.text);
    INSERT INTO chunks_fts(rowid, title, section, text) VALUES (new.rowid, new.title, new.section, new.text);
  END`,
];

export const PAGE_COLUMNS = ["page_id", "url", "title", "publisher", "authority", "kind", "number", "approved", "revised", "office", "lastmod", "origin", "content_hash", "chunk_count", "fetched_at", "changed_at", "checked_at", "error"];
export const CHUNK_COLUMNS = ["id", "page_id", "ordinal", "title", "section", "heading", "anchor", "clauses", "part", "parts", "url", "text", "hash", "row_hash", "updated_at"];

const upsert = (table, cols, key) =>
  `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")}) ON CONFLICT(${key}) DO UPDATE SET ${cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(", ")}`;

export const SQL = {
  upsertPage: upsert("pages", PAGE_COLUMNS, "page_id"),
  upsertChunk: upsert("chunks", CHUNK_COLUMNS, "id"),
  setEmbedding: `UPDATE chunks SET embedding = ?2 WHERE id = ?1`,
  deleteChunk: `DELETE FROM chunks WHERE id = ?1`,
  deletePageChunks: `DELETE FROM chunks WHERE page_id = ?1`,
  deletePage: `DELETE FROM pages WHERE page_id = ?1`,
  touchPage: `UPDATE pages SET checked_at = ?2, lastmod = COALESCE(?3, lastmod), error = ?4 WHERE page_id = ?1`,
  listPages: `SELECT ${PAGE_COLUMNS.join(", ")} FROM pages ORDER BY url`,
  chunkState: `SELECT id, hash, row_hash, section, clauses FROM chunks WHERE page_id = ?1`,
  getMeta: `SELECT value FROM meta WHERE key = ?1`,
  setMeta: `INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  stats: `SELECT (SELECT COUNT(*) FROM pages) AS pages, (SELECT COUNT(*) FROM chunks) AS chunks, (SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL) AS embedded, (SELECT SUM(LENGTH(text)) FROM chunks) AS chars`,

  // Search. Keyword hits are ranked by FTS5's BM25 with the page title and section path weighted
  // above the body; ?3 is a JSON array of page kinds to keep, or NULL for all.
  lexical: `SELECT c.id AS id, bm25(chunks_fts, 3.0, 2.0, 1.0) AS score
    FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid JOIN pages p ON p.page_id = c.page_id
    WHERE chunks_fts MATCH ?1 AND (?3 IS NULL OR p.kind IN (SELECT value FROM json_each(?3)))
    ORDER BY score LIMIT ?2`,
  // ?1 is a JSON array of chunk ids (json_each keeps this under D1's 100-parameter limit).
  chunksByIds: `SELECT c.id, c.page_id, c.ordinal, c.section, c.heading, c.anchor, c.clauses, c.part, c.parts, c.url, c.text,
      p.title, p.url AS page_url, p.publisher, p.authority, p.kind, p.number, p.revised, p.fetched_at, p.changed_at
    FROM chunks c JOIN pages p ON p.page_id = c.page_id WHERE c.id IN (SELECT value FROM json_each(?1))`,
  sectionOf: `SELECT c.id, c.page_id, c.ordinal, c.section, c.heading, c.anchor, c.clauses, c.part, c.parts, c.url, c.text,
      p.title, p.url AS page_url, p.publisher, p.authority, p.kind, p.number, p.revised, p.fetched_at, p.changed_at
    FROM chunks c JOIN pages p ON p.page_id = c.page_id
    WHERE c.page_id = (SELECT page_id FROM chunks WHERE id = ?1) AND c.ordinal BETWEEN
      (SELECT ordinal FROM chunks WHERE id = ?1) - ?2 AND (SELECT ordinal FROM chunks WHERE id = ?1) + ?2
    ORDER BY c.ordinal`,
  catalog: `SELECT p.page_id, p.title, p.url, p.publisher, p.authority, p.kind, p.number, p.revised, p.chunk_count
    FROM pages p WHERE (?1 IS NULL OR p.kind IN (SELECT value FROM json_each(?1))) ORDER BY p.kind, p.url`,
};
