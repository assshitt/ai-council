# council

Three AIs (GPT, Claude, Gemini) answer a question, critique each other, and a chairman writes the verdict. The API key lives only on the server, never in the browser.

## How it's wired

- `index.html` — the frontend. Runs in the browser. **Contains no secrets.**
- `api/council.js` — a serverless function. Runs on Vercel's server. Holds the key and does all the model calls.
- The browser POSTs a question to `/api/council`; the function runs the debate and returns the answers.

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

## Changing the models
Model names live at the top of `api/council.js` in `COUNCIL`. They change over time — if one errors, grab the current slug from https://openrouter.ai/models and paste it in. Push to GitHub and Vercel redeploys automatically.

## Safety notes
- The key is only ever in Vercel's Environment Variables and on the server. It is never sent to the browser.
- Because every user's questions cost *you* money per call, add rate limiting before sharing this widely (a simple per-IP cap, or require a login). Otherwise one person can run up your bill.
