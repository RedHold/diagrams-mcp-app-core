// Idempotency & billing-safety test — free, deterministic, NO real network.
// Spins up a local HTTP stub that impersonates /api/v2 failure modes and
// asserts the v1.3.0 client behaviour driven by the 2026-07-30 session audit:
//
//   1. 504-then-replay: an ambiguous 504 is retried with the SAME
//      Idempotency-Key; the "server" replays the stored result → exactly one
//      charge, diagram id recovered.
//   2. 409 IDEMPOTENCY_IN_PROGRESS: waits and re-asks the same key until done.
//   3. Hard 422: never retried (exactly one request), no unknown-charge entry.
//   4. Exhausted retries (always-504): tool reports an error that tells the
//      agent to check get_usage_history, and the session tally shows the call
//      as UNKNOWN instead of silently omitting it.
//
// Run: node scripts/test-idempotency.mjs   (after npm run build)
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const okLog = (msg) => console.log(`✓ ${msg}`);

// ---------------------------------------------------------------------------
// Stub API
// ---------------------------------------------------------------------------
const state = {
  bills: 0,                       // times the stub "charged"
  keysSeen: new Map(),            // Idempotency-Key -> stored response
  inProgress: new Map(),          // key -> remaining 409s before success
  requests: [],                   // {path, key, scenario}
};

const USAGE = { credits_charged: 1, credits_remaining: 41, tier: "standard" };
const DIAGRAM = (id) => ({
  id, title: "stub", xml: "<mxGraphModel/>", warnings: [], suggestions: [],
  score: { score: 90, tier: "excellent", warning_count: 0, recoverable_points: 10 },
  usage: USAGE,
});

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const key = req.headers["idempotency-key"];
    const url = req.url || "";

    if (req.method === "GET" && url.startsWith("/api/v2/usage/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        items: [], has_more: false, next_cursor: null,
        summary: { task_count: state.bills, total_credits_charged: state.bills },
      }));
      return;
    }

    if (req.method === "POST" && url === "/api/v2/diagrams") {
      const prompt = (JSON.parse(body || "{}").prompt || "");
      state.requests.push({ path: url, key, prompt });

      if (!key) { // the whole point: billable calls MUST carry a key
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "TEST_NO_KEY", message: "no Idempotency-Key sent" } }));
        return;
      }

      // Replay path: same key already completed server-side.
      if (state.keysSeen.has(key)) {
        res.writeHead(201, { "content-type": "application/json", "idempotency-replayed": "true" });
        res.end(JSON.stringify(state.keysSeen.get(key)));
        return;
      }

      if (prompt.includes("504-once")) {
        // Server does the work, BILLS, stores the response — then the gateway
        // eats the reply (exactly the audited production failure).
        state.bills += 1;
        state.keysSeen.set(key, DIAGRAM("diag-504-once"));
        res.writeHead(504, { "content-type": "text/html" });
        res.end("<html>504 Gateway Time-out</html>");
        return;
      }
      if (prompt.includes("always-504")) {
        res.writeHead(504, { "content-type": "text/html" });
        res.end("<html>504 Gateway Time-out</html>");
        return;
      }
      if (prompt.includes("409-then-ok")) {
        const left = state.inProgress.get(key);
        if (left === undefined) {
          // First sight: still "running" — bill will land when it completes.
          state.inProgress.set(key, 1);
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "original still running" } }));
          return;
        }
        state.bills += 1;
        const out = DIAGRAM("diag-409");
        state.keysSeen.set(key, out);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      if (prompt.includes("hard-422")) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "VALIDATION_ERROR", message: "bad prompt" } }));
        return;
      }

      // default: success first try
      state.bills += 1;
      const out = DIAGRAM("diag-ok");
      state.keysSeen.set(key, out);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: url } }));
  });
});

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const port = stub.address().port;

