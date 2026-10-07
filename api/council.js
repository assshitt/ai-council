// api/council.js — Council backend, v4
//
// What's new in v4
//  • Several free providers, not just OpenRouter. Each seat runs on a model from a different AI lab:
//      The case for      → gpt-oss-120b (OpenAI's open-weight model)  served by Groq, backup Cerebras
//      The case against  → Gemini Flash (Google)                      served by Google AI Studio
//      How to improve it → Llama (Meta)                                served by Groq
//      Chairman          → Qwen (Alibaba)                              served by Cerebras, backup Groq
//    Model IDs are read live from each provider's model list, so retired models never break a seat.
//  • Verifiable: every answer carries the exact model ID the provider says produced it, and which
//    provider served it. The site shows this "receipt" under every verdict.
//  • If a provider is down, slow or out of quota, the seat moves to the next model automatically.
//  • Rate limiting per visitor (hashed IP) plus a daily cap for the whole site, so nobody can burn
//    your free quota. Requests from other websites are refused.
//
// Environment variables (Vercel → Settings → Environment Variables). Any subset works;
// the more you add, the more reliable and diverse the council is.
//   OPENAI_API_KEY      platform.openai.com  (prepaid credit) — main seat: The case for (GPT)
//   ANTHROPIC_API_KEY   console.anthropic.com (prepaid credit) — main seat: The case against (Claude)
//   OPENAI_MODEL / ANTHROPIC_MODEL / GEMINI_MODEL  (optional) pin an exact model ID, e.g. gpt-6-luna for a cheaper council
//   PAID_PER_DAY        (default 150) debates per day that may use GPT/Claude; after that, free backups answer
//   GROQ_API_KEY        console.groq.com/keys                 (free, no card)
//   CEREBRAS_API_KEY    cloud.cerebras.ai                     (free, no card)
//   GEMINI_API_KEY      aistudio.google.com/apikey            (free; free tier may be used for training)
//   MISTRAL_API_KEY     optional: Mistral's free plan may now need payment details; not required
//   OPENROUTER_API_KEY  openrouter.ai                         (optional extra fallback)
//   Optional: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (shared rate limits, free at upstash.com)
//             RATE_PER_HOUR (default 8), RATE_PER_DAY (default 25), GLOBAL_PER_DAY (default 600)
//             ALLOWED_ORIGINS (comma-separated extra sites allowed to call this API), RL_SALT
//
// Response contract (the site reads these fields):
//  { error }
//  { kind:"fact", factAnswer, nudge, receipt }
//  { kind:"quick", answer, model, receipt }
//  { kind:"judgment", members:[{seat,role,name,model,modelId,provider,lab,answer,ok}],
//    chairman:{strongest,strongestSeat,whyListen,split,finalAnswer,confidence,model,modelId,provider,lab},
//    verificationText, receipt:[{role,modelId,provider,lab}] }

import crypto from "node:crypto";

const SITE_URL = process.env.SITE_URL || "https://ai-council-ashen.vercel.app";
const SEATS_DONE_BY_MS = 38000;   // seats must finish by here so the chairman has time
const ALL_DONE_BY_MS = 55000;     // Vercel stops the function at 60s (vercel.json)
const ATTEMPT_TIMEOUT_MS = 22000; // one model call
const BACKUP_AFTER_MS = 13000;    // start the next model if the current one is this slow
const OR_MODELS = "https://openrouter.ai/api/v1/models";
const LIMIT_MSG = "The free council has used up its model quota for now. Try again in a few minutes, or later today.";

