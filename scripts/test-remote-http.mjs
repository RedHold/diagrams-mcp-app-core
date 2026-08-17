// Hard test for the remote MCP (Streamable HTTP) transport, end to end:
//  - 401 + WWW-Authenticate handshake when unauthenticated
//  - protected-resource metadata (RFC 9728)
//  - initialize + tools/list over the REAL MCP protocol (SDK client)
//  - a tool call FORWARDS the user's Bearer to the (fake) Diagrams API
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fails = [];
const check = (n, c) => { console.log(`  [${c ? "PASS" : "FAIL"}] ${n}`); if (!c) fails.push(n); };

// --- 1. Fake Diagrams API: records the Authorization it receives ------------
let lastAuth = null;
const fakeApi = http.createServer((req, res) => {
  lastAuth = req.headers["authorization"] || null;
  const send = (obj) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.url.endsWith("/meta/diagram-types")) return send(["architecture", "network"]);
  if (req.url.endsWith("/meta/providers")) return send(["aws", "gcp", "azure"]);
  if (req.url.endsWith("/meta/formats")) return send(["drawio", "svg"]);
  if (req.url.endsWith("/me")) return send({ email: "u@example.com", plan: "power", livemode: true, scopes: [] });
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => fakeApi.listen(0, r));
const apiPort = fakeApi.address().port;

// --- 2. Start the remote MCP app pointed at the fake API --------------------
process.env.MCP_HTTP_START = "0";
process.env.DIAGRAMS_API_BASE = `http://127.0.0.1:${apiPort}/api/v2`;
process.env.MCP_PUBLIC_URL = "https://mcp.diagrams.so";
process.env.OAUTH_ISSUER = "https://api.diagrams.so";
process.env.DIAGRAMS_NO_AUTO_LOGIN = "1";
const { buildApp } = await import("../dist/http.js");
const mcp = buildApp();
const srv = await new Promise((r) => { const s = mcp.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;

// --- 3. Unauthenticated /mcp -> 401 + WWW-Authenticate ----------------------
const r401 = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
check("unauth /mcp -> 401", r401.status === 401);
const wa = r401.headers.get("www-authenticate") || "";
check("WWW-Authenticate points at resource_metadata", wa.includes("resource_metadata="));

// --- 4. Protected-resource metadata -----------------------------------------
const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
check("PRM resource is the /mcp URL", prm.resource === "https://mcp.diagrams.so/mcp");
check("PRM names the authorization server", Array.isArray(prm.authorization_servers) && prm.authorization_servers[0] === "https://api.diagrams.so");

// --- 5. Authenticated: initialize + tools/list + a tool call (SDK client) ----
const TOKEN = "dgz_live_faketoken_forwardme";
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(transport);              // initialize handshake over HTTP
check("initialize handshake succeeded (authenticated)", true);

const tools = await client.listTools();
check(`tools/list returns the full tool set (${tools.tools.length})`, tools.tools.length >= 20);
check("tools include generate_diagram + list_capabilities",
  tools.tools.some((t) => t.name === "generate_diagram") && tools.tools.some((t) => t.name === "list_capabilities"));

lastAuth = null;
const result = await client.callTool({ name: "list_capabilities", arguments: {} });
check("tool call returned content", Array.isArray(result.content) && result.content.length > 0);
check("the user's Bearer was FORWARDED to the API", lastAuth === `Bearer ${TOKEN}`);

await client.close();
srv.close(); fakeApi.close();
console.log("\n" + (fails.length ? `REMOTE MCP FAILURES: ${fails}` : "REMOTE MCP: ALL PASS"));
process.exit(fails.length ? 1 : 0);
