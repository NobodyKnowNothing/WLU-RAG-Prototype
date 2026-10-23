import chunks from "./chunks.json";
import vectors from "./vectors.json"; // precomputed by scripts/embed_chunks.py

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TOP_K = 150;
const RERANK_TOP_N = 5;
const RRF_K = 60;

const SYSTEM_PROMPT =
  "You are a scholarly assistant. Answer the user's question using ONLY the provided context. " +
  "You MUST cite the source document and page number inline for every factual claim you make " +
  "(e.g., [Cite: PC141labRules.pdf, Page: 2]). If the answer is not in the context, state that you do not know.";

const tokenize = (s) => s.toLowerCase().match(/\w+/g) || [];

// BM25 (Okapi) over the enriched chunk text, built once per isolate.
const docTokens = chunks.map((c) => tokenize(c.enriched));
const avgLen = docTokens.reduce((n, t) => n + t.length, 0) / docTokens.length;
const df = new Map();
for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);

function bm25Scores(query, k1 = 1.5, b = 0.75) {
  const q = tokenize(query);
  return docTokens.map((toks) => {
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t);
      const idf = Math.log((chunks.length - n + 0.5) / (n + 0.5) + 1);
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avgLen));
    }
    return score;
  });
}

const stage = (name, p) => Promise.resolve(p).catch((e) => { throw new Error(`${name}: ${e.message || e}`); });

const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));

async function retrieve(env, query) {
  const qres = await stage("embed query", env.AI.run(EMBED_MODEL, { text: [query] }));
  const qv = qres.data[0];
  const qn = norm(qv);
  const dense = vectors.map((v, i) => [i, dot(qv, v) / (qn * norm(v))]).sort((a, b) => b[1] - a[1]).slice(0, TOP_K);
  const sparseScores = bm25Scores(query);
  const sparse = sparseScores
    .map((s, i) => [i, s])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_K);

  const fused = new Map();
  for (const ranked of [dense, sparse]) {
    ranked.forEach(([i], rank) => fused.set(i, (fused.get(i) || 0) + 1 / (RRF_K + rank + 1)));
  }
  return [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_K).map(([i]) => chunks[i]);
}

async function rerank(env, query, docs) {
  const res = await stage("rerank", env.AI.run(RERANK_MODEL, { query, contexts: docs.map((d) => ({ text: d.text })), top_k: RERANK_TOP_N }));
  return res.response
    .sort((a, b) => b.score - a.score)
    .slice(0, RERANK_TOP_N)
    .map((r) => ({ ...docs[r.id], score: r.score }));
}

async function answer(env, query) {
  const docs = await rerank(env, query, await retrieve(env, query));
  const context = docs.map((d) => `[Source: ${d.source}, Page: ${d.page}]\n${d.text}`).join("\n\n");
  const res = await stage("generate", env.AI.run(LLM_MODEL, {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  }));
  const text = res.response ?? res.choices?.[0]?.message?.content ?? "";
  return {
    answer: text.trim(),
    sources: docs.map((d) => ({ source: d.source, page: d.page, text: d.text, score: d.score })),
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = [env.ALLOWED_ORIGIN, "http://localhost:8000", "http://127.0.0.1:8000"];
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "POST a JSON body: {\"question\": \"...\"}" }, 405);
    if (origin && !allowed.includes(origin)) return json({ error: "Origin not allowed" }, 403);

    let question;
    try {
      ({ question } = await request.json());
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (typeof question !== "string" || !question.trim() || question.length > 500) {
      return json({ error: "question must be a non-empty string under 500 characters" }, 400);
    }

    try {
      return json(await answer(env, question.trim()));
    } catch (e) {
      return json({ error: "Upstream model error", detail: String(e.message || e) }, 502);
    }
  },
};
