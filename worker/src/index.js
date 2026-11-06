import chunks from "./chunks.json"; // built by scripts/export_chunks.py
import vectors from "./vectors.json"; // precomputed by scripts/embed_chunks.py
import { cloudflareAdapter } from "../../policy_index/src/cloudflare-adapter.mjs";
import { search as searchPolicyIndex } from "../../policy_index/src/search.mjs";
import { mcpHttp } from "../../policy_index/src/tool.mjs";
import { SYSTEM_PROMPT, answerText, buildUserMessage, verifyAnswer } from "./answer.js";
import { SHORT_TTL_S, TTL_S, answerCache, cacheKey } from "./cache.js";
import { complete, isQuotaError, markWorkersAiOut, skipWorkersAi } from "./llm.js";
import { CATALOG, searchLaurier } from "./laurier.js";
import { BM25, cosine, expandQuery, rrf } from "./retrieval.js";

// The Laurier policy index (policy_index/), when its D1 database and Vectorize index are bound.
const policyIndex = (env) => (env.POLICY_DB && env.POLICY_INDEX ? cloudflareAdapter({ db: env.POLICY_DB, vectorize: env.POLICY_INDEX, ai: env.AI }) : null);

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const TOP_K = 150;
const PC141_TOP_N = 5;
const LAURIER_TOP_N = 3;
const MODES = ["simple", "full"];
const SCOPES = ["both", "pc141", "laurier"];

const courseIndex = new BM25(chunks.map((c) => c.enriched));
const hasVectors = vectors.length === chunks.length; // stale vectors.json: fall back to lexical search

// Section codes that appear in the course documents, e.g. "PC141–L04" -> lab "L04".
const SECTION_CODES = { lab: new Set(), tutorial: new Set() };
for (const c of chunks) for (const [, k] of c.text.matchAll(/PC141\s*[–-]\s*([LT]\d{2})/g)) SECTION_CODES[k[0] === "L" ? "lab" : "tutorial"].add(k);

const stage = (name, p) => Promise.resolve(p).catch((e) => { throw new Error(`${name}: ${e.message || e}`); });

// Cross-encoder scores for `texts`, best first: [{ index, score }].
async function rerank(env, query, texts) {
  if (!texts.length) return [];
  const res = await stage("rerank", env.AI.run(RERANK_MODEL, { query, contexts: texts.map((text) => ({ text })), top_k: texts.length }));
  return res.response.map((r) => ({ index: r.id, score: r.score })).sort((a, b) => b.score - a.score);
}

// An announcement's opening text ("Labs are held on alternate weeks in Room N2089") is context for
// every subsection under it, so the best-ranked subsection carries it as `intro`.
const parentOf = new Map();
for (const c of chunks) {
  const [top, ...rest] = c.section.split(" > ");
  const parent = rest.length && chunks.find((p) => p.source === c.source && p.section === top);
  if (parent) parentOf.set(c.id, parent);
}
function withParents(found) {
  const seen = new Set(found.map((c) => c.id));
  return found.map((c) => {
    const p = parentOf.get(c.id);
    if (!p || seen.has(p.id)) return c;
    seen.add(p.id);
    return { ...c, intro: p.text };
  });
}

async function searchCourse(env, query, mode) {
  return withParents(await rankCourse(env, query, mode));
}

async function rankCourse(env, query, mode) {
  if (mode === "simple") return courseIndex.rank(query, PC141_TOP_N).map(([i, score]) => ({ ...chunks[i], score }));
  const lists = [courseIndex.rank(query, TOP_K)];
  if (hasVectors) {
    const qv = (await stage("embed query", env.AI.run(EMBED_MODEL, { text: [query] }))).data[0];
    lists.push(vectors.map((v, i) => [i, cosine(qv, v)]).sort((a, b) => b[1] - a[1]).slice(0, TOP_K));
  }
  const pool = rrf(lists).slice(0, TOP_K);
  // Cross-encoder scores are well ordered but poorly calibrated on these short admin texts (the
  // right section can score 0.003), so keep the top few by rank and let the model skip the rest.
  const scored = await rerank(env, query, pool.map((i) => chunks[i].enriched));
  return scored.slice(0, PC141_TOP_N).map((r) => ({ ...chunks[pool[r.index]], score: r.score }));
}

