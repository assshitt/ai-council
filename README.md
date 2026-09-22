# council

Three AIs (GPT, Claude, Gemini) answer a question, critique each other, and a chairman writes the verdict. The API key lives only on the server, never in the browser.

## How it's wired

- `index.html` — the frontend. Runs in the browser. **Contains no secrets.**
- `api/council.js` — a serverless function. Runs on Vercel's server. Holds the key and does all the model calls.
- The browser POSTs a question to `/api/council`; the function runs the debate and returns the answers.
- `videos/earth.mp4` — the background loop. Every `<video class="fv">` on the site points at it, and the fade-in/fade-out loop applies automatically to anything with that class. Keep replacements under ~10MB, muted and `playsinline`.

## Deploy it (about 15 minutes)

### 1. Get an OpenRouter key (free — no credit card)
- Sign up at https://openrouter.ai and create a key at https://openrouter.ai/keys
- This app uses `openrouter/free`, so you need **no credit and no card** to run it.
- Free tier limits: about 200 requests/day. One council run is 7 requests, so ~28 runs/day.
- **Never paste this key into any file.** It goes into Vercel's settings only (step 4).
- To upgrade to the real GPT + Claude + Gemini later: add a little credit and swap the slugs at the top of `api/council.js` (details in that file).

### 2. Put this folder on GitHub
Easiest with no terminal: install **GitHub Desktop**, "Add Local Repository", point it at this `council-app` folder, then Publish.

Or with the terminal, from inside the `council-app` folder:
```bash
git init
git add .
git commit -m "council: first version"
git branch -M main
# create an empty repo on github.com first, then:
git remote add origin https://github.com/YOUR_USERNAME/council-app.git
git push -u origin main
```

### 3. Import the repo into Vercel
- Go to https://vercel.com and sign in with GitHub.
- "Add New… → Project", pick your `council-app` repo, click Import.
- Framework preset: **Other** (no build step needed). Leave defaults.

### 4. Add your key as an Environment Variable
- In the Vercel project: **Settings → Environment Variables**
- Name: `OPENROUTER_API_KEY`  →  Value: your `sk-or-...` key  →  Save.
- (If you already clicked Deploy, redeploy after adding the key: Deployments → ⋯ → Redeploy.)

### 5. Deploy
- Vercel gives you a live URL like `council-app.vercel.app`. Open it and ask the council something.

## How the API behaves

`POST /api/council` with `{"question": "...", "mode": "debate" | "quick"}`.

- **debate** (default): one planning call assigns roles, three members answer in parallel, the chairman picks the strongest and writes the verdict. A plain lookup ("capital of Peru") is answered directly instead, with `kind: "fact"`.
- **quick**: one model, one direct answer, no debate. The home page's "Quick take" toggle sends this.

What you get back is honest about failures:

- A member that errors or times out comes back with `ok: false` and a short `error`, is left out of the chairman's prompt, and is listed in `notices`. `status` is `"partial"` instead of `"ok"`.
- If the chairman fails, `chairman` is `null` and a notice explains why. The final answer is never an error message dressed as an answer.
- If nothing usable came back, the response is a real HTTP error (`502`, `504`, `429`, `400`) with a plain-English `error`.

Guard rails, all in `api/council.js` under SETTINGS:

- Questions are capped at 1500 characters and wrapped in `<question>` tags so they can't rewrite the prompts.
- Every model and Wikipedia call has a timeout, and the whole request runs against a 52s budget inside Vercel's 60s limit.
- `max_tokens` is set on every call and model output is length-capped before it is returned.
- A best-effort per-visitor limit of 12 questions per 10 minutes (set the `COUNCIL_RATE_LIMIT` env var to change it, `0` to turn it off). It lives in one function instance's memory, so treat it as a speed bump, not a wall.

## Running the tests

```bash
npm test
```

The suite in `test/` runs the real handler against a mocked model provider, so it needs no key and no network. It covers every failure path above.

## Changing the models
Model names live at the top of `api/council.js` in `COUNCIL`. They change over time — if one errors, grab the current slug from https://openrouter.ai/models and paste it in. Push to GitHub and Vercel redeploys automatically.

## Safety notes
- The key is only ever in Vercel's Environment Variables and on the server. It is never sent to the browser.
- Every user's question costs *you* calls. The built-in per-visitor limit slows abuse down but is not durable across function instances; before sharing widely, add a real cap (Vercel KV, Upstash, or a login).
