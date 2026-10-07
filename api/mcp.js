// api/mcp.js — Council as an MCP server (Streamable HTTP, stateless, JSON responses)
//
// Add to an MCP client with the URL https://YOUR-SITE/api/mcp
//   Claude Code:  claude mcp add --transport http council https://YOUR-SITE/api/mcp
//   Cursor:       ~/.cursor/mcp.json   {"mcpServers":{"council":{"url":"https://YOUR-SITE/api/mcp"}}}
//
// Tools: council_query (full debate or quick take), council_models (who sits on the panel right now).
// Same rate limits and daily budget as the website, because every call goes through api/council.js.
// Optional: set MCP_TOKENS (comma-separated) in Vercel to require "Authorization: Bearer <token>".

import council from "./council.js";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TOOLS = [
  {
    name: "council_query",
    title: "Ask the Council",
    description:
      "Send a hard question to Council. Three models from different AI labs argue it independently (the case for, the case against, how to improve it) " +
      "and a chairman from a fourth lab returns one verdict with a confidence level, the disagreement, and a receipt of exactly which models answered. " +
      "Questions with one correct answer get a single line instead. Include any context the council needs (a plan, a diff summary, the trade-off) in the question.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The decision or question, with whatever context matters. Up to 2,000 characters." },
        mode: { type: "string", enum: ["debate", "quick"], description: "debate (default, about 30 seconds) or quick (one model, about 10 seconds)." },
      },
      required: ["question"],
    },
  },
  {
    name: "council_models",
    title: "Council panel",
    description: "List which model, lab and provider currently sits in each council seat, and which seats are on free backups.",
    inputSchema: { type: "object", properties: {} },
  },
];

function runCouncil(method, body, headers) {
  return new Promise((resolve) => {
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    const h = { ...headers }; delete h.origin;            // MCP clients are not the website; rate limits still apply by IP
    council({ method, body, headers: h, socket: {} }, res);
  });
}
const SEAT = { for: "The case for", against: "The case against", improve: "How to improve it", chair: "Chairman" };
function receiptText(r) { return (r || []).map((x) => `- ${x.role}: ${x.modelId} (${x.lab ? x.lab + ", " : ""}via ${x.provider})`).join("\n"); }
function format(d) {
  if (d.error) return { text: d.error, isError: true };
  if (d.kind === "fact") return { text: `**Answer:** ${d.factAnswer}\n\n_${d.nudge}_\n\n**Model receipt**\n${receiptText(d.receipt)}` };
  if (d.kind === "quick") return { text: `## Quick take\n\n${d.answer}\n\n**Model receipt**\n${receiptText(d.receipt)}` };
  const c = d.chairman || {};
  let t = `## Verdict${c.confidence ? ` (${c.confidence} confidence)` : ""}\n\n${c.shortAnswer ? `**In short:** ${c.shortAnswer}\n\n` : ""}${c.finalAnswer || ""}\n\n`;
  if (c.askBack && c.askBack.length) t += `**The council would like to know:** ${c.askBack.join(" ")}\n\n`;
  if (c.whyListen) t += `**Why listen to ${String(c.strongest || "the strongest case").toLowerCase()}:** ${c.whyListen}\n\n`;
  if (c.split) t += `**Where they disagree:** ${c.split}\n\n`;
  for (const m of d.members || []) t += `### ${m.role} (${m.name})${m.model ? ` — ${m.model}` : ""}\n\n${m.answer}\n\n`;
  t += `**Model receipt**\n${receiptText(d.receipt)}\n\n_${d.verificationText || ""}_`;
  return { text: t };
}
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleOne(msg, req) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(msg?.id ?? null, -32600, "Invalid request");
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null;                     // notifications get no reply
  switch (method) {
    case "initialize": {
      const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
      return ok(id, { protocolVersion: v, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "council", title: "Council", version: "1.0.0" },
        instructions: "Use council_query for decisions and trade-offs where being wrong is costly. It takes about 30 seconds and returns a verdict, the disagreement and a model receipt." });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params.name, args = params.arguments || {};
      if (name === "council_models") {
        const r = await runCouncil("GET", null, req.headers);
        const lines = (r.body.panel || []).map((p) => `- ${SEAT[p.seat]}: ${p.model || "unavailable"}${p.lab ? ` (${p.lab}, via ${p.provider})` : ""}${p.main || p.seat === "chair" ? "" : " — free backup"}`);
        return ok(id, { content: [{ type: "text", text: "Council panel right now:\n" + lines.join("\n") }], isError: false });
      }
      if (name === "council_query") {
        const q = String(args.question || "").trim();
        if (!q) return ok(id, { content: [{ type: "text", text: "Give the council a question." }], isError: true });
        const r = await runCouncil("POST", { question: q, mode: args.mode === "quick" ? "quick" : "debate" }, req.headers);
        const f = format(r.body || {});
        return ok(id, { content: [{ type: "text", text: f.text }], isError: !!f.isError });
      }
      return err(id, -32602, `Unknown tool: ${name}`);
    }
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json(err(null, -32000, "This MCP server accepts POST only (no SSE stream).")); }
  const tokens = String(process.env.MCP_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.length) {
    const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!tokens.includes(auth)) return res.status(401).json(err(null, -32001, "Missing or invalid token."));
  }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json(err(null, -32700, "Parse error")); } }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleOne(m, req)))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handleOne(body, req);
  if (!out) return res.status(202).end();
  return res.status(200).json(out);
}
