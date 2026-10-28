// api/signup.js — records each sign-up / sign-in in Airtable (and, optionally, a Google Sheet as well).
//
// The browser sends the Supabase access token it just received. We never trust the browser's word:
// we ask Supabase who the token belongs to, then send that verified user to the sheet.
//
// Vercel environment variables:
//   SUPABASE_URL        https://YOUR-PROJECT.supabase.co
//   SUPABASE_ANON_KEY   Supabase → Project Settings → API → anon public key
//   AIRTABLE_TOKEN      Airtable personal access token (starts with "pat")
//   AIRTABLE_BASE_ID    the base ID from the base's URL (starts with "app")
//   AIRTABLE_TABLE      optional, default "Signups" — created automatically with the right fields if it does not exist
//   SHEET_WEBHOOK_URL   optional backup: the Apps Script web app URL (ends in /exec)
//   SHEET_SECRET        optional backup: the same random string as in the Apps Script

const SITE_URL = process.env.SITE_URL || "https://ai-council-ashen.vercel.app";

function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  const extra = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [SITE_URL, ...extra].includes(o) || /^https:\/\/ai-council[\w-]*\.vercel\.app$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
}
// stop a value like "=HYPERLINK(...)" from being treated as a formula by the spreadsheet
function cell(v, max = 200) {
  const s = String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function ist(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
const PROVIDER = { google: "Google", github: "GitHub", facebook: "Facebook", apple: "Apple", email: "Email" };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (!originAllowed(req)) return res.status(403).json({ error: "Not allowed." });
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, ""), anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return res.status(500).json({ error: "Sign-in is not configured on the server." });

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Missing sign-in token." });

  let user;
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: "Bearer " + token } });
    if (!r.ok) return res.status(401).json({ error: "That sign-in could not be verified." });
    user = await r.json();
  } catch {
    return res.status(502).json({ error: "Could not reach the sign-in service." });
  }
  if (!user || !user.id) return res.status(401).json({ error: "That sign-in could not be verified." });

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const meta = user.user_metadata || {};
  const providerKey = (user.app_metadata && user.app_metadata.provider) || "email";
  const row = {
    id: user.id,
    email: cell(user.email || meta.email || ""),
    name: cell(meta.full_name || meta.name || meta.user_name || meta.preferred_username || ""),
    provider: PROVIDER[providerKey] || cell(providerKey),
    createdAt: ist(user.created_at),
    lastSignIn: ist(user.last_sign_in_at),
    verified: !!(user.email_confirmed_at || user.confirmed_at),
    country: cell(req.headers["x-vercel-ip-country"] || "", 8),
    referrer: cell(body.referrer, 300),
    utmSource: cell(body.utmSource, 100),
    utmCampaign: cell(body.utmCampaign, 100),
  };

  // first-touch details (where they came from) are only written when the account is brand new
  const isNew = user.created_at && user.last_sign_in_at && Math.abs(new Date(user.last_sign_in_at) - new Date(user.created_at)) < 3 * 60 * 1000;
  const raw = (v, max = 200) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
  const at = {
    userId: user.id, email: raw(user.email || meta.email || ""), name: raw(meta.full_name || meta.name || meta.user_name || meta.preferred_username || ""),
    provider: PROVIDER[providerKey] || raw(providerKey), createdAt: user.created_at || null, lastSignIn: user.last_sign_in_at || null,
    verified: !!(user.email_confirmed_at || user.confirmed_at), country: raw(req.headers["x-vercel-ip-country"] || "", 8),
    referrer: raw(body.referrer, 300), utmSource: raw(body.utmSource, 100), utmCampaign: raw(body.utmCampaign, 100), isNew: !!isNew,
  };

  const jobs = [];
  if (process.env.AIRTABLE_TOKEN && process.env.AIRTABLE_BASE_ID) jobs.push(["airtable", toAirtable(at)]);
  if (process.env.SHEET_WEBHOOK_URL) jobs.push(["sheet", toSheet(row)]);
  if (!jobs.length) return res.status(200).json({ ok: true, logged: false, note: "No tracker is configured (set AIRTABLE_TOKEN and AIRTABLE_BASE_ID)." });
  const results = await Promise.all(jobs.map(([, p]) => p));
  const out = {}; jobs.forEach(([k], i) => { out[k] = results[i]; });
  const failed = Object.entries(out).filter(([, r]) => !r.ok);
  if (failed.length === jobs.length) return res.status(502).json({ ok: false, error: failed.map(([k, r]) => k + ": " + r.error).join("; ") });
  return res.status(200).json({ ok: true, logged: true, isNew: !!isNew, trackers: out });
}

