// Answer generation: Llama 3.3 70B on Workers AI, with the same model on Groq as a backup for when
// the Workers AI daily allowance is used up (or Workers AI fails). Groq is used only when the
// GROQ_API_KEY secret is set.
import { RESPONSE_SCHEMA } from "./answer.js";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const GROQ_MODEL = "llama-3.3-70b-versatile";
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

// Groq's Llama 3.3 supports JSON mode but not schema-constrained output, so the schema is spelled
// out in the prompt. verifyAnswer still checks every field of whatever comes back.
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

async function groq(env, system, user, fetchImpl = fetch) {
  const call = async () => {
    const res = await fetchImpl(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.GROQ_MODEL || GROQ_MODEL,
        messages: [
          { role: "system", content: system + JSON_INSTRUCTIONS },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content;
  };
  // Retry once, except when Groq says its limit is reached.
  return call().catch((e) => (e.status === 429 ? Promise.reject(e) : call()));
}

// Returns { answer, readable, provider, model, fallback? }. Throws when every provider failed; the
// message keeps each provider's error, so a used-up allowance still reads as error 4006.
export async function complete(env, { system, user }, { fetchImpl = fetch, now = Date.now() } = {}) {
  const errors = [];
  if (skipWorkersAi(env, now)) {
    errors.push("Workers AI: skipped, error 4006 (daily free allocation used up) seen recently");
  } else {
    try {
      return { ...parseAnswer(await workersAi(env, system, user)), provider: "workers-ai", model: WORKERS_AI_MODEL };
    } catch (e) {
      if (isQuotaError(e)) markWorkersAiOut(now);
      if (!env.GROQ_API_KEY) throw e;
      errors.push(`Workers AI: ${e.message || e}`);
    }
  }
  try {
    const out = await groq(env, system, user, fetchImpl);
    return { ...parseAnswer(out), provider: "groq", model: env.GROQ_MODEL || GROQ_MODEL, fallback: errors[0] };
  } catch (e) {
    // Both out of allowance: report it as the daily limit so the page says "try again later".
    const both = e.status === 429 && errors.some(isQuotaError) ? " (daily free allocation used up on both providers)" : "";
    throw new Error(`${errors.join("; ")}; Groq: ${e.message || e}${both}`);
  }
}