// ---------------------------------------------------------------- providers
const PROVIDERS = {
  groq:       { label: "Groq",             base: "https://api.groq.com/openai/v1",                              env: "GROQ_API_KEY" },
  cerebras:   { label: "Cerebras",         base: "https://api.cerebras.ai/v1",                                  env: "CEREBRAS_API_KEY" },
  google:     { label: "Google AI Studio", base: "https://generativelanguage.googleapis.com/v1beta/openai",     env: "GEMINI_API_KEY" },
  mistral:    { label: "Mistral",          base: "https://api.mistral.ai/v1",                                   env: "MISTRAL_API_KEY" },
  openrouter: { label: "OpenRouter",       base: "https://openrouter.ai/api/v1",                                env: "OPENROUTER_API_KEY" },
  openai:     { label: "OpenAI API",       base: "https://api.openai.com/v1",                                   env: "OPENAI_API_KEY" },
  anthropic:  { label: "Anthropic API",    base: "https://api.anthropic.com/v1",                                env: "ANTHROPIC_API_KEY" },
};
const PAID = new Set(["openai", "anthropic"]);   // prepaid providers: used only up to PAID_PER_DAY debates a day
const OVERRIDE = { openai: process.env.OPENAI_MODEL, anthropic: process.env.ANTHROPIC_MODEL, google: process.env.GEMINI_MODEL };
const keyOf = (p) => process.env[PROVIDERS[p].env] || "";
// Model families, best first. Patterns are matched against each provider's LIVE model list.
const FAMILIES = {
  // newest mid-priced models first (same $2/$10 price, higher scores); the flagships cost 2-5x more and are not picked
  gpt:     [["openai", [/^gpt-6\.1-sol$/, /^gpt-6-sol$/, /^gpt-6\.1-luna$/, /^gpt-6-luna$/, /^gpt-5\.6-terra$/, /^gpt-5\.6-sol$/, /^gpt-5\.6-luna$/]]],
  claude:  [["anthropic", [/^claude-sonnet-5-5$/, /^claude-sonnet-5$/, /^claude-sonnet-5[-.\d]*$/, /^claude-haiku-4-5[-\d]*$/]]],
  oss:     [["groq", [/^openai\/gpt-oss-120b$/, /^openai\/gpt-oss-20b$/]], ["cerebras", [/^gpt-oss-120b$/]]],
  gemini:  [["google", [/^gemini-3(\.\d+)?-flash(-preview)?$/, /^gemini-2\.5-flash$/, /^gemini-[\d.]+-flash(-preview)?$/, /^gemini-[\d.]+-flash-lite(-preview)?$/]]],
  mistral: [["mistral", [/^mistral-medium-latest$/, /^mistral-large-latest$/, /^mistral-small-latest$/]]],
  qwen:    [["cerebras", [/^qwen-\d[\w.-]*$/]], ["groq", [/^qwen\/qwen[\w.-]+$/]]],
  llama:   [["groq", [/^meta-llama\/llama-4-scout[\w.-]*$/, /^meta-llama\/llama-4-maverick[\w.-]*$/, /^llama-3\.3-70b[\w.-]*$/]]],
};
// used only if a provider's model list can't be read
const DEFAULT_IDS = {
  groq: ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "meta-llama/llama-4-scout-17b-16e-instruct"], cerebras: ["gpt-oss-120b", "qwen-3.8-27b"],
  google: ["gemini-2.5-flash"], openai: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"], anthropic: ["claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"], mistral: ["mistral-medium-latest", "mistral-small-latest"],
};
// seat → preferred family; everything else is the fallback order
// Main panel: GPT, Claude, Gemini. Chairman: Qwen (a fourth lab, free). Free open models are the backups.
const SEAT_FAMILY = { for: "gpt", against: "claude", improve: "gemini", chair: "qwen" };
const FALLBACK_ORDER = ["gpt", "claude", "gemini", "oss", "llama", "qwen", "mistral"];
const FAM_LAB = { gpt: "OpenAI", oss: "OpenAI", claude: "Anthropic", gemini: "Google", llama: "Meta", qwen: "Alibaba", mistral: "Mistral AI" };
const FAM_NAME = { gpt: "GPT", oss: "gpt-oss", claude: "Claude", gemini: "Gemini", llama: "Llama", qwen: "Qwen", mistral: "Mistral" };

