// api/v1/interpret.js — Council's interpretation layer for apps (payments, crypto, any AI feature that acts on what people type).
//
// Instead of trusting one model's reading of a user's words, three models from different AI labs read the same
// message on their own, into the same fields. Council then compares them field by field. The agreement is computed,
// not generated: every field says how many models agreed, and anything they do not agree on goes back to the user.
//
// POST /api/v1/interpret
//   { "input": "swap half my USDC to ETH and send 0.5 to rahul tmrw 9am",
//     "fields": { "action": "what to do", "amount": "number", ... },   // optional, a payment intent by default
//     "required": ["action", "amount"],                               // optional, all fields by default
//     "context": "Wallet app on Ethereum. User balance: 1,240 USDC.",  // optional, facts the app knows
//     "readings": true }                                              // optional, include each model's own reading
//
// next_step: "proceed" (every model agreed on every required field), "confirm" (a required field had only a majority,
// so show the reading and let the person confirm it), or "ask_user" (models disagreed or a required field is missing).
//
// Council never executes anything. It returns a reading; the app builds the transaction; a person (or a guard) signs.
import crypto from "node:crypto";
import { firstGood, chainFor, rateCheck, countUp, keyOf, PAID, PAID_PER_DAY, stripThink, leaked } from "../council.js";
import { apiKeyError, cors, readBody } from "../_auth.js";

const DEFAULT_FIELDS = {
  action: "what to do, one word: transfer, swap, pay, stake, bridge, buy, sell, approve or other",
  amount: "the amount as a number, or null if it is relative (like \"half\") and the balance is not given",
  asset: "the token or currency symbol, for example ETH, USDC or INR",
  to_asset: "for a swap or buy, the token they want to end up with, otherwise null",
  network: "the blockchain or payment network, only if stated or given in the context",
  recipient: "who receives it: an address, ENS name, UPI ID or account exactly as written, or null if only a person's name is given",
  when: "when it should happen, as written (for example \"now\" or \"tomorrow 09:00\"), or null if no time is given",
  conditions: "any condition or limit they set, for example \"keep at least 500 in savings\", or null",
};
const DEFAULT_REQUIRED = ["action", "amount", "asset", "recipient", "when"];
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

