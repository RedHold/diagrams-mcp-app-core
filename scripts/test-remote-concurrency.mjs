// The critical stateless-safety test: under CONCURRENT requests with DIFFERENT
// Bearer tokens, each request must forward its OWN token to the API — no cross-
// contamination through the per-request AsyncLocalStorage credential context.
//
// The fake API echoes back whichever Bearer it received (as the /me email), and
// delays a little so the in-flight requests genuinely overlap. If isolation
// holds, client N's whoami result contains exactly token N.
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fails = [];
const check = (n, c) => { console.log(`  [${c ? "PASS" : "FAIL"}] ${n}`); if (!c) fails.push(n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake API: echo the received bearer; small jitter to force overlap.
const api = http.createServer(async (req, res) => {
  const auth = (req.headers["authorization"] || "").replace(/^Bearer /, "");
  await sleep(20 + Math.floor(Math.random() * 40));
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.endsWith("/me")) res.end(JSON.stringify({ email: auth, plan: "p", livemode: true, scopes: [] }));
  else if (req.url.includes("/meta/")) res.end(JSON.stringify(["x"]));
  else { res.writeHead(404); res.end("{}"); }
});
await new Promise((r) => api.listen(0, r));
const apiPort = api.address().port;

process.env.MCP_HTTP_START = "0";
process.env.DIAGRAMS_API_BASE = `http://127.0.0.1:${apiPort}/api/v2`;
process.env.DIAGRAMS_NO_AUTO_LOGIN = "1";
const { buildApp } = await import("../dist/http.js");
const srv = await new Promise((r) => { const s = buildApp().listen(0, () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/mcp`;

async function whoamiWith(token) {
  const transport = new StreamableHTTPClientTransport(new URL(base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "iso", version: "1" });
  await client.connect(transport);
  const r = await client.callTool({ name: "whoami", arguments: {} });
  await client.close();
  return (r.content || []).map((c) => c.text).join(" ");
}

// Fire N concurrent clients with distinct tokens.
const N = 12;
const tokens = Array.from({ length: N }, (_, i) => `dgz_live_user${i}_uniquesecret`);
const outputs = await Promise.all(tokens.map((t) => whoamiWith(t)));

let allIsolated = true;
for (let i = 0; i < N; i++) {
  const mine = outputs[i].includes(tokens[i]);
  const others = tokens.filter((_, j) => j !== i).some((t) => outputs[i].includes(t));
  if (!mine || others) { allIsolated = false; console.log(`   leak? client ${i}: got ${outputs[i].slice(0, 60)}`); }
}
check(`${N} concurrent requests each forwarded ONLY its own token (no leakage)`, allIsolated);

srv.close(); api.close();
console.log("\n" + (fails.length ? `CONCURRENCY FAILURES: ${fails}` : "CREDENTIAL ISOLATION UNDER CONCURRENCY: PASS"));
process.exit(fails.length ? 1 : 0);
