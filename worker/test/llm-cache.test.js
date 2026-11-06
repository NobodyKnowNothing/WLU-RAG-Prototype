import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { answerCache, cacheKey, clearMemory, normalizeQuestion } from "../src/cache.js";
import { GROQ_MODEL, WORKERS_AI_MODEL, complete, parseAnswer, resetWorkersAiState, skipWorkersAi } from "../src/llm.js";

const ANSWER = { status: "answered", pc141: [], laurier: [], unverified: "" };
const PROMPT = { system: "sys", user: "question" };
const quotaError = () => Object.assign(new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"));
const ai = (impl) => ({ calls: 0, run(model, input) { this.calls++; return impl(model, input); } });
const groqOk = (content = JSON.stringify(ANSWER)) => {
  const f = async (url, init) => ((f.calls = (f.calls || 0) + 1), (f.last = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }), new Response(JSON.stringify({ choices: [{ message: { content } }] })));
  return f;
};

beforeEach(() => {
  resetWorkersAiState();
  clearMemory();
});

test("Workers AI answers when it can, and Groq is not called", async () => {
  const env = { AI: ai(async () => ({ response: ANSWER })), GROQ_API_KEY: "test-key" };
  const fetchImpl = groqOk();
  const r = await complete(env, PROMPT, { fetchImpl });
  assert.deepEqual(r, { answer: ANSWER, readable: true, provider: "workers-ai", model: WORKERS_AI_MODEL });
  assert.equal(fetchImpl.calls, undefined);
});

test("a used-up Workers AI allowance switches to Groq without retrying, then skips Workers AI for a while", async () => {
  const env = { AI: ai(async () => Promise.reject(quotaError())), GROQ_API_KEY: "test-key" };
  const fetchImpl = groqOk();
  const r = await complete(env, PROMPT, { fetchImpl });
  assert.equal(r.provider, "groq");
  assert.equal(r.model, GROQ_MODEL);
  assert.match(r.fallback, /4006/);
  assert.deepEqual(r.answer, ANSWER);
  assert.equal(env.AI.calls, 1, "no retry once the allowance is gone");
  assert.equal(fetchImpl.last.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(fetchImpl.last.auth, "Bearer test-key");
  assert.equal(fetchImpl.last.body.response_format.type, "json_object");
  assert.match(fetchImpl.last.body.messages[0].content, /JSON object/);

  assert.ok(skipWorkersAi(env));
  await complete(env, PROMPT, { fetchImpl });
  assert.equal(env.AI.calls, 1, "Workers AI skipped on the next question");
  assert.equal(fetchImpl.calls, 2);
  assert.ok(!skipWorkersAi(env, Date.now() + 11 * 60 * 1000), "tried again after the pause");
});

test("other Workers AI errors are retried once before Groq takes over", async () => {
  const env = { AI: ai(async () => Promise.reject(new Error("InferenceUpstreamError: 502"))), GROQ_API_KEY: "test-key" };
  const r = await complete(env, PROMPT, { fetchImpl: groqOk() });
  assert.equal(env.AI.calls, 2);
  assert.equal(r.provider, "groq");
  assert.ok(!skipWorkersAi(env), "a transient error does not pause Workers AI");
});

test("without GROQ_API_KEY the Workers AI error is thrown as before", async () => {
  const env = { AI: ai(async () => Promise.reject(quotaError())) };
  await assert.rejects(complete(env, PROMPT, { fetchImpl: groqOk() }), /4006/);
  assert.ok(!skipWorkersAi(env));
});

test("when both providers are out, the error still reads as the daily limit", async () => {
  const env = { AI: ai(async () => Promise.reject(quotaError())), GROQ_API_KEY: "test-key" };
  let calls = 0;
  const fetchImpl = async () => (calls++, new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }));
  await assert.rejects(complete(env, PROMPT, { fetchImpl }), (e) => /\b4006\b/.test(e.message) && /Groq: HTTP 429/.test(e.message));
  assert.equal(calls, 1, "no retry on Groq's 429");
});

test("model output is parsed from objects, strings and fenced JSON", () => {
  assert.deepEqual(parseAnswer(ANSWER).answer, ANSWER);
  assert.deepEqual(parseAnswer(JSON.stringify(ANSWER)).answer, ANSWER);
  assert.deepEqual(parseAnswer("```json\n" + JSON.stringify(ANSWER) + "\n```").answer, ANSWER);
  assert.equal(parseAnswer("Sorry, I can't").readable, false);
});

test("cache keys ignore case, spacing and trailing punctuation but not mode, scope or sections", async () => {
  const base = { question: "When is my lab?", mode: "full", scope: "both", sections: { lab: "L04" } };
  assert.equal(normalizeQuestion("  When  is my LAB ?? "), "when is my lab");
  assert.equal(await cacheKey(base), await cacheKey({ ...base, question: "when is my lab" }));
  for (const change of [{ mode: "simple" }, { scope: "pc141" }, { sections: { lab: "L05" } }, { question: "When is my tutorial?" }])
    assert.notEqual(await cacheKey(base), await cacheKey({ ...base, ...change }));
});

// A D1-shaped wrapper over node:sqlite.
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const d1 = {
    queries: 0,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => ((args = a), stmt),
        run: async () => (d1.queries++, db.prepare(sql).run(...args)),
        first: async () => (d1.queries++, db.prepare(sql).get(...args) ?? null),
      };
      return stmt;
    },
  };
  return d1;
}

test("answers are stored in D1, shared across isolates and expire", async () => {
  let t = 1_000_000;
  const db = fakeD1();
  const cache = answerCache(db, { now: () => t });
  assert.equal(await cache.get("k"), null);
  await cache.put("k", { answer: "x" }, 60);
  clearMemory(); // a different isolate: only D1 has it
  assert.deepEqual(await cache.get("k"), { answer: "x" });
  const before = db.queries;
  assert.deepEqual(await cache.get("k"), { answer: "x" });
  assert.equal(db.queries, before, "second read served from memory");
  t += 61_000;
  assert.equal(await cache.get("k"), null);
  clearMemory();
  assert.equal(await cache.get("k"), null);
});

test("a broken cache database is ignored", async () => {
  const broken = { prepare: () => ({ bind() { return this; }, run: async () => Promise.reject(new Error("D1_ERROR")), first: async () => Promise.reject(new Error("D1_ERROR")) }) };
  const cache = answerCache(broken);
  await cache.put("k", { answer: "x" });
  assert.deepEqual(await cache.get("k"), { answer: "x" }, "memory tier still works");
  clearMemory();
  assert.equal(await cache.get("k"), null);
});