// ---------------------------------------------------------------- Google Sheet (optional backup)
async function toSheet(row) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(process.env.SHEET_WEBHOOK_URL, { method: "POST", signal: ctrl.signal, redirect: "follow",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: process.env.SHEET_SECRET || "", ...row }) });
    clearTimeout(t);
    const d = await r.json().catch(() => ({}));
    return d.ok ? { ok: true } : { ok: false, error: "the sheet did not accept the row: " + (d.error || "HTTP " + r.status) };
  } catch { return { ok: false, error: "could not reach the sheet" }; }
}

// ---------------------------------------------------------------- Airtable
// One API call per sign-in (the free plan allows 1,000 calls a month): an upsert keyed on "User ID",
// so each person is one row that gets updated when they sign in again.
const AT = "https://api.airtable.com/v0";
const TIME = { dateFormat: { name: "local" }, timeFormat: { name: "24hour" }, timeZone: "Asia/Kolkata" };
const AT_FIELDS = [
  { name: "User ID", type: "singleLineText" },
  { name: "Email", type: "email" },
  { name: "Name", type: "singleLineText" },
  { name: "Signed up with", type: "singleSelect", options: { choices: ["Google", "GitHub", "Facebook", "Apple", "Email"].map((n) => ({ name: n })) } },
  { name: "Signed up", type: "dateTime", options: TIME },
  { name: "Last sign-in", type: "dateTime", options: TIME },
  { name: "Email verified", type: "checkbox", options: { icon: "check", color: "greenBright" } },
  { name: "Country", type: "singleLineText" },
  { name: "Came from", type: "singleLineText" },
  { name: "UTM source", type: "singleLineText" },
  { name: "UTM campaign", type: "singleLineText" },
];
function atHeaders() { return { Authorization: "Bearer " + process.env.AIRTABLE_TOKEN, "Content-Type": "application/json" }; }
async function atFetch(url, opts) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: atHeaders() });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, d };
  } catch { return { status: 0, ok: false, d: { error: { message: "could not reach Airtable" } } }; }
  finally { clearTimeout(t); }
}
function atError(r) {
  const e = r.d && r.d.error;
  return typeof e === "string" ? e : (e && (e.message || e.type)) || "HTTP " + r.status;
}
async function createTable(base, name) {
  return atFetch(`${AT}/meta/bases/${base}/tables`, { method: "POST",
    body: JSON.stringify({ name, description: "Council sign-ups, one row per person. Written by api/signup.js.", fields: AT_FIELDS }) });
}
async function toAirtable(u) {
  const base = String(process.env.AIRTABLE_BASE_ID).trim(), table = (process.env.AIRTABLE_TABLE || "Signups").trim();
  const fields = { "User ID": u.userId, "Signed up with": u.provider, "Email verified": u.verified };
  if (u.email) fields["Email"] = u.email;
  if (u.name) fields["Name"] = u.name;
  if (u.createdAt) fields["Signed up"] = u.createdAt;
  if (u.lastSignIn) fields["Last sign-in"] = u.lastSignIn;
  if (u.country) fields["Country"] = u.country;
  if (u.isNew) {                                   // keep the first source; later visits do not overwrite it
    if (u.referrer) fields["Came from"] = u.referrer;
    if (u.utmSource) fields["UTM source"] = u.utmSource;
    if (u.utmCampaign) fields["UTM campaign"] = u.utmCampaign;
  }
  const upsert = () => atFetch(`${AT}/${base}/${encodeURIComponent(table)}`, { method: "PATCH",
    body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ["User ID"] }, records: [{ fields }], typecast: true }) });
  let r = await upsert();
  // first ever sign-up: the table does not exist yet, so create it with the right columns and try once more
  const missing = r.status === 404 || (r.status === 403 && /NOT_FOUND|INVALID_PERMISSIONS/i.test(JSON.stringify(r.d)));
  if (!r.ok && missing) {
    const c = await createTable(base, table);
    if (!c.ok && !/DUPLICATE|already exists/i.test(JSON.stringify(c.d)))
      return { ok: false, error: `Airtable table "${table}" not found and could not be created (${atError(c)}). Check the base ID and that the token has the schema.bases:write scope for this base.` };
    r = await upsert();
  }
  if (!r.ok) {
    if (r.status === 422 && /UNKNOWN_FIELD/i.test(JSON.stringify(r.d)))
      return { ok: false, error: `Airtable table "${table}" is missing a column: ${atError(r)}. Delete the table and let it be created automatically, or add the column.` };
    if (r.status === 429) return { ok: false, error: "Airtable rate or monthly limit reached." };
    return { ok: false, error: "Airtable: " + atError(r) };
  }
  return { ok: true, isNew: !!(r.d.createdRecords && r.d.createdRecords.length) };
}