function labOf(id) {
  const s = String(id).toLowerCase();
  if (/gpt-oss|^openai\/|^gpt-|^o\d/.test(s)) return "OpenAI";
  if (/claude/.test(s)) return "Anthropic";
  if (/gemini|gemma/.test(s)) return "Google";
  if (/mistral|magistral|ministral|codestral/.test(s)) return "Mistral AI";
  if (/qwen/.test(s)) return "Alibaba";
  if (/llama/.test(s)) return "Meta";
  if (/deepseek/.test(s)) return "DeepSeek";
  if (/glm|zai/.test(s)) return "Zhipu";
  if (/kimi|moonshot/.test(s)) return "Moonshot";
  if (/nemotron|nvidia/.test(s)) return "NVIDIA";
  return "";
}
function pretty(id) { return String(id).replace(/^models\//, "").replace(/^(openai|qwen|meta-llama|mistralai|google)\//, "").replace(/:free$/, ""); }
function display(id) { const lab = labOf(id); return lab ? `${pretty(id)} (${lab})` : pretty(id); }

const listCache = {};
async function listModels(p) {
  const c = listCache[p];
  if (c && Date.now() - c.at < 30 * 60 * 1000) return c.ids;
  let ids = [];
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
    const headers = p === "anthropic" ? { "x-api-key": keyOf(p), "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${keyOf(p)}` };
    const r = await fetch(PROVIDERS[p].base + "/models", { headers, signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    ids = (d.data || d.models || []).map((m) => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
  } catch { /* fall back to defaults */ }
  if (ids.length) listCache[p] = { at: Date.now(), ids };
  return ids;
}
async function family(name) {
  const out = [];
  for (const [p, pats] of FAMILIES[name]) {
    if (!keyOf(p)) continue;
    const live = await listModels(p);
    const pool = live.length ? live : DEFAULT_IDS[p] || [];
    const seen = new Set();
    if (OVERRIDE[p]) { seen.add(OVERRIDE[p]); out.push({ p, id: OVERRIDE[p] }); }   // your chosen model always goes first
    for (const re of pats) for (const id of pool.filter((x) => re.test(x))) if (!seen.has(id)) { seen.add(id); out.push({ p, id }); }
  }
  return out;
}

const SEATS = [
  {
    seat: "for", role: "The case for", name: "The Advocate",
    brief:
      "Your seat: THE CASE FOR. Give the strongest honest case in favour, the way a sharp friend who believes in it would explain it over chai. " +
      "If there are options, back the one with the most upside for this person. Do not argue the other side; someone else does that.",
    close: "Best when:",
    closeHint: "the situation where this is clearly the right call",
  },
  {
    seat: "against", role: "The case against", name: "The Critic",
    brief:
      "Your seat: THE CASE AGAINST. Give the strongest honest case against it: the ways this most often goes wrong, the hidden costs, " +
      "and what people in this spot usually underestimate. Realistic, not alarmist.",
    close: "Dealbreaker if:",
    closeHint: "the one thing that should stop them",
  },
  {
    seat: "improve", role: "How to improve it", name: "The Builder",
    brief:
      "Your seat: HOW TO IMPROVE IT. Do not pick a side. Make the decision safer or smarter: a better version, a middle path, or a cheap way to test it first. " +
      "Your points are next steps in order, each doable within weeks, with a sign that shows it is working.",
    close: "First move:",
    closeHint: "the one thing to do this week",
  },
];
// Questions about which politician or party is better, or who to vote for: Council lays out each side fairly and does not pick one.
const POLITICAL_SEATS = [
  {
    seat: "for", role: "What supporters say", name: "The supporters' case",
    brief:
      "Your seat: explain the strongest case that SUPPORTERS make, fairly and accurately, the way their most thoughtful advocates would put it. " +
      "Attribute it (\"supporters point to...\"). Stick to things that can be checked, like record, policies and track record. Do not add your own endorsement.",
    close: "Their strongest point:",
    closeHint: "the single argument supporters lean on most",
  },
  {
    seat: "against", role: "What critics say", name: "The critics' case",
    brief:
      "Your seat: explain the strongest case that CRITICS make, fairly and accurately, the way their most thoughtful voices would put it. " +
      "Attribute it (\"critics point to...\"). Stick to things that can be checked. Do not add your own verdict.",
    close: "Their strongest point:",
    closeHint: "the single argument critics lean on most",
  },
  {
    seat: "improve", role: "How to judge it yourself", name: "The guide",
    brief:
      "Your seat: do NOT take a side. Help the person decide for themselves: the questions worth asking, the evidence worth checking, " +
      "and which parts are matters of fact versus matters of values.",
    close: "Start with:",
    closeHint: "the one thing worth checking first",
  },
];
const POLITICAL_CUES = /\b(prime minister|chief minister|president(ial)?|election|elections|vote for|who (should|to) vote|voting for|bjp|congress party|aap\b|lok sabha|rajya sabha|modi|rahul gandhi|rahu gandhi|kejriwal|yogi adityanath|mamata|trump|biden|kamala|democrats?|republicans?|left[- ]wing|right[- ]wing)\b/i;

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nowIST() {
  return new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" });
}
function stripThink(t) {
  return String(t || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")            // an unclosed think block at the start
    .replace(/^\s*(final answer|answer)\s*:\s*/i, "")
    .trim();
}
function tidySeat(t) {
  return stripThink(t)
    .replace(/^\s*#{1,6}[^\n]*\n+/, "")                                   // a leading markdown heading
    .replace(/^\s*(\*\*)?\s*(the case (for|against)|how to improve it|the (advocate|critic|builder))\b[^\n]*\n+/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function looksLikeClassifier(s) {
  return /^(user|agent|assistant|prompt|response)?\s*safety\s*:/im.test(s) || /^\s*(safe|unsafe)\s*(\n|$)/i.test(s) || /^\s*S\d{1,2}\s*$/m.test(s);
}
// a reasoning model sometimes writes its private planning notes as the answer
const LEAK = /(here'?s (a|my) (thinking|thought) process|thinking process\s*:|(analy[sz]e|deconstruct|understand)(ing)? the (request|question|prompt)|\bthe (user|prompt|question) (is asking|wants|asks|says)\b|^\s*[*#-]*\s*\**(role|constraints|my seat|specific seat|format|task|goal)\**\s*:|\blet me (think|analy[sz]e|break (this|it) down|draft|start)\b|\bself[- ]correction\b|\bword count\b|\bdraft(ing)? (the |a |my )?(response|answer|bullets?)\b|\b(okay|ok|alright),? so (the user|i need)\b|\bi (need|should|will) (to )?(write|produce|draft|output|format)\b)/im;
function leaked(t) { return LEAK.test(String(t || "")); }
function bulletCount(t) { return (String(t || "").match(/^\s*[-*\u2022]\s+\S/gm) || []).length; }
function usableSeat(t) {
  const s = (t || "").trim();
  if (s.length < 120 || leaked(s)) return false;
  if (bulletCount(s) < 2) return false;                     // a cut-off or off-format reply
  if (looksLikeClassifier(s)) return false;
  if (/^\[?(error|request failed)/i.test(s)) return false;
  if (/\b(i('| a)m sorry|i can(no|')t (help|assist|provide)|as an ai( language model)?)\b/i.test(s) && s.length < 300) return false;
  return true;
}
function usableShort(t) {
  const s = (t || "").trim();
  return s.length >= 2 && !leaked(s) && !looksLikeClassifier(s) && !/^\[?(error|request failed)/i.test(s);
}
function usableQuick(t) {
  const s = (t || "").trim();
  return s.length >= 120 && !leaked(s) && !looksLikeClassifier(s) && !/^\[?(error|request failed)/i.test(s);
}
function parseJSON(t) {
  const s = stripThink(t).replace(/```(json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}


// One model call with a hard timeout. Never throws.
async function callAnthropic(m, prompt, { maxTokens, temperature, timeoutMs }) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const r = await fetch(PROVIDERS.anthropic.base + "/messages", { method: "POST", signal: ctrl.signal,
      headers: { "x-api-key": keyOf("anthropic"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: m.id, max_tokens: Math.max(maxTokens, 700), temperature, messages: [{ role: "user", content: prompt }] }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.type === "error") return { ok: false, status: r.status, error: data?.error?.message || `HTTP ${r.status}` };
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (data.stop_reason === "max_tokens") return { ok: false, error: "reply was cut off" };
    return { ok: !!text, text, servedModel: data.model || m.id, error: text ? "" : "empty reply" };
  } catch (e) { return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message }; }
  finally { clearTimeout(timer); }
}
async function call(m, prompt, opts = {}) {
  const o = { maxTokens: 600, temperature: 0.7, timeoutMs: ATTEMPT_TIMEOUT_MS, ...opts };
  if (!keyOf(m.p)) return { ok: false, error: "no key" };
  if (m.p === "anthropic") return callAnthropic(m, prompt, o);
  let r = await callOAI(m, prompt, o, true);
  // newer OpenAI models reject some optional settings: retry once without them
  if (!r.ok && r.status === 400 && /reasoning|temperature|unsupported|max_tokens/i.test(r.error || "")) r = await callOAI(m, prompt, o, false);
  return r;
}
async function callOAI(m, prompt, { maxTokens = 600, temperature = 0.7, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}, extras = true) {
  const P = PROVIDERS[m.p], key = keyOf(m.p);
  const body = { model: m.id, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature };
  if (/gpt-oss/.test(m.id)) {                               // reasoning model: keep thinking short, leave room for the answer
    body.reasoning_effort = "low"; body.max_tokens = Math.max(maxTokens, 1400);
    if (m.p === "groq") body.include_reasoning = false;
  }
  if (m.p === "groq" && /qwen/.test(m.id)) body.reasoning_effort = "none";
  if (m.p === "google") body.max_tokens = Math.max(maxTokens, 2048);   // Gemini Flash may think before answering
  if (m.p === "openai") {                                   // GPT-5/6 family: reasoning models, default temperature only
    delete body.max_tokens; delete body.temperature;
    body.max_completion_tokens = Math.max(maxTokens, 1600);
    if (extras) body.reasoning_effort = "low";
  }
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (m.p === "openrouter") {
    headers["HTTP-Referer"] = SITE_URL; headers["X-Title"] = "Council";
    body.reasoning = { exclude: true };                       // never return a model's thinking as its answer
    body.max_tokens = Math.max(maxTokens, 1500);              // room to think and still finish the answer
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const r = await fetch(P.base + "/chat/completions", { method: "POST", signal: ctrl.signal, headers, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    const err = Array.isArray(data) ? data[0]?.error : data.error;
    if (!r.ok || err) return { ok: false, status: r.status || err?.code, error: err?.message || `HTTP ${r.status}` };
    const text = (data?.choices?.[0]?.message?.content || "").trim();
    if (data?.choices?.[0]?.finish_reason === "length") return { ok: false, error: "reply was cut off" };
    return { ok: !!text, text, servedModel: String(data.model || m.id).replace(/^models\//, ""), error: text ? "" : "empty reply" };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Try a chain of models until one gives a usable answer. If the current one is slow,
// start the next in parallel and take whichever usable answer lands first.
function firstGood(chain, prompt, { deadline, validate, clean = (x) => x, maxTokens, temperature }) {
  return new Promise((resolve) => {
    let i = 0, inFlight = 0, done = false, lastErr = "", rateLimited = false, backup = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(backup); clearTimeout(kill); resolve(v); };
    const kill = setTimeout(() => finish({ ok: false, error: lastErr || "timed out", rateLimited }), Math.max(0, deadline - Date.now()));
    const launch = () => {
      if (done) return;
      const left = deadline - Date.now();
      if (i >= chain.length || left < 2500) {
        if (inFlight === 0) finish({ ok: false, error: lastErr || "no model answered", rateLimited });
        return;
      }
      const m = chain[i++];
      inFlight++;
      call(m, prompt, { maxTokens, temperature, timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, left - 300) }).then((r) => {
        inFlight--;
        if (done) return;
        const text = r.ok ? clean(r.text) : "";
        if (r.ok && validate(text)) {
          const modelId = r.servedModel || m.id;
          return finish({ ok: true, text, modelId, provider: PROVIDERS[m.p].label, lab: labOf(modelId), model: display(modelId), chainId: m.p + ":" + m.id });
        }
        lastErr = r.ok ? "unusable reply" : r.error;
        if (r.status === 429) rateLimited = true;
        launch();
      });
      clearTimeout(backup);
      backup = setTimeout(() => { if (!done && inFlight < 2) launch(); }, BACKUP_AFTER_MS);
    };
    launch();
  });
}

// ---------------------------------------------------------------- OpenRouter free models (optional extra fallback)
// ---------------------------------------------------------------- free model discovery
let freeCache = { at: 0, list: [] };
const NOT_CHAT = /(guard|safety|shield|moderat|embed|rerank|whisper|tts|speech|audio|ocr|classif|reward|coder|-vl\b|vision)/i;
function cleanName(name, id) {
  let s = String(name || id).replace(/\s*\(free\)\s*/i, "").trim();
  if (s.includes(": ")) s = s.split(": ").slice(1).join(": ");
  return s.replace(/[\s-](instruct|it|chat)$/i, "").trim();
}
function scoreModel(m) {
  const id = m.id.toLowerCase();
  const sizes = [...id.matchAll(/(\d+(?:\.\d+)?)b\b/g)].map((x) => parseFloat(x[1]));
  const size = sizes.length ? Math.max(...sizes) : 0;
  let s = size ? Math.min(42, Math.log2(size) * 6) : 20;
  if (/(deepseek|llama-3\.3|llama-4|qwen3|qwen-3|gpt-oss|kimi|glm-4|gemma-3|mistral-(small|medium|large)|nemotron|hermes)/.test(id)) s += 12;
  if (/(^|[-/])(r1|reasoning|thinking)\b/.test(id)) s -= 20;           // slow, and tends to print its reasoning
  if (/\b(1|2|3)b\b|mini|nano|tiny/.test(id)) s -= 8;
  if ((m.context_length || 0) >= 32000) s += 4;
  return s;
}
async function freeModels() {
  if (Date.now() - freeCache.at < 30 * 60 * 1000 && freeCache.list.length) return freeCache.list;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(OR_MODELS, { signal: ctrl.signal });
    clearTimeout(t);
    const d = await r.json();
    const list = (d.data || [])
      .filter((m) => {
        const id = String(m.id || "");
        if (!id || id.startsWith("openrouter/")) return false;
        const free = id.endsWith(":free") || (Number(m?.pricing?.prompt) === 0 && Number(m?.pricing?.completion) === 0);
        const outs = m?.architecture?.output_modalities;
        const textOut = Array.isArray(outs) ? outs.includes("text") : /->\s*text/.test(String(m?.architecture?.modality || "text->text"));
        return free && textOut && !NOT_CHAT.test(id + " " + (m.name || ""));
      })
      .sort((a, b) => scoreModel(b) - scoreModel(a))
      .map((m) => ({ id: m.id, name: cleanName(m.name, m.id) }));
    if (list.length) freeCache = { at: Date.now(), list };
  } catch { /* fall through to the router below */ }
  return freeCache.list;
}

// Build a chain per seat so the three seats start on three different models.

const ROUTER = { p: "openrouter", id: "openrouter/free" };
function uniqC(arr) { const s = new Set(); return arr.filter((m) => m && !s.has(m.p + ":" + m.id) && s.add(m.p + ":" + m.id)); }
async function orFallback() {
  if (!keyOf("openrouter")) return [];
  const free = (await freeModels()).slice(0, 4).map((m) => ({ p: "openrouter", id: m.id }));
  return free.concat([ROUTER]);
}
// The chain for one seat: its own family first, then the other families, then OpenRouter.
async function chainFor(seat, avoid = [], allowPaid = true) {
  const fams = {};
  await Promise.all(FALLBACK_ORDER.map(async (f) => { fams[f] = await family(f); }));
  const own = SEAT_FAMILY[seat];
  // backups: labs no other panel seat is using come first, so a failed seat still keeps the panel diverse
  const otherLabs = ["for", "against", "improve"].filter((x) => x !== seat).map((x) => FAM_LAB[SEAT_FAMILY[x]]);
  const rest = FALLBACK_ORDER.filter((f) => f !== own).sort((a, b) => otherLabs.includes(FAM_LAB[a]) - otherLabs.includes(FAM_LAB[b]));
  let chain = fams[own].concat(...rest.map((f) => fams[f]));
  if (avoid.length) chain = chain.filter((m) => !avoid.includes(m.p + ":" + m.id)).concat(chain.filter((m) => avoid.includes(m.p + ":" + m.id)));
  if (!allowPaid) chain = chain.filter((m) => !PAID.has(m.p));
  return uniqC(chain.concat(await orFallback()));
}
function anyProvider() { return Object.keys(PROVIDERS).some((p) => keyOf(p)); }
// what each seat will run on, judged only by which keys exist (shown in the ask box on the site)
function plannedPanel() {
  return ["for", "against", "improve", "chair"].map((seat) => {
    const own = SEAT_FAMILY[seat];
    const otherLabs = ["for", "against", "improve"].filter((x) => x !== seat).map((x) => FAM_LAB[SEAT_FAMILY[x]]);
    const order = [own].concat(FALLBACK_ORDER.filter((f) => f !== own).sort((a, b) => otherLabs.includes(FAM_LAB[a]) - otherLabs.includes(FAM_LAB[b])));
    for (const f of order) {
      if (seat === "chair" && ["gpt", "claude"].includes(f)) continue;     // the chairman runs on a free model
      const hit = FAMILIES[f].find(([p]) => keyOf(p));
      if (hit) return { seat, model: FAM_NAME[f], lab: FAM_LAB[f], provider: PROVIDERS[hit[0]].label, main: f === own };
    }
    return { seat, model: "", lab: "", provider: "", main: false };
  });
}

// ---------------------------------------------------------------- the gate
const JUDGMENT_CUES = /\b(should (i|we|my)|shall i|is it (worth|better|smart|wise|a good idea|okay|ok)|which (is|one|should|would)|what do you think|would you|better to|pros and cons|or not|worth it|do you recommend|good idea|how should|what should|could i|can i afford)\b|\bvs\.?\b|\bversus\b/i;

async function classify(question, chain, deadline) {
  if (POLITICAL_CUES.test(question)) return "political";
  if (JUDGMENT_CUES.test(question)) return "judgment";
  const r = await firstGood(chain.slice(0, 3),
    `Classify this question.\n\nQuestion: "${question}"\n\n` +
      `"fact" = it has ONE objectively correct answer that is the same no matter who you ask (dates, definitions, capitals, maths, "who won X", "what is Y", today's date). ` +
      `"political" = which politician, party or candidate is better, who to vote for, or a hot-button political controversy where people disagree on values. ` +
      `"judgment" = advice, a decision, an opinion, a prediction or a trade-off with no single correct answer. If it is borderline between fact and judgment, choose "judgment".\n\n` +
      `Reply with ONLY this JSON: {"kind":"fact"} or {"kind":"political"} or {"kind":"judgment"}`,
    { deadline, validate: (t) => { const p = parseJSON(t); return !!(p && ["fact", "judgment", "political"].includes(p.kind)); }, maxTokens: 30, temperature: 0 });
  const p = r.ok ? parseJSON(r.text) : null;
  return p && (p.kind === "fact" || p.kind === "political") ? p.kind : "judgment";
}

// ---------------------------------------------------------------- abuse protection
const RATE_PER_HOUR = +process.env.RATE_PER_HOUR || 8;
const RATE_PER_DAY = +process.env.RATE_PER_DAY || 25;
const GLOBAL_PER_DAY = +process.env.GLOBAL_PER_DAY || 600;
const PAID_PER_DAY = process.env.PAID_PER_DAY === undefined ? 150 : +process.env.PAID_PER_DAY;   // debates a day that may use GPT/Claude
const mem = new Map();
function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}
async function countUp(keys) {     // returns the new counts, shared across instances if Upstash is configured
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    try {
      const cmds = []; keys.forEach(([k, ttl]) => { cmds.push(["INCR", k]); cmds.push(["EXPIRE", k, String(ttl)]); });
      const r = await fetch(url.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
      const d = await r.json();
      if (Array.isArray(d)) return keys.map((_, i) => Number(d[i * 2]?.result) || 0);
    } catch { /* fall back to memory */ }
  }
  const now = Date.now();
  return keys.map(([k, ttl]) => {
    const e = mem.get(k);
    if (!e || e.until < now) { mem.set(k, { n: 1, until: now + ttl * 1000 }); return 1; }
    e.n++; return e.n;
  });
}
async function rateCheck(req) {
  const salt = process.env.RL_SALT || "council";
  const who = crypto.createHash("sha256").update(salt + clientIp(req)).digest("hex").slice(0, 24);   // no raw IPs stored
  const hour = Math.floor(Date.now() / 3600000), day = Math.floor(Date.now() / 86400000);
  const [h, d, g] = await countUp([[`rl:h:${who}:${hour}`, 3700], [`rl:d:${who}:${day}`, 90000], [`rl:g:${day}`, 90000]]);
  if (g > GLOBAL_PER_DAY) return "The council has answered its full share of questions for today. It resets at midnight UTC.";
  if (d > RATE_PER_DAY) return `You've asked ${RATE_PER_DAY} questions today, the free daily limit. Come back tomorrow.`;
  if (h > RATE_PER_HOUR) return `You've asked ${RATE_PER_HOUR} questions this hour. Take a breather and try again in a little while.`;
  return "";
}
function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;                                  // non-browser callers are still rate-limited
  const extra = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [SITE_URL, ...extra].includes(o) || /^https:\/\/ai-council[\w-]*\.vercel\.app$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
const receiptOf = (role, r) => (r && r.ok ? { role, modelId: r.modelId, provider: r.provider, lab: r.lab } : null);

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  if (req.method === "GET") {
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ panel: plannedPanel() });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!originAllowed(req)) return res.status(403).json({ error: "This API only answers the Council website." });
  if (!anyProvider()) return res.status(500).json({ error: "No model providers are configured. Add at least one API key (for example GROQ_API_KEY) in Vercel, then redeploy." });

  const body = req.body || {};
  const question = String(body.question || "").trim().slice(0, 2000);
  if (!question) return res.status(400).json({ error: "Type a question first." });
  const limitMsg = await rateCheck(req);
  if (limitMsg) return res.status(429).json({ error: limitMsg });
  const mode = body.mode === "quick" ? "quick" : "debate";
  // follow-ups: the browser sends the last few turns so the council keeps the thread
  const history = (Array.isArray(body.history) ? body.history : []).slice(-4)
    .map((h) => ({ q: String(h?.q || "").trim().slice(0, 500), a: String(h?.a || "").trim().slice(0, 700) })).filter((h) => h.q);
  const thread = history.length
    ? `\n\nEarlier in this conversation (the person is following up, so answer their new message in that light, and use anything they told you about their situation):\n` +
      history.map((h, i) => `Message ${i + 1}: ${h.q}\nCouncil's answer: ${h.a || "(none)"}`).join("\n") + `\n`
    : "";
  const label = history.length ? "New message" : "Question";

  const start = Date.now();
  const ctx = `Today is ${nowIST()} (India time). If you do not actually know something, say so plainly instead of guessing.` + thread;
  const style =
    `Sound like a thoughtful, well-informed friend talking to them, not like an AI or a consultant. Warm, direct, everyday words, short sentences, and "you". ` +
    `No jargon or business-speak (never words like leverage, unlock, synergy, robust, holistic, paradigm). ` +
    `No preamble, do not restate the question, no generic disclaimers, never mention being an AI, never show your reasoning or notes. ` +
    `Be specific to their situation. If a key detail is missing, make the most sensible assumption and say it in a few words. ` +
    `Reply in the same language they wrote in (Hindi or Hinglish gets Hindi or Hinglish). Do not refuse an ordinary decision question.`;

  try {
    // GPT and Claude cost money: only use them while today's budget lasts, and never for the gate or facts
    let allowPaid = [...PAID].some((p) => keyOf(p));
    const [cChair, cFree] = await Promise.all([chainFor("chair", [], false), chainFor("for", [], false)]);

    // 0 ── the gate
    const gateText = history.length ? `${history[history.length - 1].q} / follow-up: ${question}` : question;
    const kind = await classify(gateText, cChair, start + 9000);
    const political = kind === "political";
    const seats = political ? POLITICAL_SEATS : SEATS;
    if (kind !== "fact" && allowPaid) {
      const [n] = await countUp([[`paid:${Math.floor(Date.now() / 86400000)}`, 90000]]);
      if (n > PAID_PER_DAY) allowPaid = false;
    }
    const [cFor, cAgainst, cImprove] = await Promise.all(["for", "against", "improve"].map((x) => chainFor(x, [], allowPaid)));
    if (kind === "fact") {
      const f = await firstGood(cFree, `${ctx}\n\n${label}: "${question}"\n\nThis has a single correct answer. Give it in one or two short, plain sentences, like a friend who knows. No preamble. If you genuinely do not know, say so in one sentence.`,
        { deadline: start + 30000, validate: usableShort, clean: stripThink, maxTokens: 120, temperature: 0.2 });
      if (!f.ok) return res.status(f.rateLimited ? 429 : 502).json({ error: f.rateLimited ? LIMIT_MSG : "The council could not answer that one. Ask again in a moment." });
      return res.status(200).json({ kind: "fact", factAnswer: f.text,
        nudge: "That one has a single right answer, so it gets one line instead of a debate. Bring the council a decision next time.",
        receipt: [receiptOf("Fact answer", f)] });
    }

    // quick take ── one model
    if (mode === "quick") {
      const q = await firstGood(cFor,
        `${ctx}\n\n${style}\n\n${label}: "${question}"\n\n` +
          (political
            ? `This is a political question where people disagree on values. Do not pick a side or say who is better. In 4 to 6 sentences, say fairly what supporters and critics each point to, and what the person should weigh to decide for themselves. End with a line starting "Bottom line:".`
            : `Give a quick, decisive take in 4 to 6 sentences: start with your answer in one plain sentence, then the main reason, the biggest risk, and the first step. End with a line starting "Bottom line:".`),
        { deadline: start + 40000, validate: usableQuick, clean: tidySeat, maxTokens: 450, temperature: 0.6 });
      if (!q.ok) return res.status(q.rateLimited ? 429 : 502).json({ error: q.rateLimited ? LIMIT_MSG : "No model answered in time. Ask again in a moment." });
      return res.status(200).json({ kind: "quick", political, answer: q.text, model: q.model, receipt: [receiptOf("Quick take", q)] });
    }

    // 1 ── three seats, in parallel, never seeing each other, each from a different lab when possible
    const chainsBySeat = { for: cFor, against: cAgainst, improve: cImprove };
    const results = await Promise.all(seats.map((s) =>
      firstGood(chainsBySeat[s.seat],
        `You are one member of Council: a few advisers who each look at a hard question from one side before a chairman sums up.\n${ctx}\n\n${style}\n\n` +
          `${label}: "${question}"\n\n${s.brief}\n\n` +
          `Write it like this, and output only this:\n` +
          `1. One or two plain sentences with your honest take, as you would say it out loud.\n` +
          `2. Exactly three short points, each on its own line starting with "- ", one or two sentences each, about their actual situation.\n` +
          `3. One last line that starts with "${s.close}" giving ${s.closeHint}.\n` +
          `About 100 to 160 words in total. No headings, no bold labels at the start of points.`,
        { deadline: start + SEATS_DONE_BY_MS, validate: usableSeat, clean: tidySeat, maxTokens: 500, temperature: 0.7 })
    ));
    const members = seats.map((s, i) => {
      const r = results[i];
      return { seat: s.seat, role: s.role, name: s.name, ok: r.ok,
        model: r.ok ? r.model : "", modelId: r.ok ? r.modelId : "", provider: r.ok ? r.provider : "", lab: r.ok ? r.lab : "",
        answer: r.ok ? r.text : "This seat did not get a usable answer in time, so the verdict is built from the other two." };
    });
    const answered = members.filter((m) => m.ok);
    if (answered.length === 0) {
      const limited = results.some((r) => r.rateLimited);
      return res.status(limited ? 429 : 502).json({ error: limited ? LIMIT_MSG : "None of the models answered in time. Ask again in a moment." });
    }

    // 2 ── the chairman, kept off the models it is judging
    const used = results.filter((r) => r.ok).map((r) => r.chainId);
    const chairChain = (await chainFor("chair", used, false));
    const block = answered.map((m) => `${m.role.toUpperCase()} (${m.name}):\n${m.answer}`).join("\n\n");
    const voice = `Write every text field the way a wise friend would say it out loud: warm, plain, everyday words, short sentences, "you". No jargon, no hedging boilerplate, never mention being an AI. Use the language the person wrote in.`;
    const chairPrompt = political
      ? `You are the chairman of Council. Members laid out a political question from assigned seats, independently.\n${ctx}\n\n${voice}\n\n` +
        `${label}: "${question}"\n\n${block}\n\n` +
        `This is a question about politicians, parties or a political controversy where people disagree on values. Do NOT pick a side, rank the people, or say who is better or who to vote for: that is the person's own call. ` +
        `Help them decide well instead: be fair to both sides and separate checkable facts from values.\n\n` +
        `Reply with ONLY a JSON object, no code fences:\n` +
        `{"strongest":"improve","shortAnswer":"one or two plain sentences saying honestly that this comes down to what they value most, and naming the two or three things at stake",` +
        `"finalAnswer":"three to five sentences: what each side's case rests on, which parts are facts they can check and which are values, and how to weigh them",` +
        `"split":"one sentence on the core disagreement between supporters and critics","whyListen":"",` +
        `"askBack":["up to two short questions back to the person about what matters most to them, which would help them think it through"]}`
      : `You are the chairman of Council. Members answered this question from assigned seats, independently, without seeing each other.\n${ctx}\n\n${voice}\n\n` +
        `${label}: "${question}"\n\n${block}\n\n` +
        `Your job: decide which seat made the strongest, best-supported case for this person's actual situation; name the real disagreement; ` +
        `then give the verdict. Commit to an answer. If it truly depends on one thing, name that thing and say what to do in each case.\n\n` +
        `Reply with ONLY a JSON object, no code fences:\n` +
        `{"strongest":"for" or "against" or "improve","shortAnswer":"the simple answer in one or two plain sentences, the way you'd tell a friend",` +
        `"finalAnswer":"the detailed answer in three to five sentences: what to do, the main reason, the biggest risk to watch, and the first step",` +
        `"whyListen":"one or two sentences on why that seat's reasoning deserves the most weight","split":"one sentence naming where the members disagree",` +
        `"confidence":"high" or "medium" or "low",` +
        `"askBack":["up to two short, specific questions back to the person whose answers would most change this verdict (for example their savings, timeline or constraints). Empty list if nothing important is missing."]}`;
    const ch = await firstGood(chairChain, chairPrompt, {
      deadline: start + ALL_DONE_BY_MS,
      validate: (t) => { const p = parseJSON(t); return !!(p && typeof p.finalAnswer === "string" && p.finalAnswer.length > 20 && !leaked(p.finalAnswer)); },
      maxTokens: 800, temperature: 0.3,
    });
    const p = ch.ok ? parseJSON(ch.text) : null;
    const seatOf = (k) => seats.find((s) => s.seat === k) || null;
    const firstSentences = (t) => (String(t).match(/^[\s\S]*?[.!?](\s|$)/) || [String(t)])[0].trim();
    const askBack = p && Array.isArray(p.askBack) ? p.askBack.map((x) => String(x || "").trim()).filter((x) => x.length > 5 && x.length < 200).slice(0, 2) : [];
    const strongestSeat = p && seatOf(p.strongest) && members.find((m) => m.seat === p.strongest && m.ok) ? p.strongest : answered[0].seat;
    const meta = ch.ok ? { model: ch.model, modelId: ch.modelId, provider: ch.provider, lab: ch.lab } : { model: "", modelId: "", provider: "", lab: "" };
    const chairman = p
      ? { strongest: seatOf(strongestSeat).role, strongestSeat, whyListen: political ? "" : String(p.whyListen || ""), split: String(p.split || ""),
          shortAnswer: String(p.shortAnswer || "").trim() || firstSentences(p.finalAnswer), finalAnswer: String(p.finalAnswer), askBack,
          confidence: !political && ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "", ...meta }
      : { strongest: seatOf(strongestSeat).role, strongestSeat, whyListen: "", split: "", confidence: political ? "" : "low", shortAnswer: "", askBack: [], ...meta,
          finalAnswer: "The chairman did not return a verdict in time. Read the three cases above: where they agree is solid ground, and where they split is the real decision." };

    const receipt = seats.map((s, i) => receiptOf(s.role, results[i])).concat([receiptOf("Chairman", ch)]).filter(Boolean);
    return res.status(200).json({ kind: "judgment", political, members, chairman, receipt,
      verificationText: "Fact-checking against outside sources is not switched on in the free preview yet." });
  } catch (e) {
    return res.status(500).json({ error: "The council hit an error: " + e.message });
  }
}
