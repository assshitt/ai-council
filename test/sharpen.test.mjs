// Run with: npm test
// api/sharpen.js against a mocked model provider.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import handler, { SHARPEN_MAX_CHARS } from "../api/sharpen.js";
import { tuning } from "../api/council.js";

const realFetch = globalThis.fetch;
let calls;
const completion = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { "content-type": "application/json" } });
function mockFetch(script) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const call = { n: calls.length + 1, body, prompt: body?.messages?.[0]?.content || "", signal: init.signal };
    calls.push(call);
    return script(call);
  };
}
let ipCounter = 0;
function run(body, opts = {}) {
  const req = { method: opts.method || "POST", headers: { "x-forwarded-for": opts.ip || `10.1.0.${++ipCounter}` }, body };
  const res = { statusCode: null, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; } };
  return handler(req, res).then(() => res);
}

const savedRate = { ...tuning.RATE };
beforeEach(() => { process.env.OPENROUTER_API_KEY = "test-key"; Object.assign(tuning.RATE, savedRate, { max: 0 }); });
afterEach(() => { globalThis.fetch = realFetch; });

test("rejects non-POST and missing key", async () => {
  mockFetch(() => completion("x"));
  assert.equal((await run({ text: "x" }, { method: "GET" })).statusCode, 405);
  delete process.env.OPENROUTER_API_KEY;
  assert.equal((await run({ text: "x" })).statusCode, 500);
  assert.equal(calls.length, 0);
});

test("validates the text field and the 500 character cap", async () => {
  mockFetch(() => completion("x"));
  for (const body of [undefined, "nope", [], { text: 5 }, { text: "  " }, { question: "wrong field" }]) {
    assert.equal((await run(body)).statusCode, 400, JSON.stringify(body));
  }
  const res = await run({ text: "x".repeat(SHARPEN_MAX_CHARS + 1) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /under 500 characters/);
  assert.equal(calls.length, 0);
});

test("one model call, returns the rewrite and whether it changed", async () => {
  mockFetch(() => completion("Should I move to Berlin for a job that pays 20% more?"));
  const res = await run({ text: "shud i move to berlin for a job that pay 20% more" });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.max_tokens, 220);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.match(calls[0].prompt, /<question>\nshud i move to berlin/);
  assert.match(calls[0].prompt, /Do not answer it/);
  assert.deepEqual(res.body, { sharpened: "Should I move to Berlin for a job that pays 20% more?", changed: true });
});

test("strips quotes and labels the model may wrap the rewrite in", async () => {
  mockFetch(() => completion('Sharpened: "Is remote work better than office work?"'));
  const res = await run({ text: "is remote work beter than office" });
  assert.equal(res.body.sharpened, "Is remote work better than office work?");
});

test("unchanged text reports changed:false", async () => {
  mockFetch(() => completion("Should I learn Rust?"));
  const res = await run({ text: "Should I learn Rust?" });
  assert.deepEqual(res.body, { sharpened: "Should I learn Rust?", changed: false });
});

test("a failed or empty model reply is an error, never an empty rewrite", async () => {
  mockFetch(() => new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), { status: 429 }));
  let res = await run({ text: "q" });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /rate-limiting/);

  mockFetch(() => completion("   "));
  res = await run({ text: "q" });
  assert.equal(res.statusCode, 502);
});

test("has its own per-visitor rate limit bucket", async () => {
  tuning.RATE.max = 1;
  mockFetch(() => completion("Fine."));
  const ip = "203.0.113.9";
  assert.equal((await run({ text: "one" }, { ip })).statusCode, 200);
  const res = await run({ text: "two" }, { ip });
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers["retry-after"]) >= 1);
});
