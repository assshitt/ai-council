// api/config.js — public settings the sign-up page needs.
// The Supabase anon key is designed to be public: it only allows what your Supabase security rules allow.
export default function handler(req, res) {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_ANON_KEY || "";
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  if (!url || !key) return res.status(200).json({ auth: false });
  return res.status(200).json({ auth: true, supabaseUrl: url, supabaseAnonKey: key });
}
