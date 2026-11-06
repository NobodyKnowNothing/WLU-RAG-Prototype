// Answer cache: the same question (same mode, scope and sections) gets the stored answer instead
// of new embedding, rerank and LLM calls. Two tiers: a small in-memory map per isolate, and a D1
// table shared by every isolate and data centre. (The Cache API is per data centre and does not
// store anything on workers.dev, which is where this Worker runs.) Every cache error is ignored:
// a broken cache only costs the calls it would have saved.

// Bump when retrieval, the prompt or the answer format changes, so old answers stop being served.
export const CACHE_VERSION = 1;
export const TTL_S = 24 * 3600; // course documents are fixed; the policy index re-syncs weekly
export const SHORT_TTL_S = 2 * 3600; // degraded answers: replaced by a full one once AI is back
const MEMORY_MAX = 200;

// Case, spacing and trailing punctuation don't change the answer.
export const normalizeQuestion = (q) =>
  String(q).normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").replace(/[\s?.!]+$/, "").trim();

export async function cacheKey({ question, mode, scope, sections = {} }) {
  const raw = JSON.stringify([CACHE_VERSION, normalizeQuestion(question), mode, scope, sections.lab || "", sections.tutorial || ""]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const memory = new Map(); // key -> { value, expires }, oldest first
export const clearMemory = () => memory.clear();

const SCHEMA = `CREATE TABLE IF NOT EXISTS answer_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)`;
const ready = new WeakMap(); // db -> promise of the table existing
const table = (db) => ready.get(db) || ready.set(db, db.prepare(SCHEMA).run().catch((e) => (ready.delete(db), Promise.reject(e)))).get(db);

export function answerCache(db, { now = () => Date.now() } = {}) {
  const remember = (key, value, expires) => {
    memory.delete(key);
    memory.set(key, { value, expires });
    while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
  };
  return {
    async get(key) {
      const m = memory.get(key);
      if (m && m.expires > now()) return m.value;
      if (m) memory.delete(key);
      if (!db) return null;
      try {
        await table(db);
        const row = await db.prepare("SELECT value, expires FROM answer_cache WHERE key = ? AND expires > ?").bind(key, now()).first();
        if (!row) return null;
        const value = JSON.parse(row.value);
        remember(key, value, row.expires);
        return value;
      } catch {
        return null;
      }
    },
    async put(key, value, ttlS = TTL_S) {
      const t = now();
      const expires = t + ttlS * 1000;
      remember(key, value, expires);
      if (!db) return;
      try {
        await table(db);
        await db.prepare("INSERT OR REPLACE INTO answer_cache (key, value, created, expires) VALUES (?, ?, ?, ?)").bind(key, JSON.stringify(value), t, expires).run();
        if (Math.random() < 0.05) await db.prepare("DELETE FROM answer_cache WHERE expires <= ?").bind(t).run(); // prune now and then
      } catch {}
    },
  };
}
