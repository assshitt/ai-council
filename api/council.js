// api/council.js
// This runs on Vercel's SERVER, never in the browser.
// That's why the API key is safe here: process.env.OPENROUTER_API_KEY is
// stored in Vercel's settings and is never sent to the user.

// FREE TIER: openrouter/free is OpenRouter's auto-router — it picks a free
// model for you, so nothing costs money and the app keeps working even as
// individual free models rotate in and out. On the free tier the members are
// NOT GPT/Claude/Gemini (those aren't free), so they're named neutrally.
//
// TO UPGRADE to the real GPT + Claude + Gemini trio: add a little credit to
// OpenRouter, then swap the slugs below to, e.g.:
//   openai/gpt-4o-mini · anthropic/claude-3.5-sonnet · google/gemini-flash-1.5
// (get current slugs from https://openrouter.ai/models) and rename the members.
const COUNCIL = [
  { name: "Member 1", slug: "openrouter/free" },
  { name: "Member 2", slug: "openrouter/free" },
  { name: "Member 3", slug: "openrouter/free" },
];
const CHAIRMAN = "openrouter/free";

async function ask(model, prompt, key) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || "[no response]";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY." });

  const question = (req.body && req.body.question ? String(req.body.question) : "").trim();
  if (!question) return res.status(400).json({ error: "Please include a question." });

  try {
    // Round 1 — each model answers independently (in parallel)
    const answers = await Promise.all(
      COUNCIL.map((m) => ask(m.slug, `${question}\n\nAnswer in about 120 words.`, key))
    );

    // Anonymize before review so models judge reasoning, not brand names
    const anon = answers.map((a, i) => `Response ${i + 1}:\n${a}`).join("\n\n");

    // Round 2 — each model critiques the anonymized answers
    const reviews = await Promise.all(
      COUNCIL.map((m) =>
        ask(
          m.slug,
          `Question:\n${question}\n\nAnonymous answers from the council:\n${anon}\n\n` +
            `Critique them: name the single biggest weakness in each, say which is strongest and why, and never agree without a reason. About 90 words.`,
          key
        )
      )
    );
    const reviewBlock = reviews.map((r, i) => `Reviewer ${i + 1}:\n${r}`).join("\n\n");

    // Round 3 — the chairman synthesizes the final verdict
    const verdict = await ask(
      CHAIRMAN,
      `Question:\n${question}\n\nAnswers:\n${anon}\n\nCritiques:\n${reviewBlock}\n\n` +
        `As chairman, write the final answer. Say where the council agreed and where it split and who is right, then give a clear bottom line. About 150 words.`,
      key
    );

    res.status(200).json({
      members: COUNCIL.map((m, i) => ({ name: m.name, answer: answers[i], review: reviews[i] })),
      verdict,
    });
  } catch (e) {
    res.status(500).json({ error: "The council failed to reach a decision. " + e.message });
  }
}
