// Answer generation: Llama 3.3 70B on Workers AI, and GPT-OSS 120B on Groq (when the GROQ_API_KEY
// secret is set; Groq's Llama 3.3 70B is no longer open to regular accounts). Workers AI's daily allowance is shared with retrieval (query embeddings and the
// reranker), and Llama uses about 120 neurons an answer against a fraction of a neuron for a
// retrieval. So Workers AI writes only the first WORKERS_AI_DAILY_ANSWERS answers of each UTC day,
// then Groq takes over, and the rest of the allowance keeps vector retrieval running. Either
// provider backs up the other when it fails.
import { RESPONSE_SCHEMA } from "./answer.js";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_TIMEOUT_MS = 45_000;
const TEMPERATURE = 0.1;
const MAX_TOKENS = 1200;

// Workers AI error 4006: the account's daily neuron allowance is used up for now. Groq answers 429
// when its own per-minute or per-day limits are reached.
export const isQuotaError = (e) => /\b4006\b|daily free allocation/i.test(String(e?.message || e));

// After a quota error, skip Workers AI for a while instead of paying a failed round trip on every
// question. Per isolate, so other isolates find out on their own first call.
const SKIP_MS = 10 * 60 * 1000;
let workersAiOutUntil = 0;
export const markWorkersAiOut = (now = Date.now()) => (workersAiOutUntil = now + SKIP_MS);
export const resetWorkersAiState = () => (workersAiOutUntil = 0);
// True when Workers AI should be skipped: it ran out recently and there is a backup to use instead.
export const skipWorkersAi = (env, now = Date.now()) => Boolean(env.GROQ_API_KEY) && now < workersAiOutUntil;

// Groq models with strict structured outputs get the answer schema as a constraint; others get JSON
// mode only. Both get the schema spelled out in the prompt, and verifyAnswer checks every field.
const STRICT_SCHEMA_MODELS = /^(openai\/gpt-oss-|qwen\/qwen3|meta-models\/muse-spark)/;
// Reasoning models spend completion tokens on hidden reasoning before the answer, so they get a
// low effort and a larger token allowance (an answer cut off mid-JSON is unreadable).
const REASONING_MODELS = /^(openai\/gpt-oss-|qwen\/qwen3)/;
const REASONING_MAX_TOKENS = 4096;
// Strict mode needs additionalProperties: false on every object.
const strict = (schema) =>
  schema && typeof schema === "object"
    ? Object.fromEntries([...Object.entries(schema).map(([k, v]) => [k, typeof v === "object" ? (Array.isArray(v) ? v.map(strict) : strict(v)) : v]), ...(schema.type === "object" ? [["additionalProperties", false]] : [])])
    : schema;
export function groqRequest(model, system, user) {
  const reasoning = REASONING_MODELS.test(model);
  return {
    model,
    messages: [
      { role: "system", content: system + JSON_INSTRUCTIONS },
      { role: "user", content: user },
    ],
    response_format: STRICT_SCHEMA_MODELS.test(model) ? { type: "json_schema", json_schema: { name: "answer", strict: true, schema: strict(RESPONSE_SCHEMA) } } : { type: "json_object" },
    temperature: TEMPERATURE,
    max_tokens: reasoning ? REASONING_MAX_TOKENS : MAX_TOKENS,
    ...(model.startsWith("openai/gpt-oss-") && { reasoning_effort: "low" }),
  };
}

const JSON_INSTRUCTIONS = `

Reply with one JSON object and nothing else. It has exactly these keys: "status" (one of "answered", "partial", "not_found"), "pc141" and "laurier" (arrays of claim objects, each {"text": string, "quote": string, "sources": array of source numbers}), and "unverified" (a string, empty when there is nothing to report).`;

const UNREADABLE = { status: "not_found", pc141: [], laurier: [], unverified: "The model returned an unreadable answer." };
export function parseAnswer(out) {
  if (out && typeof out === "object") return { answer: out, readable: true };
  try {
    const parsed = JSON.parse(String(out).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
    if (parsed && typeof parsed === "object") return { answer: parsed, readable: true };
  } catch {}
  return { answer: UNREADABLE, readable: false };
}

async function workersAi(env, system, user) {
  const run = () =>
    env.AI.run(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    });
  // One retry for transient model errors; a used-up allowance won't come back in a second.
  const res = await run().catch((e) => (isQuotaError(e) ? Promise.reject(e) : run()));
  return res.response ?? res.choices?.[0]?.message?.content;
}

// A secret piped in from a Windows shell can carry a byte-order mark or a trailing CR/LF, which makes
// the Authorization header invalid (an empty 400 before the request reaches Groq). Keys are plain ASCII.
export const cleanKey = (key) => String(key || "").replace(/[^\x21-\x7e]/g, "");

