// api/council.js
// Debug version — shows the real error instead of "[no response]".

const COUNCIL = [
  { name: "Member 1", slug: "openrouter/free" },
  { name: "Member 2", slug: "openrouter/free" },
  { name: "Member 3", slug: "openrouter/free" },
];
const CHAIRMAN = "openrouter/free";

async function ask(model, prompt, key) {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (data.error) {
      return `[ERROR: ${data.error.message || JSON.stringify(data.error)}]`;
    }
    return data?.choices?.[0]?.message?.content?.trim() || "[empty — no content returned]";
  } catch (e) {
    return `[REQUEST FAILED: ${e.message}]`;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing OPENROUTER_API_KEY." });

  // Show that the key is at least present (first 8 chars only, safe to show)
  const keyPreview = key.slice(0, 8) + "...";

  const question = (req.body && req.body.question ? String(req.body.question) : "").trim();
  if (!question) return res.status(400).json({ error: "Please include a question." });

  try {
    const answers = await Promise.all(
      COUNCIL.map((m) => ask(m.slug, `${question}\n\nAnswer in about 120 words.`, key))
    );
    const anon = answers.map((a, i) => `Response ${i + 1}:\n${a}`).join("\n\n");

    const reviews = await Promise.all(
      COUNCIL.map((m) =>
        ask(
          m.slug,
          `Question:\n${question}\n\nAnonymous answers:\n${anon}\n\nCritique them briefly. About 90 words.`,
          key
        )
      )
    );
    const reviewBlock = reviews.map((r, i) => `Reviewer ${i + 1}:\n${r}`).join("\n\n");

    const verdict = await ask(
      CHAIRMAN,
      `Question:\n${question}\n\nAnswers:\n${anon}\n\nCritiques:\n${reviewBlock}\n\nWrite the final answer. About 150 words.`,
      key
    );

    res.status(200).json({
      keyPreview,
      members: COUNCIL.map((m, i) => ({ name: m.name, answer: answers[i], review: reviews[i] })),
      verdict,
    });
  } catch (e) {
    res.status(500).json({ error: "The council failed. " + e.message });
  }
}
