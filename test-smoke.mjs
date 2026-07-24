// Smoke test: spawn the built stdio server and drive it via the MCP client SDK.
// Exercises every tool. Non-LLM lifecycle (import→update→versions→revert→delete)
// is validated deterministically; billable LLM tools (generate/edit/fix/relayout)
// are attempted and reported (they need provider keys + credits configured).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEY = process.env.DIAGRAMS_API_KEY;
if (!KEY) { console.error("set DIAGRAMS_API_KEY"); process.exit(1); }
const BASE = process.env.DIAGRAMS_API_BASE || "https://api.diagrams.so/api/v2";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, DIAGRAMS_API_KEY: KEY, DIAGRAMS_API_BASE: BASE },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);
console.log("✓ connected (MCP handshake OK)");

const { tools } = await client.listTools();
console.log(`✓ tools/list: ${tools.length} tools`);
console.log("  " + tools.map((t) => t.name).join(", "));

let pass = 0, softfail = 0;
const text = (r) => r.content?.[0]?.text || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Test keys are rate-limited to 20/min; this harness fires calls far faster than
// a real (human-paced) MCP client would, so transparently retry on 429. The
// server itself does NOT auto-retry — it honestly surfaces the rate limit.
// LLM tools (generate/edit/fix/relayout/clarify) can take longer than the MCP
// SDK's 60s default request timeout, which would THROW and crash the run — give
// each call up to 200s (matches the server's 180s API safety-net + margin), and
// turn any thrown error (timeout, transport) into a soft failure instead of an
// unhandled rejection that kills the whole harness.
const CALL_TIMEOUT_MS = 200_000;
const call = async (name, args = {}, { expectError = false } = {}) => {
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      r = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    } catch (e) {
      r = { isError: true, content: [{ type: "text", text: `threw: ${e?.message || e}` }] };
    }
    if (r.isError && /RATE_LIMITED/.test(text(r))) { await sleep(1600); continue; }
    break;
  }
  const short = text(r).replace(/\n/g, " ").slice(0, 100);
  const good = expectError ? !!r.isError : !r.isError;
  if (good) pass++; else softfail++;
  console.log(`  ${good ? "✓" : "✗"} ${name}: ${short}`);
  return r;
};
const idFrom = (r) => text(r).match(/(?:new )?id: ([0-9a-f-]{36})/i)?.[1];

console.log("\n-- reads / discovery --");
await call("whoami");
await call("get_usage");
await call("get_usage_history", { limit: 5 });
await call("list_capabilities");
await call("list_diagrams", { limit: 3 });
await call("search_gallery", { q: "aws", limit: 3 });
await call("enhance_prompt", { prompt: "a simple web app on aws" });
await call("clarify_prompt", { prompt: "make me a diagram" });

console.log("\n-- non-LLM lifecycle: import → get → update → versions → get_version → export --");
const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
  + '<mxCell id="2" value="EC2" style="rounded=0" vertex="1" parent="1">'
  + '<mxGeometry x="40" y="40" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>';
const imp = await call("import_diagram", { xml, title: "mcp-smoke import", cloud_provider: "aws" });
const id = idFrom(imp);
console.log("  captured id:", id);
if (id) {
  await call("get_diagram", { diagram_id: id });
  await call("get_warnings", { diagram_id: id });
  await call("update_diagram", { diagram_id: id, title: "mcp-smoke renamed" });
  const vers = await call("list_versions", { diagram_id: id });
  const vid = text(vers).match(/id: ([0-9a-f-]{36})/i)?.[1];
  if (vid) await call("get_version", { diagram_id: id, version_id: vid });
  await call("export_diagram", { diagram_id: id, format: "drawio" });
}

console.log("\n-- billable LLM tools (need provider keys + credits) --");
let genId = id;
const gen = await call("generate_diagram", { prompt: "aws ec2 web server behind an ALB, mcp-smoke", cloud_provider: "aws" });
if (!gen.isError) {
  genId = idFrom(gen) || genId;
  const w = await call("get_warnings", { diagram_id: genId });
  const msg = text(w).match(/• \[[^\]]+\][^ ]* (.+?)(?:\n|$)/)?.[1];
  if (msg) await call("fix_warning", { diagram_id: genId, message: msg.slice(0, 120) });
  await call("edit_diagram", { diagram_id: genId, edit_prompt: "add an RDS database" });
  await call("relayout_diagram", { diagram_id: genId });
} else {
  console.log("  (generate returned an error — provider/credits likely not configured locally; error path OK)");
}

// After the billable calls: the ledger should show mcp-attributed rows and the
// in-process session tally should list what this run just charged.
await call("get_usage_history", { limit: 5, source: "mcp" });

console.log("\n-- error handling (bad id / bad input → clean tool error) --");
await call("get_diagram", { diagram_id: "11111111-1111-1111-1111-111111111111" }, { expectError: true });
await call("update_diagram", { diagram_id: id || "x" }, { expectError: true }); // nothing to update
await call("revert_diagram", { diagram_id: id || "x" }, { expectError: true }); // no version specified

console.log("\n-- cleanup (delete test diagrams) --");
if (id) await call("delete_diagram", { diagram_id: id });
if (genId && genId !== id) await call("delete_diagram", { diagram_id: genId });

await client.close();
console.log(`\n${softfail === 0 ? "✓" : "⚠"} smoke test complete — ${pass} passed, ${softfail} unexpected`);
process.exit(softfail === 0 ? 0 : 1);