async function groq(env, system, user, fetchImpl = fetch) {
  const key = cleanKey(env.GROQ_API_KEY);
  const call = async () => {
    const res = await fetchImpl(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "wlu-rag-api/1.0" },
      body: JSON.stringify(groqRequest(env.GROQ_MODEL || GROQ_MODEL, system, user)),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      const ray = res.headers.get("cf-ray");
      const err = new Error(`HTTP ${res.status}: ${body || `(empty body${ray ? `, cf-ray ${ray}` : ""}${String(env.GROQ_API_KEY).length !== key.length ? ", key had stray characters removed" : ""})`}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content;
  };
  // Retry once for network errors and 5xx; a 4xx (bad key, unknown model, limit reached) won't change.
  return call().catch((e) => (e.status && e.status < 500 ? Promise.reject(e) : call()));
}

export const DEFAULT_DAILY_ANSWERS = 25; // the allowance has run out after as few as 41 answers
export const dailyAnswerBudget = (env) => {
  const n = Number(env.WORKERS_AI_DAILY_ANSWERS);
  return env.WORKERS_AI_DAILY_ANSWERS !== undefined && env.WORKERS_AI_DAILY_ANSWERS !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_ANSWERS;
};

// Answers Workers AI has written today (UTC), shared by every isolate through D1. Without a database,
// or if it fails, the count is kept per isolate.
const memoryCounts = new Map();
export const resetUsage = () => memoryCounts.clear();
const USAGE_SCHEMA = "CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, answers INTEGER NOT NULL)";
export function usageCounter(db) {
  let ready;
  const table = () => (ready ||= db.prepare(USAGE_SCHEMA).run().catch((e) => ((ready = null), Promise.reject(e))));
  const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
  return {
    async today(now = Date.now()) {
      const day = dayOf(now);
      if (db) {
        try {
          await table();
          const row = await db.prepare("SELECT answers FROM ai_usage WHERE day = ?").bind(day).first();
          return Math.max(row?.answers || 0, memoryCounts.get(day) || 0);
        } catch {}
      }
      return memoryCounts.get(day) || 0;
    },
    async add(now = Date.now()) {
      const day = dayOf(now);
      memoryCounts.set(day, (memoryCounts.get(day) || 0) + 1);
      if (!db) return;
      try {
        await table();
        await db.prepare("INSERT INTO ai_usage (day, answers) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET answers = answers + 1").bind(day).run();
        if (Math.random() < 0.05) await db.prepare("DELETE FROM ai_usage WHERE day < ?").bind(dayOf(now - 30 * 86400_000)).run();
      } catch {}
    },
  };
}

// Returns { answer, readable, provider, model, budgetReached?, fallback? }. Throws when every provider
// failed; the message keeps each provider's error, so a used-up allowance still reads as error 4006.
export async function complete(env, { system, user }, { fetchImpl = fetch, now = Date.now(), usage = usageCounter(null) } = {}) {
  const hasGroq = Boolean(env.GROQ_API_KEY);
  const budget = dailyAnswerBudget(env);
  const budgetReached = hasGroq && (await usage.today(now)) >= budget;
  const viaWorkersAi = async () => {
    const out = parseAnswer(await workersAi(env, system, user));
    await usage.add(now);
    return { ...out, provider: "workers-ai", model: WORKERS_AI_MODEL };
  };
  const viaGroq = async () => ({ ...parseAnswer(await groq(env, system, user, fetchImpl)), provider: "groq", model: env.GROQ_MODEL || GROQ_MODEL });
  const order = !hasGroq ? [["Workers AI", viaWorkersAi]] : budgetReached ? [["Groq", viaGroq], ["Workers AI", viaWorkersAi]] : [["Workers AI", viaWorkersAi], ["Groq", viaGroq]];

  const errors = [];
  let groqError;
  for (const [name, run] of order) {
    if (name === "Workers AI" && skipWorkersAi(env, now)) {
      errors.push("Workers AI: skipped, error 4006 (daily free allocation used up) seen recently");
      continue;
    }
    try {
      const r = await run();
      return { ...r, ...(budgetReached && { budgetReached: true }), ...(errors.length && { fallback: errors.join("; ") }) };
    } catch (e) {
      if (!hasGroq) throw e;
      if (name === "Workers AI" && isQuotaError(e)) markWorkersAiOut(now);
      if (name === "Groq") groqError = e;
      errors.push(`${name}: ${e.message || e}`);
    }
  }
  // Both out of allowance: report it as the daily limit so the page says "try again later".
  const both = groqError?.status === 429 && errors.some(isQuotaError) ? " (daily free allocation used up on both providers)" : "";
  throw new Error(errors.join("; ") + both);
}
