// Run with: npm test
// Exercises api/council.js (v3) against a mocked OpenRouter, so no key or
// network is needed. The mock answers the model list and chat completions,
// choosing a reply from what the prompt asks for.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/council.js";

const realFetch = globalThis.fetch;
const FREE_MODELS = [
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Meta: Llama 3.3 70B Instruct (free)" },
  { id: "qwen/qwen3-32b:free", name: "Qwen: Qwen3 32B (free)" },
  { id: "google/gemma-3-27b-it:free", name: "Google: Gemma 3 27B (free)" },
  { id: "mistralai/mistral-small-24b-instruct:free", name: "Mistral: Mistral Small 24B (free)" },
  { id: "deepseek/deepseek-chat-v3:free", name: "DeepSeek: DeepSeek V3 (free)" },
  { id: "meta-llama/llama-guard-4-12b:free", name: "Meta: Llama Guard 4 12B (free)" }, // a classifier: must be filtered out
];
const SEAT_ANSWER = "- It fits the situation because the numbers already work for this person.\n- The upside compounds over the next two years if it goes well.\n- The downside is bounded and reversible within a few months.\nBest when: savings cover at least six months.";
const VERDICT = { strongest: "against", whyListen: "It names the binding constraint.", split: "They disagree on how much runway is enough.", finalAnswer: "Do not resign yet. Build six months of runway first, then decide.", confidence: "medium" };

let calls, chat;
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
const reply = (text) => ok({ choices: [{ message: { content: text } }] });
const httpErr = (status, message) => new Response(JSON.stringify({ error: { message, code: status } }), { status });

// chat(prompt, model, n) returns a Response; override per test.
function defaultChat(prompt) {
  if (/Classify this question/.test(prompt)) return reply('{"kind":"judgment"}');
  if (/single correct answer/.test(prompt)) return reply("Canberra is the capital of Australia.");
  if (/quick, decisive take/.test(prompt)) return reply("Stay for now and test the idea on weekends first. It keeps income while you learn.\nBottom line: wait six months, then decide with real numbers.");
  if (/You are the chairman/.test(prompt)) return reply(JSON.stringify(VERDICT));
  if (/Your seat:/.test(prompt)) return reply(SEAT_ANSWER);
  return reply("unexpected");
}
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  calls = []; chat = defaultChat;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.endsWith("/models")) return ok({ data: FREE_MODELS.map((m) => ({ ...m, context_length: 32768, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } })) });
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    calls.push({ model: body.model, prompt, headers: init.headers, signal: init.signal });
    return chat(prompt, body.model, calls.length);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

function run(body, method = "POST") {
  const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return handler({ method, headers: {}, body }, res).then(() => res);
}
const seatCalls = () => calls.filter((c) => /Your seat:/.test(c.prompt));

test("rejects non-POST, a missing key and an empty question", async () => {
  assert.equal((await run({ question: "x" }, "GET")).statusCode, 405);
  delete process.env.OPENROUTER_API_KEY;
  const r = await run({ question: "x" });
  assert.equal(r.statusCode, 500);
  assert.match(r.body.error, /OPENROUTER_API_KEY/);
  process.env.OPENROUTER_API_KEY = "k";
  assert.equal((await run({ question: "   " })).statusCode, 400);
  assert.equal((await run(undefined)).statusCode, 400);
  assert.equal(calls.length, 0);
});

test("judgment: three fixed seats on different models, then a chairman verdict", async () => {
  const r = await run({ question: "Should I leave my job to work on my startup full time?", category: "career" });
  assert.equal(r.statusCode, 200);
  const b = r.body;
  assert.equal(b.kind, "judgment");
  assert.equal(b.category, "career");
  assert.deepEqual(b.members.map((m) => m.seat), ["for", "against", "improve"]);
  assert.deepEqual(b.members.map((m) => m.name), ["The Advocate", "The Critic", "The Builder"]);
  assert.ok(b.members.every((m) => m.ok && m.answer.includes("Best when:")));
  assert.equal(new Set(seatCalls().map((c) => c.model)).size, 3, "the three seats start on three different models");
  assert.ok(!calls.some((c) => /guard/.test(c.model)), "safety classifiers are never used as seats");
  assert.ok(!calls.some((c) => /Classify this question/.test(c.prompt)), "'should I' skips the classifier call");
  assert.equal(b.chairman.strongestSeat, "against");
  assert.equal(b.chairman.strongest, "The case against");
  assert.equal(b.chairman.confidence, "medium");
  assert.equal(b.chairman.finalAnswer, VERDICT.finalAnswer);
  const chairModel = calls.find((c) => /You are the chairman/.test(c.prompt)).model;
  assert.ok(!seatCalls().some((c) => c.model === chairModel), "the chairman is not one of the models it judges");
  assert.ok(calls.every((c) => c.headers["HTTP-Referer"] === "https://ai-council-ashen.vercel.app"));
  assert.ok(calls.every((c) => c.signal), "every model call has a timeout signal");
});

