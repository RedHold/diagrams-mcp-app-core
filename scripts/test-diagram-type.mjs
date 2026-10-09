// diagram_type pass-through test: free, deterministic, NO real network.
// Spins up a local HTTP stub, drives the built server over stdio, and asserts:
//
//   1. generate_diagram with no diagram_type sends a body WITHOUT the key, so
//      the API (not this server) decides the kind of diagram.
//   2. An explicit type ("auto", "flowchart") is sent exactly as given.
//   3. import_diagram with no diagram_type also leaves the key out.
//   4. No tool description tells the calling AI the default is architecture.
//
// Run: node scripts/test-diagram-type.mjs   (after npm run build)
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const okLog = (msg) => console.log(`✓ ${msg}`);

const bodies = []; // { path, body }
const DIAGRAM = {
  id: "diag-type-test", title: "stub", xml: "<mxGraphModel/>", warnings: [], suggestions: [],
  cloud_provider: "general", diagram_type: "architecture",
  score: { score: 90, tier: "excellent", warning_count: 0, recoverable_points: 10 },
  usage: { credits_charged: 1, credits_remaining: 41, tier: "standard" },
};

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url || "";
    if (req.method === "POST" && (url === "/api/v2/diagrams" || url === "/api/v2/diagrams/import")) {
      bodies.push({ path: url, body: JSON.parse(raw || "{}") });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(DIAGRAM));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: `stub has no ${req.method} ${url}` } }));
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    DIAGRAMS_API_KEY: "dgz_test_stub_key_no_real_calls",
    DIAGRAMS_API_BASE: `http://127.0.0.1:${port}/api/v2`,
    DIAGRAMS_API_TIMEOUT_MS: "5000",
  },
});
const client = new Client({ name: "diagram-type-test", version: "1.0.0" });
const guard = setTimeout(() => fail("timed out"), 60000);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) fail(`${name} returned an error: ${r.content?.[0]?.text?.slice(0, 200)}`);
};
const last = (path) => [...bodies].reverse().find((b) => b.path === path)?.body;

try {
  await client.connect(transport);
  okLog("handshake OK against stub API");

  // 1: left out: key absent from the request body
  await call("generate_diagram", { prompt: "a web app with a database" });
  const b1 = last("/api/v2/diagrams");
  if (!b1) fail("generate_diagram never reached the stub");
  if ("diagram_type" in b1) fail(`left-out diagram_type was sent as ${JSON.stringify(b1.diagram_type)}`);
  okLog("generate_diagram without a type sends no diagram_type");

  // 2: explicit values pass through unchanged
  for (const t of ["auto", "flowchart"]) {
    await call("generate_diagram", { prompt: "a web app with a database", diagram_type: t });
    const b = last("/api/v2/diagrams");
    if (b?.diagram_type !== t) fail(`expected diagram_type ${t}, sent ${JSON.stringify(b?.diagram_type)}`);
  }
  okLog("explicit diagram_type (auto, flowchart) is sent as given");

  // 3: import: left out stays left out
  await call("import_diagram", { xml: "<mxGraphModel><root/></mxGraphModel>" });
  const b3 = last("/api/v2/diagrams/import");
  if (!b3) fail("import_diagram never reached the stub");
  if ("diagram_type" in b3) fail(`import sent diagram_type ${JSON.stringify(b3.diagram_type)}`);
  okLog("import_diagram without a type sends no diagram_type");

  // 4: descriptions no longer claim an architecture default
  const { tools } = await client.listTools();
  for (const t of tools) {
    const d = t.inputSchema?.properties?.diagram_type?.description;
    if (d && /default:\s*architecture/i.test(d)) fail(`${t.name} still says the default is architecture`);
  }
  const gen = tools.find((t) => t.name === "generate_diagram");
  if (!/leave out/i.test(gen?.inputSchema?.properties?.diagram_type?.description ?? ""))
    fail("generate_diagram diagram_type description does not say it can be left out");
  okLog("no tool description claims an architecture default");

  clearTimeout(guard);
  await client.close();
  stub.close();
  console.log("\n✓ diagram_type test passed");
  process.exit(0);
} catch (err) {
  clearTimeout(guard);
  console.error("✗ test crashed:", err);
  process.exit(1);
}
