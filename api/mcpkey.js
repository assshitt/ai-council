// api/mcpkey.js — gives each signed-in person their own Council MCP key.
//
// The key is signed, not stored: ck_<user id>.<signature>. api/mcp.js checks the signature,
// so there is no database to keep. Anyone without a valid key is asked to sign up.
//
// Vercel environment variables:
//   MCP_KEY_SECRET      a long random string. Setting it switches key checks on in api/mcp.js.
//   SUPABASE_URL, SUPABASE_ANON_KEY   (already set for sign-up)
import crypto from "node:crypto";

const SITE_URL = process.env.SITE_URL || "https://ai-council-ashen.vercel.app";

export function keyFor(userId, secret) {
  const id = Buffer.from(String(userId)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update("council-mcp:" + userId).digest("base64url").slice(0, 24);
  return `ck_${id}.${sig}`;
}
// returns the user id for a valid key, or null
export function checkKey(key, secret) {
  const m = /^ck_([A-Za-z0-9_-]{8,80})\.([A-Za-z0-9_-]{24})$/.exec(String(key || "").trim());
  if (!m || !secret) return null;
  let uid;
  try { uid = Buffer.from(m[1], "base64url").toString(); } catch { return null; }
  const want = Buffer.from(keyFor(uid, secret)), got = Buffer.from(String(key).trim());
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? uid : null;
}

function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return o === SITE_URL || /^https:\/\/ai-council[\w-]*\.vercel\.app$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!originAllowed(req)) return res.status(403).json({ error: "Not allowed." });
  const secret = process.env.MCP_KEY_SECRET;
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, ""), anon = process.env.SUPABASE_ANON_KEY;
  if (!secret || !url || !anon) return res.status(503).json({ error: "MCP keys are being switched on. Check back soon." });
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sign in first." });
  let user;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
    if (!r.ok) return res.status(401).json({ error: "That sign-in could not be verified." });
    user = await r.json();
  } catch { return res.status(502).json({ error: "Could not reach the sign-in service." }); }
  if (!user || !user.id) return res.status(401).json({ error: "That sign-in could not be verified." });
  const key = keyFor(user.id, secret);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ key, url: `${SITE_URL}/api/mcp?key=${key}` });
}
