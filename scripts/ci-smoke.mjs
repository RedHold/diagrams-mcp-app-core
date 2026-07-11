// CI smoke — free, deterministic, no network. Spawns the BUILT stdio server,
// completes the MCP handshake, and asserts that every expected tool registers.
// Makes ZERO calls to the Diagrams.so API, so it needs no real key and spends
// no credits — it purely guards against build / tool-registration regressions.
// (The full flow against the live API lives in test-smoke.mjs / the live-smoke
// workflow, which does spend credits and needs a real DIAGRAMS_API_KEY secret.)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  "generate_diagram", "edit_diagram", "fix_warning", "relayout_diagram",
  "import_diagram", "update_diagram", "delete_diagram", "revert_diagram",
  "fork_template", "get_diagram", "list_diagrams", "get_warnings",
  "export_diagram", "list_versions", "get_version", "get_relayout_status",
  "search_gallery", "enhance_prompt", "clarify_prompt", "get_usage",
  "whoami", "list_capabilities",
];

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// Dummy key — the server never calls the API during handshake/listTools, so no
// real credentials are needed and nothing is billed.
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, DIAGRAMS_API_KEY: "dgz_test_ci_dummy_no_calls" },
});

const client = new Client({ name: "ci-smoke", version: "1.0.0" });

// Don't hang CI if the server never speaks.
const guard = setTimeout(() => fail("timed out waiting for the MCP handshake"), 20000);

try {
  await client.connect(transport);
  console.log("✓ MCP handshake OK (server launched)");

  const { tools } = await client.listTools();
  const got = new Set(tools.map((t) => t.name));
  console.log(`✓ tools/list returned ${tools.length} tools`);

  const missing = EXPECTED.filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !EXPECTED.includes(n));
  if (missing.length) fail(`missing tools: ${missing.join(", ")}`);
  if (extra.length) fail(`unexpected tools: ${extra.join(", ")}`);
  if (tools.length !== EXPECTED.length)
    fail(`expected ${EXPECTED.length} tools, got ${tools.length}`);

  // Every tool must expose a name + input schema (catches malformed registrations).
  for (const t of tools) {
    if (!t.name) fail("a tool has no name");
    if (!t.inputSchema) fail(`tool ${t.name} has no inputSchema`);
  }

  clearTimeout(guard);
  await client.close();
  console.log(`\n✓ CI smoke passed — all ${EXPECTED.length} tools register correctly`);
  process.exit(0);
} catch (err) {
  clearTimeout(guard);
  fail(err?.stack || String(err));
}
