// Free-plan null-XML test: free, deterministic, NO real network.
// Spins up a local HTTP stub that answers like the API does for a Free key
// (`xml: null`, `xml_withheld: true`, `export_url`), drives the built server
// over stdio, and asserts:
//
//   1. generate / edit / fix / get / get_version / relayout status do not fail,
//      never print "null" as the XML, and show the Free-plan note with an
//      absolute link to the watermarked image.
//   2. export_diagram format=drawio on Free (403 UPGRADE_REQUIRED) returns the
//      watermarked SVG with the note instead of an error.
//   3. A Paid reply (string xml) still prints the draw.io XML.
//   4. No reply or tool description uses the old metering word (founder rule).
//
// Run: node scripts/test-free-xml.mjs   (after npm run build)
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The old metering word, built so this file does not spell it out either.
const METERING_WORD = new RegExp("\\bcr" + "edits?\\b", "i");

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const okLog = (msg) => console.log(`✓ ${msg}`);

const ID = "free-xml-test";
const FREE = {
  id: ID, title: "stub", xml: null, warnings: [], suggestions: [],
  cloud_provider: "aws", diagram_type: "architecture", is_public: true,
  score: { score: 90, tier: "excellent", warning_count: 0, recoverable_points: 10 },
  xml_withheld: true, xml_withheld_reason: "UPGRADE_REQUIRED",
  export_url: `/api/v2/diagrams/${ID}/export?format=svg`,
  upgrade_url: "https://diagrams.so/pricing",
};
const PAID_XML = "<mxGraphModel><root><mxCell id=\"0\"/></root></mxGraphModel>";
let plan = "free";
const body = () => (plan === "free" ? FREE : { ...FREE, xml: PAID_XML, xml_withheld: undefined, export_url: undefined });

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = req.url || "";
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "POST" && url === "/api/v2/diagrams") return json(201, body());
    if (req.method === "POST" && /\/diagrams\/[^/]+\/(edit|fix)$/.test(url)) return json(200, body());
    if (req.method === "GET" && url === `/api/v2/diagrams/${ID}`) return json(200, body());
    if (req.method === "GET" && url.startsWith(`/api/v2/diagrams/${ID}/versions/`)) return json(200, body());
    if (req.method === "GET" && url.startsWith(`/api/v2/diagrams/${ID}/relayout/`)) {
      return json(200, { job_id: "j1", status: "done", applied: true, version_number: 2, progress: 100,
        warnings: [], score: FREE.score, ...(plan === "free"
          ? { xml: null, xml_withheld: true, xml_withheld_reason: "UPGRADE_REQUIRED", export_url: FREE.export_url, upgrade_url: FREE.upgrade_url }
          : { xml: PAID_XML }) });
    }
    if (req.method === "GET" && url.startsWith(`/api/v2/diagrams/${ID}/export`)) {
      if (url.includes("format=drawio") && plan === "free") {
        return json(403, { error: { code: "UPGRADE_REQUIRED", message: "The .drawio export is part of the paid plan.", request_id: null } });
      }
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>Made with Diagrams.so</text></svg>");
      return;
    }
    json(404, { error: { code: "NOT_FOUND", message: `stub has no ${req.method} ${url}` } });
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;
const LINK = `http://127.0.0.1:${port}/api/v2/diagrams/${ID}/export?format=svg`;

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
const client = new Client({ name: "free-xml-test", version: "1.0.0" });
const guard = setTimeout(() => fail("timed out"), 60000);

const text = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  if (r.isError) fail(`${name} returned an error on the Free plan: ${t.slice(0, 200)}`);
  return t;
};
const assertFree = (name, t) => {
  if (!t.includes("Free plan: the editable draw.io file needs the Paid plan")) fail(`${name}: no Free-plan note:\n${t}`);
  if (!t.includes(LINK)) fail(`${name}: no absolute link to the watermarked image:\n${t}`);
  if (/draw\.io XML:\s*\n\s*(null|undefined)?\s*$/m.test(t) || /\bnull\b/.test(t)) fail(`${name}: printed null as the XML:\n${t}`);
  if (METERING_WORD.test(t)) fail(`${name}: Free note uses the metering word`);
};

try {
  await client.connect(transport);
  okLog("handshake OK against stub API");

  assertFree("generate_diagram", await text("generate_diagram", { prompt: "a web app with a database" }));
  assertFree("edit_diagram", await text("edit_diagram", { diagram_id: ID, edit_prompt: "add a cache" }));
  assertFree("fix_warning", await text("fix_warning", { diagram_id: ID, message: "Single-AZ database" }));
  assertFree("get_diagram", await text("get_diagram", { diagram_id: ID }));
  assertFree("get_version", await text("get_version", { diagram_id: ID, version_id: "00000000-0000-0000-0000-000000000001" }));
  assertFree("get_relayout_status", await text("get_relayout_status", { diagram_id: ID, job_id: "j1" }));
  okLog("Free replies show the note and the watermarked image link, never a null XML");

  const ex = await text("export_diagram", { diagram_id: ID, format: "drawio" });
  if (!ex.includes("Free plan: the editable draw.io file needs the Paid plan")) fail(`export drawio on Free: no note:\n${ex}`);
  if (!ex.includes("<svg")) fail("export drawio on Free: did not hand over the watermarked SVG");
  okLog("export_diagram drawio on Free returns the watermarked SVG with the note");

  plan = "paid";
  const paid = await text("get_diagram", { diagram_id: ID });
  if (!paid.includes(`draw.io XML:\n${PAID_XML}`)) fail(`Paid get_diagram lost the XML:\n${paid}`);
  if (paid.includes("Free plan:")) fail("Paid reply shows the Free note");
  const paidEx = await text("export_diagram", { diagram_id: ID, format: "drawio" });
  if (paidEx.includes("Free plan:")) fail("Paid drawio export shows the Free note");
  okLog("Paid replies are unchanged");

  const { tools } = await client.listTools();
  for (const t of tools) if (METERING_WORD.test(t.description ?? "")) fail(`${t.name} description uses the metering word`);
  okLog("no tool description uses the metering word");

  clearTimeout(guard);
  await client.close();
  stub.close();
  console.log("\n✓ Free-plan null-XML test passed");
  process.exit(0);
} catch (err) {
  clearTimeout(guard);
  console.error("✗ test crashed:", err);
  process.exit(1);
}