// ---------------------------------------------------------------------------
// MCP client against the built server, pointed at the stub
// ---------------------------------------------------------------------------
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: {
    ...process.env,
    DIAGRAMS_API_KEY: "dgz_test_stub_key_no_real_calls",
    DIAGRAMS_API_BASE: `http://127.0.0.1:${port}/api/v2`,
    DIAGRAMS_API_RETRY_DELAYS_MS: "50,50,50", // fast retries for the test
    DIAGRAMS_API_TIMEOUT_MS: "5000",
  },
});
const client = new Client({ name: "idempotency-test", version: "1.0.0" });
const guard = setTimeout(() => fail("timed out"), 60000);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
};
const keysFor = (marker) => [
  ...new Set(state.requests.filter((r) => r.prompt.includes(marker)).map((r) => r.key)),
];

try {
  await client.connect(transport);
  okLog("handshake OK against stub API");

  // 1 — 504 then same-key replay
  const r1 = await call("generate_diagram", { prompt: "504-once please" });
  if (r1.isError) fail(`504-once should recover via replay, got error: ${r1.text.slice(0, 200)}`);
  if (!r1.text.includes("diag-504-once")) fail("replayed diagram id missing from result");
  const k1 = keysFor("504-once");
  if (k1.length !== 1) fail(`expected ONE idempotency key across retries, saw ${k1.length}`);
  if (state.bills !== 1) fail(`expected exactly 1 charge after replay, stub billed ${state.bills}`);
  okLog("504 → same-key retry → replayed result, exactly one charge, id recovered");

  // 2 — 409 in-progress then done
  const r2 = await call("generate_diagram", { prompt: "409-then-ok please" });
  if (r2.isError) fail(`409-then-ok should succeed, got: ${r2.text.slice(0, 200)}`);
  if (!r2.text.includes("diag-409")) fail("409 flow did not return the completed diagram");
  if (keysFor("409-then-ok").length !== 1) fail("409 retry must reuse the same key");
  okLog("409 IDEMPOTENCY_IN_PROGRESS → waited, re-asked same key, completed");

  // 3 — hard 422: no retry, no unknown-charge
  const before422 = state.requests.length;
  const r3 = await call("generate_diagram", { prompt: "hard-422 please" });
  if (!r3.isError) fail("422 must surface as a tool error");
  const reqs422 = state.requests.length - before422;
  if (reqs422 !== 1) fail(`422 must NOT retry (saw ${reqs422} requests)`);
  if (r3.text.includes("may still have completed")) fail("422 is definite — no ambiguity warning expected");
  okLog("hard 422 → single request, no retry, no ambiguity warning");

  // 4 — retries exhausted: honest UNKNOWN in the tally + guidance in the error
  const r4 = await call("generate_diagram", { prompt: "always-504 please" });
  if (!r4.isError) fail("always-504 must fail after retries");
  if (!r4.text.includes("get_usage_history")) fail("exhausted ambiguous failure must point to the ledger");
  if (keysFor("always-504").length !== 1) fail("exhausted retries must all reuse one key");
  const hist = await call("get_usage_history", {});
  if (!hist.text.includes("unknown outcome")) fail(`tally must show the unknown-outcome call:\n${hist.text}`);
  if (!hist.text.includes("ledger above is authoritative")) fail("tally must defer to the ledger");
  // Confirmed = scenario 1 (replayed usage) + scenario 2 (completed usage).
  if (!hist.text.includes("2 credit(s) confirmed across 2 task(s)"))
    fail(`confirmed tally wrong (expected 2 confirmed + 1 unknown):\n${hist.text}`);
  okLog("exhausted retries → honest UNKNOWN tally entry + ledger-first guidance");

  clearTimeout(guard);
  await client.close();
  stub.close();
  console.log("\n✓ idempotency & billing-safety test passed");
  process.exit(0);
} catch (err) {
  clearTimeout(guard);
  console.error("✗ test crashed:", err);
  process.exit(1);
}
