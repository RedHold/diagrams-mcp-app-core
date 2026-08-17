// Regression guard for the cross-tenant "session charges" leak (PR #20 review).
//
// The process-global session-charge tally in client.ts is a stdio-only affordance
// (one long-lived process = one user = one session). On the REMOTE transport the
// process is shared by every user, so it must never render — or one user's diagram
// ids / credits / balance would bleed into another user's get_usage_history. This
// test proves the fix two ways:
//   1) unit  — the writers (recordCharge/recordUnknownCharge) write the global ONLY
//              outside a forwarded-credential scope (stdio); they no-op under
//              withCredential (remote).
//   2) e2e   — user A runs a real generate_diagram through the remote server; user
//              B's get_usage_history contains NONE of A's data and no session block.
//
// Reverting the fix makes step 2 fail (B would see "generate: 2 cr (diagram-of-AAA)").
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fails = [];
const check = (n, c) => { console.log(`  [${c ? "PASS" : "FAIL"}] ${n}`); if (!c) fails.push(n); };

// Fake API: generate returns a diagram owned by the presented bearer (+ usage);
// usage/history is scoped per-user (empty for a fresh user). Enough for the tools
// exercised here to succeed and reach the charge-recording / rendering code.
const api = http.createServer(async (req, res) => {
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer /i, "");
  let body = ""; for await (const c of req) body += c;
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "POST" && path.endsWith("/diagrams")) {
    return send(201, { id: `diagram-of-${bearer}`, title: `${bearer}'s private diagram`,
      usage: { credits_charged: 2, credits_remaining: 8 }, score: null, warnings: [] });
  }
  if (req.method === "GET" && path.endsWith("/usage/history")) {
    return send(200, { items: [], summary: { total_credits_charged: 0, task_count: 0 }, has_more: false });
  }
  return send(200, {});
});
await new Promise((r) => api.listen(0, r));
const apiPort = api.address().port;

process.env.MCP_HTTP_START = "0";
process.env.DIAGRAMS_API_BASE = `http://127.0.0.1:${apiPort}/api/v2`;
process.env.DIAGRAMS_NO_AUTO_LOGIN = "1";

const client = await import("../dist/client.js");
const { buildApp } = await import("../dist/http.js");

// ---- 1) unit: the writer guard ----------------------------------------------
const base0 = client.sessionCharges.length;
client.recordCharge("generate", { id: "stdio-1", usage: { credits_charged: 1, credits_remaining: 9 } });
check("stdio path (no forwarded credential) records into the session ledger", client.sessionCharges.length === base0 + 1);

const afterStdio = client.sessionCharges.length;
client.withCredential("remote-token-x", () =>
  client.recordCharge("generate", { id: "remote-1", usage: { credits_charged: 1, credits_remaining: 9 } }));
client.withCredential("remote-token-x", () => client.recordUnknownCharge("edit", "ambiguous 504"));
check("remote path (forwarded credential in scope) records NOTHING into the shared ledger",
  client.sessionCharges.length === afterStdio);
check("recordCharge is still a passthrough on the remote path",
  client.withCredential("t", () => client.recordCharge("x", { id: "keep", usage: null }))?.id === "keep");

// ---- 2) e2e: A generates, B's history is clean ------------------------------
const srv = await new Promise((r) => { const s = buildApp().listen(0, () => r(s)); });
const baseUrl = `http://127.0.0.1:${srv.address().port}/mcp`;

async function callTool(token, name, args) {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "ledger-iso", version: "1" });
  await c.connect(transport);
  const r = await c.callTool({ name, arguments: args });
  await c.close();
  return (r.content || []).map((x) => x.text).join("\n");
}

const aGen = await callTool("AAA", "generate_diagram", { prompt: "A's private VPC" });
check("user A's generate ran through the remote server", aGen.includes("diagram-of-AAA"));

const bHist = await callTool("BBB", "get_usage_history", {});
check("user B's get_usage_history does NOT contain user A's diagram id", !bHist.includes("diagram-of-AAA"));
check("user B's get_usage_history renders NO 'This session' block", !bHist.includes("This session"));
check("user B's get_usage_history still returns their own (empty) ledger", bHist.includes("Credit consumption"));

srv.close(); api.close();
console.log("\n" + (fails.length ? `REMOTE LEDGER ISOLATION FAILURES: ${fails}` : "REMOTE LEDGER ISOLATION: ALL PASS"));
process.exit(fails.length ? 1 : 0);
