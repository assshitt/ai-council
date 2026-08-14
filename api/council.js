// api/council.js
// The council now knows the current date/time, and can optionally search the web.

// ================= SETTINGS =================
// false = FREE mode (no credit needed). The council reasons well and knows
//         today's date, but CANNOT look up current facts (news, prices, live data).
// true  = WEB mode. Needs a few dollars of OpenRouter credit. The council can
//         search the web, so it answers current & factual questions accurately.
//         (This also switches to the real GPT / Claude / Gemini models.)
const USE_WEB_SEARCH = false;

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
const CHAIRMAN = COUNCIL[1].slug; // reuse the 2nd member as chairman
// ============================================

async function ask(model, prompt, key) {
  // Appending ":online" turns on OpenRouter's web search (costs a little).
  const modelSlug = USE_WEB_SEARCH ? `${model}:online` : model;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: modelSlug, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (data.error) return `[ERROR: ${data.error.message || JSON.stringify(data.error)}]`;
    return data?.choices?.[0]?.message?.content?.trim() || "[empty response]";
  } catch (e) {
    return `[REQUEST FAILED: ${e.message}]`;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY." });

  const question = (req.body && req.body.question ? String(req.body.question) : "").trim();
  if (!question) return res.status(400).json({ error: "Please include a question." });

  // The server DOES know the real date/time — so we tell the models.
  // Change "Asia/Kolkata" if you're in a different timezone.
  const now = new Date().toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    dateStyle: "full",
    timeStyle: "short",
  });
  const context =
    `For reference, the current date and time is: ${now} (IST).\n` +
    `If you are asked about something you cannot verify or do not actually know, ` +
    `say so honestly instead of making up an answer.\n\n`;

  try {
    // Round 1 — independent answers (each gets the real date + honesty rule)
    const answers = await Promise.all(
      COUNCIL.map((m) => ask(m.slug, `${context}Question: ${question}\n\nAnswer in about 120 words.`, key))
    );
    const anon = answers.map((a, i) => `Response ${i + 1}:\n${a}`).join("\n\n");

    // Round 2 — cross-examination
    const reviews = await Promise.all(
      COUNCIL.map((m) =>
        ask(
          m.slug,
          `${context}Question: ${question}\n\nAnonymous answers:\n${anon}\n\n` +
            `Critique them: name the biggest weakness in each, say which is strongest and why, and never agree without a reason. About 90 words.`,
          key
        )
      )
    );
    const reviewBlock = reviews.map((r, i) => `Reviewer ${i + 1}:\n${r}`).join("\n\n");

    // Round 3 — the chairman's verdict
    const verdict = await ask(
      CHAIRMAN,
      `${context}Question: ${question}\n\nAnswers:\n${anon}\n\nCritiques:\n${reviewBlock}\n\n` +
        `As chairman, write the final answer. Say where the council agreed and where it split and who is right, then give a clear bottom line. About 150 words.`,
      key
    );

    res.status(200).json({
      members: COUNCIL.map((m, i) => ({ name: m.name, answer: answers[i], review: reviews[i] })),
      verdict,
    });
  } catch (e) {
    res.status(500).json({ error: "The council failed. " + e.message });
  }
}