async function retrieve(env, ctx, { question, mode, scope, sections }) {
  // Section codes help the lexical search find the right schedule row.
  const query = expandQuery([question, sections.lab && `PC141-${sections.lab}`, sections.tutorial && `PC141-${sections.tutorial}`].filter(Boolean).join(" "));
  const [course, laurier] = await Promise.all([
    scope === "laurier" ? [] : searchCourse(env, query, mode),
    scope === "pc141" ? { sources: [], pages: [], links: [] } : searchLaurier(expandQuery(question), { question, mode, k: LAURIER_TOP_N, ctx, rerank: (q, t) => rerank(env, q, t), siteSearchOn: env.SITE_SEARCH !== "off", index: policyIndex(env) }),
  ]);
  const sources = [...course.map((c) => ({ ...c, kind: "pc141" })), ...laurier.sources].map((s, i) => ({ n: i + 1, ...s }));
  return { sources, pages: laurier.pages, links: laurier.links || [] };
}

const generate = (env, question, sources, sections) => complete(env, { system: SYSTEM_PROMPT, user: buildUserMessage(question, sources, sections) });

const publicSource = ({ n, kind, title, section, pages, source, pageId, url, publisher, authority, revised, viaSearch, viaIndex, fetchedAt, text, intro, score }) =>
  kind === "pc141"
    ? { n, kind, title, section, pages, file: source, text, ...(intro && { intro }), score }
    : { n, kind, title, section, page: pageId, publisher, authority, ...(revised && { revised }), ...(viaSearch && { viaSearch }), ...(viaIndex && { viaIndex }), url, fetchedAt, text, score };

// Full retrieval needs Workers AI for the query embedding and the reranker. When its allowance is
// used up (and Groq can still write the answer), retrieval falls back to Simple mode's keyword search.
const DEGRADED = "Workers AI's daily allowance is used up, so this answer used keyword search (Simple retrieval)";
async function retrieveWithFallback(env, ctx, req) {
  if (req.mode === "full" && skipWorkersAi(env)) return { ...(await retrieve(env, ctx, { ...req, mode: "simple" })), degraded: DEGRADED };
  try {
    return await retrieve(env, ctx, req);
  } catch (e) {
    if (req.mode !== "full" || !isQuotaError(e) || !env.GROQ_API_KEY) throw e;
    markWorkersAiOut();
    return { ...(await retrieve(env, ctx, { ...req, mode: "simple" })), degraded: DEGRADED };
  }
}

async function answer(env, ctx, req) {
  const t0 = Date.now();
  const { sources, pages, links, degraded } = await retrieveWithFallback(env, ctx, req);
  const t1 = Date.now();
  const base = { mode: req.mode, scope: req.scope, ...(degraded && { degraded }), sources: sources.map(publicSource), laurierPages: pages, laurierLinks: links };
  if (req.retrieveOnly) return { ...base, timings: { retrieveMs: t1 - t0 } };
  // Nothing relevant anywhere: say so without asking the model to improvise.
  if (!sources.length) {
    const result = { status: "not_found", pc141: [], laurier: [], unverified: "No PC141 document or official Laurier page that was searched covers this question." };
    return { ...base, ...result, answer: answerText(result), timings: { retrieveMs: t1 - t0 } };
  }
  const gen = await stage("generate", generate(env, req.question, sources, req.sections));
  const result = verifyAnswer(gen.answer, sources);
  const llm = { provider: gen.provider, model: gen.model, ...(gen.fallback && { fallback: gen.fallback }) };
  return { ...base, ...result, answer: answerText(result), llm, timings: { retrieveMs: t1 - t0, generateMs: Date.now() - t1 }, ...(!gen.readable && { unreadable: true }) };
}

// Identical questions asked at the same time share one answer instead of each calling the models.
const inflight = new Map();

