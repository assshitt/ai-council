// api/_auth.js — shared key check for the developer API (files starting with "_" are not deployed as endpoints).
// Keys are the same personal keys people get on signup.html (ck_...). Until MCP_KEY_SECRET is set in Vercel,
// the API stays open in preview so it can be tried, and the normal rate limits still apply.
import { checkKey } from "./mcpkey.js";

const SITE_URL = process.env.SITE_URL || "https://ai-council-ashen.vercel.app";

export function apiKeyError(req) {
  const tokens = String(process.env.MCP_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const secret = process.env.MCP_KEY_SECRET;
  if (!secret && !tokens.length) return "";
  let q = "";
  try { q = (req.query && req.query.key) || new URL(req.url || "/", "http://x").searchParams.get("key") || ""; } catch {}
  const given = String(q || req.headers["x-council-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")).trim();
  if (given && tokens.includes(given)) return "";
  if (secret && checkKey(given, secret)) return "";
  return given ? "That Council key is not valid." : `Add your Council key as "Authorization: Bearer ck_...". Get one free at ${SITE_URL}/signup.html.`;
}
export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Council-Key");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}
export function readBody(req) {
  let b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { return null; } }
  return b && typeof b === "object" ? b : null;
}
