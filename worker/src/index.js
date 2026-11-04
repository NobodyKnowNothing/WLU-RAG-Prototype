import chunks from "./chunks.json"; // built by scripts/export_chunks.py
import vectors from "./vectors.json"; // precomputed by scripts/embed_chunks.py
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, answerText, buildUserMessage, verifyAnswer } from "./answer.js";
import { PAGES, searchLaurier } from "./laurier.js";
import { BM25, cosine, expandQuery, rrf } from "./retrieval.js";

const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const RERANK_MODEL = "@cf/baai/bge-reranker-base";
const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
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
    scope === "pc141" ? { sources: [], pages: [] } : searchLaurier(expandQuery(question), { mode, k: LAURIER_TOP_N, ctx, rerank: (q, t) => rerank(env, q, t) }),
  ]);
  const sources = [...course.map((c) => ({ ...c, kind: "pc141" })), ...laurier.sources].map((s, i) => ({ n: i + 1, ...s }));
  return { sources, pages: laurier.pages };
}

async function generate(env, question, sources, sections) {
  const run = () =>
    env.AI.run(LLM_MODEL, {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(question, sources, sections) },
      ],
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      temperature: 0.1,
      max_tokens: 1200,
    });
  const res = await stage("generate", run().catch(run)); // one retry for transient model errors
  let out = res.response ?? res.choices?.[0]?.message?.content;
  if (typeof out === "string") {
    try {
      out = JSON.parse(out);
    } catch {
      out = { status: "not_found", pc141: [], laurier: [], unverified: "The model returned an unreadable answer." };
    }
  }
  return out;
}

const publicSource = ({ n, kind, title, section, pages, source, pageId, url, publisher, fetchedAt, text, intro, score }) =>
  kind === "pc141"
    ? { n, kind, title, section, pages, file: source, text, ...(intro && { intro }), score }
    : { n, kind, title, section, page: pageId, publisher, url, fetchedAt, text, score };

async function ask(env, ctx, req) {
  const t0 = Date.now();
  const { sources, pages } = await retrieve(env, ctx, req);
  const t1 = Date.now();
  const base = { mode: req.mode, scope: req.scope, sources: sources.map(publicSource), laurierPages: pages };
  if (req.retrieveOnly) return { ...base, timings: { retrieveMs: t1 - t0 } };
  // Nothing relevant anywhere: say so without asking the model to improvise.
  const result = sources.length
    ? verifyAnswer(await generate(env, req.question, sources, req.sections), sources)
    : { status: "not_found", pc141: [], laurier: [], unverified: "No PC141 document or official Laurier page that was searched covers this question." };
  return { ...base, ...result, answer: answerText(result), timings: { retrieveMs: t1 - t0, generateMs: Date.now() - t1 } };
}

function meta() {
  const docs = new Map();
  for (const c of chunks) docs.set(c.source, { file: c.source, title: c.title, sections: (docs.get(c.source)?.sections || 0) + 1 });
  return {
    pc141: [...docs.values()],
    laurier: PAGES.map(({ id, title, publisher, url }) => ({ id, title, publisher, url })),
    sectionCodes: { lab: [...SECTION_CODES.lab].sort(), tutorial: [...SECTION_CODES.tutorial].sort() },
    modes: MODES,
    scopes: SCOPES,
  };
}

function parseRequest(body) {
  const { question, mode = "full", scope = "both", retrieveOnly = false } = body || {};
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
    if (request.method === "GET" && new URL(request.url).pathname === "/meta") return json(meta());
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
      return json({ error: "Upstream model error", detail: String(e.message || e) }, 502);
    }
  },
};
