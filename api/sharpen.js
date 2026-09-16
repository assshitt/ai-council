// api/sharpen.js
// POST { text } -> { sharpened, changed }
// One model call that fixes spelling and grammar and makes the question
// clearer without changing what it asks. Input is capped at 500 characters.
import { callModel, Budget, clip, quoteQuestion, rateLimitRetryAfter, rateLimitResponse, clientIp, readTextField, send, CHAIRMAN } from "./council.js";

export const SHARPEN_MAX_CHARS = 500;
const SHARPEN_TOKENS = 220;
const SHARPEN_MS = 15_000;

const PROMPT = (text) =>
  `${quoteQuestion(text)}\n\n` +
  `Rewrite the text inside <question> as a clear, well-formed question. Fix spelling, grammar and punctuation, ` +
  `and remove filler. Keep every fact, name, number and the exact intent. Keep the same language it was written in. ` +
  `Do not answer it, do not add claims, do not make it longer than it needs to be. If it is already clear, return it unchanged. ` +
  `Reply with ONLY the rewritten question, no quotes, no preamble.`;

// Models sometimes wrap the rewrite in quotes or a label; strip that.
function unwrap(s) {
  let t = s.trim();
  t = t.replace(/^(?:sharpened|rewritten|question)\s*:\s*/i, "");
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("“") && t.endsWith("”"))) t = t.slice(1, -1).trim();
  return t;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Use POST." }); }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return send(res, 500, { error: "Server is missing OPENROUTER_API_KEY." });

  const input = readTextField(req, "text", SHARPEN_MAX_CHARS);
  if (input.error) return send(res, 400, { error: input.error });
  const text = input.text;

  const retryAfter = rateLimitRetryAfter("sharpen:" + clientIp(req));
  if (retryAfter) return rateLimitResponse(res, retryAfter);

  try {
    const budget = new Budget(SHARPEN_MS + 1000);
    const r = await callModel({ model: CHAIRMAN, prompt: PROMPT(text), key, maxTokens: SHARPEN_TOKENS, capMs: SHARPEN_MS, budget });
    if (!r.ok) {
      const msg = r.code === "rate_limited" ? "The model provider is rate-limiting us right now. Try again in a minute."
        : r.code === "timeout" ? "Sharpening took too long. Try again."
        : "Couldn't sharpen that just now. Try again in a moment.";
      return send(res, 502, { error: msg });
    }
    const sharpened = clip(unwrap(r.text), SHARPEN_MAX_CHARS * 2);
    if (!sharpened) return send(res, 502, { error: "Couldn't sharpen that just now. Try again in a moment." });
    return send(res, 200, { sharpened, changed: sharpened !== text });
  } catch (e) {
    console.error("sharpen: unexpected failure", e);
    return send(res, 500, { error: "Sharpening hit an unexpected error. Please try again." });
  }
}
