// api/council.js — Council backend, v3
//
// What changed from v2, and why:
//  • Fixed seats. Every judgment question gets the same three: The case for, The case against,
//    How to improve it. (v2 let a model invent roles, which is how "Double-checks the facts" appeared.)
//  • Every seat must actually answer. v2 sent all three seats to "openrouter/free", which sometimes
//    routes to a safety classifier (that is where "User Safety: safe" came from) or returns nothing.
//    v3 finds real chat models on OpenRouter's free list, rejects classifier or empty replies,
//    retries on a different model, and starts a backup model if one is slow.
//  • Better answers: each seat gets a focused brief and a fixed format; the chairman must commit,
//    name the disagreement and give a confidence level.
//  • Quick take mode, the fact gate, and paid mode with an auto-picked frontier panel.
//
// Response contract (the site reads these fields):
//  { error }                                         — something went wrong, show the message
//  { kind:"fact", factAnswer, nudge }
//  { kind:"quick", answer, model }
//  { kind:"judgment", category, members:[{seat,role,name,model,answer,ok}], chairman:{strongest,
//    strongestSeat, whyListen, split, finalAnswer, confidence, model}, verificationText }

// ======================= SETTINGS =======================
// "free": open models from OpenRouter's free list. No credit needed.
// "paid": the named frontier panel (auto-picked by question type) + fact-checking. Needs credit.
// Set COUNCIL_MODE in Vercel → Settings → Environment Variables, or change the default here.
const MODE = (process.env.COUNCIL_MODE || "free").toLowerCase();
const SITE_URL = process.env.SITE_URL || "https://ai-council.vercel.app";

// Vercel stops the function at 60s (vercel.json). These keep us inside it.
const SEATS_DONE_BY_MS = 38000;   // seats must finish by here so the chairman has time
const ALL_DONE_BY_MS = 55000;
const ATTEMPT_TIMEOUT_MS = 22000; // one model call
const BACKUP_AFTER_MS = 13000;    // start a second model if the first is this slow

// Paid mode: model names shown on the site → OpenRouter slugs.
// ⚠ Slugs change often. Check each one at https://openrouter.ai/models before switching to paid.
const PAID_SLUGS = {
  "GPT-6 Astra": "openai/gpt-6-astra",
  "GPT-5.6 Sol": "openai/gpt-5.6-sol",
  "Claude Opus 5.5": "anthropic/claude-opus-5.5",
  "Gemini 3 Pro": "google/gemini-3-pro",
  "DeepSeek V4 Pro": "deepseek/deepseek-v4-pro",
  "Grok 4.3": "x-ai/grok-4.3",
  "Mistral Large 3": "mistralai/mistral-large-3",
  "Qwen3.8-Max": "qwen/qwen3.8-max",
  "Llama 4 Maverick": "meta-llama/llama-4-maverick",
  "Kimi K2": "moonshotai/kimi-k2",
};

// Question types → default panel. Keep in sync with ROUTES in the site's pages.
const ROUTES = {
  news:     { panel: ["Grok 4.3", "Gemini 3 Pro", "GPT-5.6 Sol"], chair: "Claude Opus 5.5" },
  money:    { panel: ["GPT-5.6 Sol", "DeepSeek V4 Pro", "Gemini 3 Pro"], chair: "Claude Opus 5.5" },
  career:   { panel: ["GPT-5.6 Sol", "Claude Opus 5.5", "Gemini 3 Pro"], chair: "GPT-6 Astra" },
  business: { panel: ["GPT-5.6 Sol", "Claude Opus 5.5", "GPT-6 Astra"], chair: "Gemini 3 Pro" },
  tech:     { panel: ["Qwen3.8-Max", "Claude Opus 5.5", "GPT-6 Astra"], chair: "GPT-5.6 Sol" },
  research: { panel: ["Gemini 3 Pro", "Claude Opus 5.5", "Kimi K2"], chair: "GPT-5.6 Sol" },
  writing:  { panel: ["Claude Opus 5.5", "GPT-5.6 Sol", "Mistral Large 3"], chair: "Gemini 3 Pro" },
  general:  { panel: ["GPT-5.6 Sol", "Claude Opus 5.5", "Gemini 3 Pro"], chair: "DeepSeek V4 Pro" },
};
// =========================================================