function extractJSON(t) {
  const s = stripThink(String(t || "")).replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  if (a < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) { try { const o = JSON.parse(s.slice(a, i + 1)); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; } }
  }
  return null;
}
// two readings count as the same value when they mean the same thing
function norm(v) {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return Number.isFinite(v) ? "n:" + +v.toFixed(8) : "∅";
  if (typeof v === "boolean") return "b:" + v;
  if (typeof v === "object") return "o:" + JSON.stringify(v).toLowerCase();
  const s = String(v).trim().replace(/\s+/g, " ").replace(/[.。]+$/, "");
  if (!s || /^(null|none|n\/a|unknown|not (stated|given|specified)|unspecified|-)$/i.test(s)) return "∅";
  const n = s.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(n)) return "n:" + +(+n).toFixed(8);
  return "s:" + s.toLowerCase();
}
function clean(v) {
  if (v === undefined) return null;
  if (typeof v === "string") { const k = norm(v); if (k === "∅") return null; if (k.startsWith("n:")) return +k.slice(2); return v.trim(); }
  return v;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const keyErr = apiKeyError(req);
  if (keyErr) return res.status(401).json({ error: keyErr });
  const body = readBody(req);
  if (!body) return res.status(400).json({ error: "Send a JSON body." });

  const input = String(body.input || "").trim().slice(0, 2000);
  if (!input) return res.status(400).json({ error: "Add \"input\": the user's words." });
  let fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : null;
  if (fields) {
    const entries = Object.entries(fields).filter(([k]) => KEY_RE.test(k)).slice(0, 15).map(([k, d]) => [k, String(d || "").slice(0, 200)]);
    if (!entries.length) return res.status(400).json({ error: "\"fields\" needs keys in snake_case, like {\"amount\": \"a number\"}." });
    fields = Object.fromEntries(entries);
  } else fields = DEFAULT_FIELDS;
  const keys = Object.keys(fields);
  const required = (Array.isArray(body.required) ? body.required.filter((k) => keys.includes(k)) : (body.fields ? keys : DEFAULT_REQUIRED));
  const context = String(body.context || "").trim().slice(0, 1000);
  const showReadings = body.readings !== false;

  const limit = await rateCheck(req, true);
  if (limit) return res.status(429).json({ error: limit });

  const start = Date.now();
  let allowPaid = [...PAID].some((p) => keyOf(p));
  if (allowPaid) { const [n] = await countUp([[`paid:${Math.floor(Date.now() / 86400000)}`, 90000]]); if (n > PAID_PER_DAY) allowPaid = false; }
  const chains = await Promise.all(["for", "against", "improve"].map((s) => chainFor(s, [], allowPaid)));

  const prompt =
    `You turn what a person typed into a structured instruction for an app. Read it exactly as written.\n` +
    (context ? `What the app already knows (trust this): ${context}\n` : "") +
    `\nThe person typed: "${input}"\n\nFill these fields:\n` + keys.map((k) => `- ${k}: ${fields[k]}`).join("\n") + `\n\n` +
    `Rules: use only what the person wrote and what the app knows. If a field is not stated, or you would have to guess it, use null. ` +
    `Never invent addresses, balances, prices or times. Numbers as plain numbers, with no units or commas. Keep text values short and exactly as written. ` +
    `Also add "_unclear": a list of short notes (under 15 words each) on anything ambiguous or risky in the message, or an empty list.\n\n` +
    `Return ONLY one JSON object with exactly these keys: ${JSON.stringify([...keys, "_unclear"])}. No explanation, no code fences.`;
  const results = await Promise.all(chains.map((chain) => firstGood(chain, prompt, {
    deadline: start + 35000, maxTokens: 500, temperature: 0.1, clean: stripThink,
    validate: (t) => !leaked(t) && !!extractJSON(t),
  })));

  // keep one reading per model, so a backup answering twice cannot outvote the others
  const seen = new Set(), readings = [];
  results.forEach((r) => { if (!r.ok || seen.has(r.modelId)) return; seen.add(r.modelId);
    const o = extractJSON(r.text); if (!o) return;
    const out = {}; keys.forEach((k) => { out[k] = clean(o[k]); });
    const unclear = (Array.isArray(o._unclear) ? o._unclear : []).map((x) => String(x || "").trim()).filter((x) => x && x.length < 200).slice(0, 4);
    readings.push({ model: r.model, model_id: r.modelId, lab: r.lab, provider: r.provider, output: out, unclear });
  });
  if (!readings.length) return res.status(502).json({ error: "No model returned a usable reading in time. Try again in a moment." });

  const n = readings.length, need = Math.floor(n / 2) + 1;
  const intent = {}, agreement = {}, status = {}, disagreements = {};
  keys.forEach((k) => {
    const tally = new Map();
    readings.forEach((r) => { const key = norm(r.output[k]); const t = tally.get(key) || { n: 0, v: r.output[k] }; t.n++; tally.set(key, t); });
    const [topKey, top] = [...tally.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    const agreed = top.n >= need && n >= 2;
    intent[k] = agreed ? top.v : null;
    agreement[k] = `${top.n}/${n}`;
    status[k] = !agreed ? "split" : topKey === "∅" ? "missing" : top.n === n ? "agreed" : "majority";
    if (tally.size > 1) disagreements[k] = [...tally.values()].map((t) => ({ value: t.v, models: t.n }));
  });
  const ask = keys.filter((k) => status[k] === "split" || (status[k] === "missing" && required.includes(k)));
  const solid = keys.every((k) => status[k] === "agreed" || (status[k] === "missing" && !required.includes(k)));
  const confidence = n < 2 ? "low" : ask.length ? "low" : solid ? "high" : "medium";
  // money is not a majority vote: a required field only passes on its own when every model agreed
  const partial = keys.filter((k) => status[k] === "majority" && required.includes(k));
  const next_step = ask.length || n < 2 ? "ask_user" : partial.length ? "confirm" : "proceed";
  const notes = [...new Set(readings.flatMap((r) => r.unclear))].slice(0, 5);
  const label = (k) => k.replace(/_/g, " ");
  const question = ask.length ? `Please confirm the ${ask.map(label).join(", ").replace(/, ([^,]*)$/, " and $1")}.` : null;
  const created = new Date().toISOString();
  const receipt = "rcpt_" + crypto.createHash("sha256").update(JSON.stringify({ input, context, intent, models: readings.map((r) => r.model_id), created })).digest("hex").slice(0, 24);

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    intent, confidence, next_step, ask_user: ask, confirm_with_user: partial, question, notes,
    fields: Object.fromEntries(keys.map((k) => [k, { value: intent[k], agreement: agreement[k], status: status[k] }])),
    disagreements, models_agreeing: n,
    readings: showReadings ? readings.map(({ model, model_id, lab, provider, output, unclear }) => ({ model, model_id, lab, provider, output, unclear })) : undefined,
    receipt: { id: receipt, created, latency_ms: Date.now() - start },
    note: "Council only reads. It never moves money: your app builds the transaction and a person signs it.",
  });
}