test("fact gate: a plain lookup gets one line, no debate", async () => {
  chat = (p) => (/Classify this question/.test(p) ? reply('{"kind":"fact"}') : defaultChat(p));
  const r = await run({ question: "What is the capital of Australia?" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.kind, "fact");
  assert.equal(r.body.factAnswer, "Canberra is the capital of Australia.");
  assert.ok(r.body.nudge);
  assert.equal(seatCalls().length, 0);
});

test("quick take: one model, one answer", async () => {
  const r = await run({ question: "Should I learn the piano at 30?", mode: "quick" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.kind, "quick");
  assert.match(r.body.answer, /Bottom line:/);
  assert.ok(r.body.model);
  assert.equal(seatCalls().length, 0);
});

test("a classifier-style or empty reply is rejected and the seat moves to the next model", async () => {
  const bad = new Set();
  chat = (p, model) => {
    if (/THE CASE FOR/.test(p) && !bad.size) { bad.add(model); return reply("User Safety: safe"); }
    if (/THE CASE AGAINST/.test(p) && bad.size === 1) { bad.add(model); return reply(""); }
    return defaultChat(p);
  };
  const r = await run({ question: "Should I buy a flat this year?" });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.members.every((m) => m.ok), "both seats recovered on another model");
  assert.ok(r.body.members.every((m) => !/Safety/.test(m.answer)));
  for (const m of r.body.members) assert.ok(!bad.has(m.model));
});

test("a seat that never answers is marked, and the verdict is built from the other two", async () => {
  chat = (p) => (/HOW TO IMPROVE IT/.test(p) ? httpErr(502, "upstream down") : defaultChat(p));
  const r = await run({ question: "Should I move to Bangalore?" });
  assert.equal(r.statusCode, 200);
  const builder = r.body.members.find((m) => m.seat === "improve");
  assert.equal(builder.ok, false);
  assert.equal(builder.model, "");
  const chairPrompt = calls.find((c) => /You are the chairman/.test(c.prompt)).prompt;
  assert.ok(!/HOW TO IMPROVE IT \(/.test(chairPrompt), "the failed seat is not shown to the chairman as an answer");
  assert.ok(r.body.chairman.finalAnswer.length > 20);
});

test("chairman picking a failed seat falls back to one that answered", async () => {
  chat = (p) => {
    if (/THE CASE AGAINST/.test(p)) return httpErr(502, "down");
    if (/You are the chairman/.test(p)) return reply(JSON.stringify(VERDICT)); // names "against", which failed
    return defaultChat(p);
  };
  const r = await run({ question: "Should I switch to Python?" });
  assert.notEqual(r.body.chairman.strongestSeat, "against");
});

test("chairman that never returns a verdict gives an honest fallback", async () => {
  chat = (p) => (/You are the chairman/.test(p) ? reply("I think it depends.") : defaultChat(p));
  const r = await run({ question: "Should I get an MBA?" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.chairman.confidence, "low");
  assert.match(r.body.chairman.finalAnswer, /did not return a verdict/);
});

test("when every model is rate-limited the user gets a 429 with the quota message", async () => {
  chat = () => httpErr(429, "Rate limit exceeded: free-models-per-day");
  const r = await run({ question: "Should I rent or buy?" });
  assert.equal(r.statusCode, 429);
  assert.match(r.body.error, /quota/);
  assert.equal(r.body.members, undefined);
});

test("long questions are trimmed before they reach the models", async () => {
  await run({ question: "Should I " + "x".repeat(5000) });
  assert.ok(seatCalls().every((c) => !c.prompt.includes("x".repeat(2000))));
});