const OR_CHAT = "https://openrouter.ai/api/v1/chat/completions";
const LIMIT_MSG = "The free council has used up its model quota for now. Try again in a few minutes, or later today.";
const OR_MODELS = "https://openrouter.ai/api/v1/models";

const SEATS = [
  {
    seat: "for", role: "The case for", name: "The Advocate",
    brief:
      "Your seat: THE CASE FOR. Make the strongest honest case in favour. If the question offers options, argue for the one with the most upside for this person. " +
      "Give three concrete reasons, each tied to their situation and naming the real upside it unlocks. Do not argue the other side; another member does that.",
    close: "Best when:",
    closeHint: "the conditions under which this is clearly the right call",
  },
  {
    seat: "against", role: "The case against", name: "The Critic",
    brief:
      "Your seat: THE CASE AGAINST. Make the strongest honest case against it. Give the three most likely ways this goes wrong or costs more than expected: " +
      "failure modes, hidden costs, blind spots, what people in this position usually underestimate. Be specific and realistic, not alarmist.",
    close: "Dealbreaker if:",
    closeHint: "the one condition that should stop them",
  },
  {
    seat: "improve", role: "How to improve it", name: "The Builder",
    brief:
      "Your seat: HOW TO IMPROVE IT. Do not pick a side. Make the idea better or the decision safer: a smarter version, a middle path, or a cheap way to test it before committing. " +
      "Give three concrete next steps in order, each doable within weeks, each with a signal that shows whether it is working.",
    close: "First move:",
    closeHint: "the single thing to do this week",
  },
];

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
function usableSeat(t) {
  const s = (t || "").trim();
  if (s.length < 120) return false;
  if (looksLikeClassifier(s)) return false;
  if (/^\[?(error|request failed)/i.test(s)) return false;
  if (/\b(i('| a)m sorry|i can(no|')t (help|assist|provide)|as an ai( language model)?)\b/i.test(s) && s.length < 300) return false;
  return true;
}
function usableShort(t) {
  const s = (t || "").trim();
  return s.length >= 2 && !looksLikeClassifier(s) && !/^\[?(error|request failed)/i.test(s);
}
function parseJSON(t) {
  const s = stripThink(t).replace(/```(json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// One model call with a hard timeout. Never throws.
async function call(model, prompt, key, { maxTokens = 600, temperature = 0.7, timeoutMs = ATTEMPT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const r = await fetch(OR_CHAT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": SITE_URL,
        "X-Title": "Council",
      },
      // one user message: some free models reject a separate system message
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      return { ok: false, status: r.status || data?.error?.code, error: data?.error?.message || `HTTP ${r.status}` };
    }
    const text = (data?.choices?.[0]?.message?.content || "").trim();
    return { ok: !!text, text, error: text ? "" : "empty reply" };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Try a chain of models until one gives a usable answer. If the current one is slow,
// start the next in parallel and take whichever usable answer lands first.
function firstGood(chain, prompt, key, { deadline, validate, clean = (x) => x, maxTokens, temperature }) {
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
      call(m.id, prompt, key, { maxTokens, temperature, timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, left - 300) }).then((r) => {
        inFlight--;
        if (done) return;
        const text = r.ok ? clean(r.text) : "";
        if (r.ok && validate(text)) return finish({ ok: true, text, model: m.name, id: m.id });
        lastErr = r.ok ? "unusable reply" : r.error;
        if (r.status === 429) rateLimited = true;
        launch(); // failed or unusable: move straight to the next model
      });
      clearTimeout(backup);
      backup = setTimeout(() => { if (!done && inFlight < 2) launch(); }, BACKUP_AFTER_MS);
    };
    launch();
  });
}

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
  if (/(^|[-/])(r1|reasoning|thinking)\b/.test(id)) s -= 5;            // slow and wordy for this job
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
const ROUTER = { id: "openrouter/free", name: "an open model" };

// Build a chain per seat so the three seats start on three different models.
async function chains(category, panelNames) {
  if (MODE === "paid") {
    const route = ROUTES[category] || ROUTES.general;
    const names = Array.isArray(panelNames) && panelNames.length === 3 && panelNames.every((n) => PAID_SLUGS[n]) ? panelNames : route.panel;
    const free = await freeModels();
    const backups = free.slice(0, 4).concat([ROUTER]);
    const seat = names.map((n) => [{ id: PAID_SLUGS[n], name: n }].concat(backups));
    const chairName = names.includes(route.chair) ? Object.keys(PAID_SLUGS).find((n) => !names.includes(n)) : route.chair;
    return { seat, chair: [{ id: PAID_SLUGS[chairName], name: chairName }].concat(backups), quick: seat[0], free };
  }
  const free = (await freeModels()).slice(0, 9);
  const pick = (start) => {
    const c = [];
    for (let k = 0; k < free.length; k++) c.push(free[(start + k * 3) % free.length]);
    return uniq(c).concat([ROUTER, ROUTER]);
  };
  const seat = free.length ? [pick(0), pick(1), pick(2)] : [[ROUTER, ROUTER, ROUTER], [ROUTER, ROUTER, ROUTER], [ROUTER, ROUTER, ROUTER]];
  // the chairman should not be one of the models it is judging, when we have enough to choose from
  const chair = free.length > 3 ? uniq([free[3], free[0], free[4] || free[1]].filter(Boolean)).concat([ROUTER]) : seat[0];
  return { seat, chair, quick: seat[0], free };
}
function uniq(arr) { const s = new Set(); return arr.filter((m) => m && !s.has(m.id) && s.add(m.id)); }

// ---------------------------------------------------------------- the gate
const JUDGMENT_CUES = /\b(should (i|we|my)|shall i|is it (worth|better|smart|wise|a good idea|okay|ok)|which (is|one|should|would)|what do you think|would you|better to|pros and cons|or not|worth it|do you recommend|good idea|how should|what should|could i|can i afford)\b|\bvs\.?\b|\bversus\b/i;
async function classify(question, key, chain, deadline) {
  if (JUDGMENT_CUES.test(question)) return "judgment";
  const r = await firstGood(chain.slice(0, 3), 
    `Classify this question.\n\nQuestion: "${question}"\n\n` +
      `"fact" = it has ONE objectively correct answer that is the same no matter who you ask (dates, definitions, capitals, maths, "who won X", "what is Y", today's date). ` +
      `"judgment" = advice, a decision, an opinion, a prediction or a trade-off with no single correct answer. If it is borderline, choose "judgment".\n\n` +
      `Reply with ONLY this JSON: {"kind":"fact"} or {"kind":"judgment"}`,
    key, { deadline, validate: (t) => { const p = parseJSON(t); return !!(p && (p.kind === "fact" || p.kind === "judgment")); }, maxTokens: 30, temperature: 0 });
  const p = r.ok ? parseJSON(r.text) : null;
  return p && p.kind === "fact" ? "fact" : "judgment";
}

// ---------------------------------------------------------------- paid-mode verification (Wikipedia)
async function wikiSearch(term) {
  try {
    const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&srlimit=1`;
    const d = await (await fetch(u, { headers: { "User-Agent": "council-app/1.0" } })).json();
    return d?.query?.search?.[0]?.title || null;
  } catch { return null; }
}
async function wikiSummary(title) {
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, { headers: { "User-Agent": "council-app/1.0" } });
    if (!r.ok) return null;
    const d = await r.json();
    return d.extract ? { extract: d.extract, url: d?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` } : null;
  } catch { return null; }
}
async function verify(question, answer, key, chain, deadline) {
  const a = await firstGood(chain, `Question: ${question}\n\nAnswer: ${answer}\n\nIf this answer makes a specific factual claim that an encyclopedia could check, reply ONLY {"checkable":true,"topic":"best Wikipedia article title","claim":"the claim in one sentence"}. Otherwise reply ONLY {"checkable":false}.`,
    key, { deadline, validate: (t) => !!parseJSON(t), maxTokens: 120, temperature: 0 });
  const p = a.ok ? parseJSON(a.text) : null;
  if (!p || !p.checkable || !p.topic) return "Not something an encyclopedia can check, so treat it as reasoning rather than verified fact.";
  const title = await wikiSearch(p.topic);
  const sum = title && (await wikiSummary(title));
  if (!sum) return "No reliable outside source found for the key claim.";
  const b = await firstGood(chain, `Claim: ${p.claim}\n\nSource (Wikipedia, ${title}):\n${sum.extract}\n\nDoes the source support, contradict, or not address the claim? Only say contradicted if it clearly disagrees. Reply ONLY {"result":"supported"|"contradicted"|"not_addressed"}`,
    key, { deadline, validate: (t) => !!parseJSON(t), maxTokens: 40, temperature: 0 });
  const res = (b.ok && parseJSON(b.text)?.result) || "not_addressed";
  const label = { supported: "Checked: supported by", contradicted: "Checked: contradicted by", not_addressed: "Checked: not confirmed by" }[res] || "Checked against";
  return `${label} Wikipedia (${title}). ${sum.url}`;
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "The server is missing OPENROUTER_API_KEY. Add it in Vercel, then redeploy." });

  const body = req.body || {};
  const question = String(body.question || "").trim().slice(0, 2000);
  if (!question) return res.status(400).json({ error: "Type a question first." });
  const mode = body.mode === "quick" ? "quick" : "debate";
  const category = ROUTES[body.category] ? body.category : "general";

  const start = Date.now();
  const ctx = `Today is ${nowIST()} (India time). If you do not actually know something, say so plainly instead of guessing.`;
  const style =
    `Write for a smart person making a real decision: specific, concrete, plain English. ` +
    `No preamble, do not restate the question, no generic disclaimers, never say "as an AI". ` +
    `If key details are missing, make the most reasonable assumption and state it in a few words. ` +
    `Do not refuse an ordinary decision question.`;

  try {
    const c = await chains(category, body.panel);

    // 0 ── the gate
    const kind = await classify(question, key, c.chair, start + 9000);
    if (kind === "fact") {
      const f = await firstGood(c.quick, `${ctx}\n\nQuestion: "${question}"\n\nThis has a single correct answer. Give it in ONE short sentence. No preamble. If you genuinely do not know, say so in one sentence.`,
        key, { deadline: start + 30000, validate: usableShort, clean: stripThink, maxTokens: 120, temperature: 0.2 });
      if (!f.ok) return res.status(f.rateLimited ? 429 : 502).json({ error: f.rateLimited ? LIMIT_MSG : "The council could not answer that one. Ask again in a moment." });
      return res.status(200).json({
        kind: "fact",
        factAnswer: f.text,
        nudge: "That one has a single right answer, so it gets one line instead of a debate. Bring the council a decision next time.",
      });
    }

    // quick take ── one model, balanced and decisive
    if (mode === "quick") {
      const q = await firstGood(c.quick,
        `${ctx}\n\n${style}\n\nQuestion: "${question}"\n\nGive a quick, decisive take in 4 to 6 sentences: your recommendation, the strongest reason for it, the biggest risk, and the first step. End with a line starting "Bottom line:".`,
        key, { deadline: start + 40000, validate: usableSeat, clean: tidySeat, maxTokens: 400, temperature: 0.6 });
      if (!q.ok) return res.status(q.rateLimited ? 429 : 502).json({ error: q.rateLimited ? LIMIT_MSG : "No model answered in time. Ask again in a moment." });
      return res.status(200).json({ kind: "quick", answer: q.text, model: q.model });
    }

    // 1 ── three seats, in parallel, never seeing each other
    const seatDeadline = start + SEATS_DONE_BY_MS;
    const results = await Promise.all(SEATS.map((s, i) =>
      firstGood(c.seat[i],
        `You are one member of Council, a panel of AI models that argues a hard question from three sides before a chairman decides.\n${ctx}\n\n${style}\n\n` +
          `Question: "${question}"\n\n${s.brief}\n\n` +
          `Format: exactly three bullet points, each starting with "- ", then one final line that starts with "${s.close}" giving ${s.closeHint}. ` +
          `90 to 150 words in total. No headings.`,
        key, { deadline: seatDeadline, validate: usableSeat, clean: tidySeat, maxTokens: 450, temperature: 0.7 })
    ));

    const members = SEATS.map((s, i) => ({
      seat: s.seat, role: s.role, name: s.name,
      model: results[i].ok ? results[i].model : "",
      ok: results[i].ok,
      answer: results[i].ok ? results[i].text : "This seat did not get a usable answer in time, so the verdict is built from the other two.",
    }));
    const answered = members.filter((m) => m.ok);
    if (answered.length === 0) {
      const limited = results.some((r) => r.rateLimited);
      return res.status(limited ? 429 : 502).json({ error: limited ? LIMIT_MSG : "None of the models answered in time. Ask again in a moment." });
    }

    // 2 ── the chairman
    const block = answered.map((m) => `${m.role.toUpperCase()} (${m.name}):\n${m.answer}`).join("\n\n");
    const chairPrompt =
      `You are the chairman of Council. Members answered this question from assigned seats, independently, without seeing each other.\n${ctx}\n\n` +
      `Question: "${question}"\n\n${block}\n\n` +
      `Your job: decide which seat made the strongest, best-supported case for this person's actual situation; name the real disagreement in one sentence; ` +
      `then give the verdict. Commit to an answer. If it truly depends on one thing, name that thing and say what to do in each case.\n\n` +
      `Reply with ONLY a JSON object, no code fences:\n` +
      `{"strongest":"for" or "against" or "improve","whyListen":"two sentences on why that seat's reasoning deserves the most weight",` +
      `"split":"one sentence naming where the members disagree","finalAnswer":"two or three decisive sentences: the recommendation, the main reason, and the first step",` +
      `"confidence":"high" or "medium" or "low"}`;
    // the chairman should not be one of the models it is judging
    const used = new Set(results.filter((r) => r.ok).map((r) => r.id));
    const chairChain = MODE === "paid" ? c.chair
      : uniq(c.free.filter((m) => !used.has(m.id)).slice(0, 3).concat(c.free.slice(0, 2))).concat([ROUTER, ROUTER]);
    const ch = await firstGood(chairChain, chairPrompt, key, {
      deadline: start + ALL_DONE_BY_MS - (MODE === "paid" ? 9000 : 0),
      validate: (t) => { const p = parseJSON(t); return !!(p && typeof p.finalAnswer === "string" && p.finalAnswer.length > 20); },
      maxTokens: 500, temperature: 0.3,
    });
    const p = ch.ok ? parseJSON(ch.text) : null;
    const seatOf = (k) => SEATS.find((s) => s.seat === k) || null;
    const strongestSeat = p && seatOf(p.strongest) && members.find((m) => m.seat === p.strongest && m.ok) ? p.strongest : answered[0].seat;
    const chairman = p
      ? {
          strongest: seatOf(strongestSeat).role, strongestSeat,
          whyListen: String(p.whyListen || ""), split: String(p.split || ""),
          finalAnswer: String(p.finalAnswer), confidence: ["high", "medium", "low"].includes(p.confidence) ? p.confidence : "",
          model: ch.model,
        }
      : {
          strongest: seatOf(strongestSeat).role, strongestSeat, whyListen: "", split: "", confidence: "low", model: "",
          finalAnswer: "The chairman did not return a verdict in time. Read the three cases above: where they agree is solid ground, and where they split is the real decision.",
        };

    // 3 ── verification (paid mode only, so the free tier stays fast)
    let verificationText = "Fact-checking runs on the full version.";
    if (MODE === "paid" && Date.now() < start + ALL_DONE_BY_MS - 3000) {
      verificationText = await Promise.race([
        verify(question, chairman.finalAnswer, key, c.chair, start + ALL_DONE_BY_MS),
        sleep(Math.max(1000, start + ALL_DONE_BY_MS - Date.now())).then(() => "Fact-check did not finish in time."),
      ]);
    }

    return res.status(200).json({ kind: "judgment", mode: MODE, category, members, chairman, verificationText });
  } catch (e) {
    return res.status(500).json({ error: "The council hit an error: " + e.message });
  }
}

