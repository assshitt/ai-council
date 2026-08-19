// api/council.js
// Role-based council: each member gets an angle that fits the question, gives a
// CRISP answer, then the chairman says who to trust + a bold final answer.
// (Fact-checking runs on the full/paid version so the free tier stays fast.)

// ================= SETTINGS =================
const USE_WEB_SEARCH = false; // true needs OpenRouter credit; switches to GPT/Claude/Gemini + web.
const FREE_COUNCIL = [
  { name: "Member 1", slug: "openrouter/free" },
  { name: "Member 2", slug: "openrouter/free" },
  { name: "Member 3", slug: "openrouter/free" },
];
const WEB_COUNCIL = [
  { name: "GPT",    slug: "openai/gpt-4o-mini" },
  { name: "Claude", slug: "anthropic/claude-3.5-sonnet" },
  { name: "Gemini", slug: "google/gemini-flash-1.5" },
];
const COUNCIL = USE_WEB_SEARCH ? WEB_COUNCIL : FREE_COUNCIL;
const CHAIRMAN = COUNCIL[1].slug;
const VERIFY_ENABLED = USE_WEB_SEARCH; // fact-check only on the full/paid version, to keep free fast
// ============================================

async function ask(model, prompt, key) {
  const modelSlug = USE_WEB_SEARCH ? `${model}:online` : model;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelSlug, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (data.error) return `[ERROR: ${data.error.message || JSON.stringify(data.error)}]`;
    return data?.choices?.[0]?.message?.content?.trim() || "[empty response]";
  } catch (e) {
    return `[REQUEST FAILED: ${e.message}]`;
  }
}
function parseObj(s) { try { return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { return null; } }
function parseArr(s) { try { return JSON.parse(s.slice(s.indexOf("["), s.lastIndexOf("]") + 1)); } catch { return null; } }

async function assignRoles(question, key) {
  const raw = await ask(
    CHAIRMAN,
    `Question: "${question}"\n\nAssign three DISTINCT, complementary angles for a 3-member panel to answer THIS question. ` +
      `Pick angles that fit the question type. Examples — factual: "Gives the direct answer", "Double-checks the facts", "Adds useful context". ` +
      `Opinion: "Argues in favour", "Argues against", "Weighs the trade-offs". Each role label is 3 to 6 words. ` +
      `Reply with ONLY strict JSON: [{"role":"...","direction":"one short line telling this member how to answer"},{"role":"...","direction":"..."},{"role":"...","direction":"..."}]`,
    key
  );
  const arr = parseArr(raw);
  if (arr && arr.length >= 3 && arr[0].role) return arr.slice(0, 3);
  return [
    { role: "Gives the direct answer", direction: "Answer the question directly and clearly." },
    { role: "Double-checks the facts", direction: "Focus on accuracy; confirm or correct." },
    { role: "Adds useful context", direction: "Add the most useful surrounding context." },
  ];
}

async function wikiSearch(term) {
  try {
    const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&format=json&srlimit=1`;
    const r = await fetch(u, { headers: { "User-Agent": "council-app/1.0" } });
    const d = await r.json();
    return d?.query?.search?.[0]?.title || null;
  } catch { return null; }
}
async function wikiSummary(title) {
  try {
    const u = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const r = await fetch(u, { headers: { "User-Agent": "council-app/1.0" } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.extract) return null;
    return { extract: d.extract, url: d?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}` };
  } catch { return null; }
}
async function verify(question, finalAnswer, key) {
  const raw = await ask(
    CHAIRMAN,
    `You are a fact-checker.\n\nQuestion: ${question}\n\nAnswer: ${finalAnswer}\n\n` +
      `If this makes a specific factual claim checkable in an encyclopedia, reply strict JSON: ` +
      `{"checkable":true,"topic":"<best Wikipedia article title>","claim":"<the key claim in one sentence>"}. ` +
      `If subjective, about the future, or very recent, reply: {"checkable":false}. Reply ONLY the JSON.`,
    key
  );
  const p = parseObj(raw);
  if (!p || !p.checkable || !p.topic) return { checkable: false };
  const title = await wikiSearch(p.topic);
  if (!title) return { checkable: true, result: "not_found" };
  const sum = await wikiSummary(title);
  if (!sum) return { checkable: true, result: "not_found" };
  const cmpRaw = await ask(
    CHAIRMAN,
    `Claim: ${p.claim}\n\nSource (Wikipedia — ${title}):\n${sum.extract}\n\n` +
      `Does the source SUPPORT, CONTRADICT, or NOT_ADDRESS the claim? Only say "contradicted" if it clearly disagrees. ` +
      `Reply ONLY strict JSON: {"result":"supported"|"contradicted"|"not_addressed","note":"one short sentence"}.`,
    key
  );
  const c = parseObj(cmpRaw) || {};
  const result = ["supported", "contradicted", "not_addressed"].includes(c.result) ? c.result : "not_addressed";
  return { checkable: true, result, note: c.note || "", source: { title, url: sum.url } };
}
function verificationText(v) {
  if (!v || !v.checkable) return "🔍 Not encyclopedia-checkable — treat as reasoning, not verified fact.";
  const label = { supported: "✅ Supported by an outside source", contradicted: "❌ Contradicted by an outside source", not_addressed: "⚠️ Couldn't confirm against the source", not_found: "⚠️ No reliable source found" }[v.result] || "⚠️ Couldn't confirm";
  let out = `🔍 ${label}.`;
  if (v.source) out += ` Source: ${v.source.title} — ${v.source.url}`;
  return out;
}
function timeout(ms, val) { return new Promise((r) => setTimeout(() => r(val), ms)); }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY." });
  const question = (req.body && req.body.question ? String(req.body.question) : "").trim();
  if (!question) return res.status(400).json({ error: "Please include a question." });

  const now = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" });
  const context = `For reference, the current date and time is: ${now} (IST). If you don't actually know something, say so honestly.\n\n`;

  try {
    const roles = await assignRoles(question, key);

    const answers = await Promise.all(
      COUNCIL.map((m, i) =>
        ask(m.slug,
          `${context}Question: "${question}"\n\nYour role on the panel: ${roles[i].role}. ${roles[i].direction}\n\n` +
            `Answer from this angle in NO MORE than 3 short sentences. Be direct and useful — no filler, don't repeat the question.`,
          key)
      )
    );

    const block = COUNCIL.map((m, i) => `${m.name} (${roles[i].role}):\n${answers[i]}`).join("\n\n");
    const chairRaw = await ask(
      CHAIRMAN,
      `${context}Question: "${question}"\n\nThe three panel answers:\n${block}\n\n` +
        `As chairman, decide which member made the most valid points, and give the final answer. Reply ONLY strict JSON: ` +
        `{"strongest":"Member 1"|"Member 2"|"Member 3","whyListen":"2-3 sentences on why that member's answer is the most valid and worth trusting","finalAnswer":"the best answer to the question in 1-2 confident sentences"}.`,
      key
    );
    const c = parseObj(chairRaw) || {};
    const chairman = {
      strongest: c.strongest || COUNCIL[0].name,
      whyListen: c.whyListen || "",
      finalAnswer: c.finalAnswer || chairRaw,
    };

    // 4. verify the final answer — only on the full version, so free stays fast.
    let verification = null;
    let vText = "🔒 Fact-checking runs on the full version.";
    if (VERIFY_ENABLED) {
      verification = await Promise.race([verify(question, chairman.finalAnswer, key), timeout(15000, null)]);
      vText = verificationText(verification);
    }

    res.status(200).json({
      members: COUNCIL.map((m, i) => ({ name: m.name, role: roles[i].role, answer: answers[i] })),
      chairman,
      verification,
      verificationText: vText,
    });
  } catch (e) {
    res.status(500).json({ error: "The council failed. " + e.message });
  }
}