async function ask(env, ctx, req) {
  if (req.retrieveOnly) return answer(env, ctx, req); // cheap, and scripts/ai_budget.py relies on it reaching Workers AI
  const t0 = Date.now();
  const cache = answerCache(env.POLICY_DB || env.ANSWER_CACHE_DB);
  const key = await cacheKey(req);
  if (req.cache) {
    const hit = await cache.get(key);
    if (hit) return { ...hit, cached: true, timings: { cacheMs: Date.now() - t0, original: hit.timings } };
    if (inflight.has(key)) return { ...(await inflight.get(key)), shared: true };
  }
  const p = answer(env, ctx, req);
  inflight.set(key, p);
  try {
    const out = await p;
    const { unreadable, ...stored } = out;
    if (!unreadable) {
      // Answers built on degraded retrieval or with a page missing are kept briefly, so a full answer replaces them.
      const ttl = out.degraded || out.laurierPages.some((pg) => pg.error) ? SHORT_TTL_S : TTL_S;
      ctx.waitUntil(cache.put(key, { ...stored, cachedAt: new Date().toISOString() }, ttl));
    }
    return stored;
  } finally {
    inflight.delete(key);
  }
}

async function meta(env) {
  const docs = new Map();
  for (const c of chunks) docs.set(c.source, { file: c.source, title: c.title, sections: (docs.get(c.source)?.sections || 0) + 1 });
  const index = policyIndex(env);
  return {
    pc141: [...docs.values()],
    laurier: CATALOG.map(({ id, title, publisher, url, authority, revised }) => ({ id, title, publisher, url, authority, ...(revised && { revised }) })),
    ...(index && { policyIndex: await index.stats().catch((e) => ({ error: String(e.message || e) })) }),
    sectionCodes: { lab: [...SECTION_CODES.lab].sort(), tutorial: [...SECTION_CODES.tutorial].sort() },
    modes: MODES,
    scopes: SCOPES,
  };
}

function parseRequest(body) {
  const { question, mode = "full", scope = "both", retrieveOnly = false, cache = true } = body || {};
  const sections = body?.sections && typeof body.sections === "object" ? body.sections : {};
  if (typeof question !== "string" || !question.trim() || question.length > 500) return { error: "question must be a non-empty string under 500 characters" };
  if (!MODES.includes(mode)) return { error: `mode must be one of: ${MODES.join(", ")}` };
  if (!SCOPES.includes(scope)) return { error: `scope must be one of: ${SCOPES.join(", ")}` };
  const pick = (v, known) => (typeof v === "string" && known.has(v.toUpperCase()) ? v.toUpperCase() : undefined);
  return {
    question: question.trim(),
    mode,
    scope,
    sections: { lab: pick(sections.lab, SECTION_CODES.lab), tutorial: pick(sections.tutorial, SECTION_CODES.tutorial) },
    retrieveOnly: retrieveOnly === true,
    cache: cache !== false, // false: skip the cached answer (a fresh one is still stored)
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const allowed = [env.ALLOWED_ORIGIN, "http://localhost:8000", "http://127.0.0.1:8000"];
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : env.ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return json({ error: "Origin not allowed" }, 403);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/meta") return json(await meta(env));

    // The policy index as tools for agents: MCP (stateless Streamable HTTP) and a plain search route.
    // Neither calls the LLM; when the AI allowance is used up they fall back to keyword search.
    const index = policyIndex(env);
    try {
      if (index && path === "/mcp") {
        const r = await mcpHttp(index, request.method, request.method === "POST" ? await request.text() : "");
        return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status, headers: { ...cors, ...(r.headers || {}), ...(r.body !== null && { "Content-Type": "application/json" }) } });
      }
      if (index && path === "/policy-search" && request.method === "POST") {
        const q = await request.json().catch(() => null);
        if (typeof q?.query !== "string" || !q.query.trim() || q.query.length > 500) return json({ error: "query must be a non-empty string under 500 characters" }, 400);
        return json(await searchPolicyIndex(index, q.query.trim(), { k: Math.max(1, Math.min(10, Number(q.k) || 5)), kinds: q.kinds }));
      }
    } catch (e) {
      return json({ error: "Policy index error", detail: String(e.message || e) }, 502);
    }
    if (request.method !== "POST") return json({ error: "POST a JSON body: {\"question\": \"...\"}, or GET /meta" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const req = parseRequest(body);
    if (req.error) return json({ error: req.error }, 400);

    try {
      return json(await ask(env, ctx, req));
    } catch (e) {
      const detail = String(e.message || e);
      // Workers AI error 4006: the account's daily neuron allowance is used up for now.
      if (/\b4006\b|daily free allocation/.test(detail)) return json({ error: "daily_limit", detail }, 429);
      return json({ error: "Upstream model error", detail }, 502);
    }
  },
};
