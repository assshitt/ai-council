// api/v1/chat/completions.js — Council as a drop-in for any app that already uses the OpenAI chat format.
//
// Point the app's base URL at https://ai-council-ashen.vercel.app/api/v1 and use your Council key as the API key.
//   model "council"        → the full council: three labs argue, a chairman decides (about 30 s)
//   model "council-quick"  → one model, fast (about 10 s)
// The answer comes back in the normal chat-completion shape, plus a "council" object with the verdict details.
// Streaming is not supported yet: send "stream": false (the default).
import council from "../../council.js";
import { apiKeyError, cors, readBody } from "../../_auth.js";

function runCouncil(body, headers) {
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); }, end() { resolve({ code: this.code, body: {} }); } };
    const h = { ...headers }; delete h.origin;
    council({ method: "POST", body, headers: h, socket: {} }, res);
  });
}
const text = (c) => typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && (p.text || (typeof p === "string" ? p : ""))) || "").join(" ") : "";

function asText(d) {
  if (d.kind === "fact") return d.factAnswer || "";
  if (d.kind === "quick") return d.answer || "";
  const c = d.chairman || {};
  let t = (c.shortAnswer ? c.shortAnswer + "\n\n" : "") + (c.finalAnswer || "");
  if (c.split) t += `\n\nWhere the models disagree: ${c.split}`;
  if (c.confidence) t += `\n\nConfidence: ${c.confidence}`;
  return t.trim();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: { message: "Use POST.", type: "invalid_request_error" } });
  const keyErr = apiKeyError(req);
  if (keyErr) return res.status(401).json({ error: { message: keyErr, type: "invalid_api_key" } });
  const body = readBody(req);
  if (!body) return res.status(400).json({ error: { message: "Send a JSON body.", type: "invalid_request_error" } });
  if (body.stream) return res.status(400).json({ error: { message: "Streaming is not supported yet. Send \"stream\": false.", type: "invalid_request_error" } });
  const model = String(body.model || "council");
  if (!/^council(-quick)?$/.test(model)) return res.status(400).json({ error: { message: "Use model \"council\" or \"council-quick\".", type: "invalid_request_error" } });

  const msgs = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && typeof m === "object");
  const system = msgs.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n").trim();
  const turns = msgs.filter((m) => m.role === "user" || m.role === "assistant");
  const last = [...turns].reverse().find((m) => m.role === "user");
  if (!last || !text(last.content).trim()) return res.status(400).json({ error: { message: "Add at least one user message.", type: "invalid_request_error" } });
  // earlier turns become the thread, so follow-ups keep their context
  const history = [];
  for (let i = 0; i < turns.length - 1; i++) {
    if (turns[i].role === "user") history.push({ q: text(turns[i].content).slice(0, 500), a: turns[i + 1] && turns[i + 1].role === "assistant" ? text(turns[i + 1].content).slice(0, 700) : "" });
  }
  const question = ((system ? `Context from the app: ${system.slice(0, 600)}\n\n` : "") + text(last.content)).slice(0, 2000);

  const r = await runCouncil({ question, mode: model === "council-quick" ? "quick" : "debate", history: history.slice(-4) }, req.headers);
  const d = r.body || {};
  if (d.error || r.code >= 400) return res.status(r.code >= 400 ? r.code : 502).json({ error: { message: d.error || "The council could not answer.", type: r.code === 429 ? "rate_limit_exceeded" : "server_error" } });

  const content = asText(d);
  const created = Math.floor(Date.now() / 1000);
  return res.status(200).json({
    id: "chatcmpl-council-" + created.toString(36) + Math.random().toString(36).slice(2, 8),
    object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    council: {
      kind: d.kind, confidence: d.chairman ? d.chairman.confidence || null : null,
      short_answer: d.chairman ? d.chairman.shortAnswer || null : null,
      disagreement: d.chairman ? d.chairman.split || null : null,
      members: (d.members || []).map((m) => ({ seat: m.role, model: m.model, lab: m.lab, answer: m.answer })),
      models: d.receipt || [],
    },
  });
}
