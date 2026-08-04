// Device-login & credential-resolution test — free, deterministic, NO real
// network. Spins up a local HTTP stub implementing the v1.4.0 auth surface
// (/oauth/device/code, /oauth/device/token, /me, /usage, /diagrams) and
// asserts:
//
//   1. Happy-path `login` end-to-end: user code + verification URL printed,
//      polling rides out authorization_pending, and the credential cache is
//      written atomically with dir 0700 / file 0600 and the exact JSON shape.
//   2. `login --test` warns that test keys charge like live, requests
//      livemode:false, and stores expires_at:null when no expires_in returns.
//   3. slow_down is honored (poll interval grows by 5s).
//   4. access_denied / expired_token / key_limit_reached exit 1 with their
//      exact messages; local expiry surfaces the timed-out message.
//   5. Credential precedence: DIAGRAMS_API_KEY env beats the cache (CLI and
//      MCP server); the cache is used when no env var is set.
//   6. A corrupt cache and a base_url-mismatched cache are treated as absent
//      (server returns the actionable not-connected message, never crashes).
//   7. 402 maps to the out-of-credits wording with the upgrade_url; 401 maps
//      to the run-login-again wording.
//
// Run: node scripts/test-device-login.mjs   (after npm run build)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let passed = 0;
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const okLog = (msg) => { passed += 1; console.log(`✓ ${msg}`); };
const assert = (cond, msg) => (cond ? okLog(msg) : fail(msg));

const guard = setTimeout(() => fail("test timed out (120s)"), 120_000);

// ---------------------------------------------------------------------------
// Stub API
// ---------------------------------------------------------------------------
const state = {
  deviceCodeResponse: {},   // what POST /oauth/device/code returns
  deviceCodeBodies: [],     // parsed bodies it received
  tokenPlan: [],            // [{status, body}] — shift per poll; last repeats
  tokenTimes: [],           // Date.now() of each token poll
};

const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url || "";
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");

    if (req.method === "POST" && url === "/api/v2/oauth/device/code") {
      state.deviceCodeBodies.push(JSON.parse(body || "{}"));
      return send(200, state.deviceCodeResponse);
    }
    if (req.method === "POST" && url === "/api/v2/oauth/device/token") {
      state.tokenTimes.push(Date.now());
      const next = state.tokenPlan.length > 1 ? state.tokenPlan.shift() : state.tokenPlan[0];
      return send(next.status, next.body);
    }
    if (req.method === "GET" && url === "/api/v2/me") {
      if (bearer === "dgz_revoked")
        return send(401, { error: { code: "INVALID_API_KEY", message: "This key was revoked." } });
      return send(200, {
        email: `${bearer}@stub`,
        plan: "free",
        livemode: !bearer.includes("test"),
        scopes: ["diagrams:read", "diagrams:write"],
      });
    }
    if (req.method === "GET" && url === "/api/v2/usage") {
      return send(200, { plan: "free", credits_remaining: 40 });
    }
    if (req.method === "POST" && url === "/api/v2/diagrams") {
      return send(402, {
        error: { code: "QUOTA_EXCEEDED", message: "You are out of credits.", upgrade_url: "https://diagrams.so/upgrade?src=mcp" },
      });
    }
    return send(404, { error: { code: "NOT_FOUND", message: url } });
  });
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${stub.address().port}/api/v2`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const freshHome = () => mkdtempSync(join(tmpdir(), "dgz-login-test-"));
const credPathIn = (home) => join(home, ".diagrams-so", "credentials.json");

function envFor(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, DIAGRAMS_NO_BROWSER: "1" };
  delete env.DIAGRAMS_API_KEY;
  delete env.DIAGRAMS_API_BASE;
  return Object.assign(env, extra);
}

function runCli(args, env, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: -1, out, err, all: out + err, timedOut: true }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, all: out + err }); });
  });
}

async function withMcp(env, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env });
  const client = new Client({ name: "device-login-test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content?.[0]?.text ?? "", isError: !!r.isError };
  };
  try {
    return await fn(call);
  } finally {
    await client.close();
  }
}

const DEVICE_CODE = (overrides = {}) => ({
  device_code: "dev-1",
  user_code: "ABCD-EFGH",
  verification_uri: `${base}/activate`,
  verification_uri_complete: `${base}/activate?user_code=ABCD-EFGH`,
  expires_in: 60,
  interval: 0,
  ...overrides,
});
const beginScenario = (deviceCode, tokenPlan) => {
  state.deviceCodeResponse = deviceCode;
  state.deviceCodeBodies = [];
  state.tokenPlan = tokenPlan;
  state.tokenTimes = [];
};

// ---------------------------------------------------------------------------
// 1 — happy path
// ---------------------------------------------------------------------------
console.log("-- login: happy path --");
const homeA = freshHome();
beginScenario(DEVICE_CODE(), [
  { status: 400, body: { error: "authorization_pending" } },
  { status: 200, body: { access_token: "dgz_live_tokA", token_type: "bearer", scope: "diagrams:read diagrams:write", livemode: true, expires_in: 3600 } },
]);
{
  const r = await runCli(["login", "--base-url", base], envFor(homeA));
  assert(r.code === 0, `login exits 0 (got ${r.code})`);
  assert(r.out.includes("ABCD-EFGH"), "user_code printed");
  assert(r.out.includes(`${base}/activate?user_code=ABCD-EFGH`), "verification_uri_complete printed");
  assert(r.out.includes("Connected as dgz_live_tokA@stub (live). ~40 credits left."), `connected line printed:\n${r.all}`);
  const dc = state.deviceCodeBodies[0] || {};
  assert(dc.client_id === "mcp" && dc.livemode === true && !!dc.device_name, "device/code body: client_id=mcp, livemode=true, device_name set");
  assert(state.tokenTimes.length === 2 && state.tokenTimes[1] - state.tokenTimes[0] < 2000, "authorization_pending polled again promptly");

  const cp = credPathIn(homeA);
  assert(existsSync(cp), "credentials.json written");
  assert((statSync(cp).mode & 0o777) === 0o600, "credentials.json is mode 0600");
  assert((statSync(join(homeA, ".diagrams-so")).mode & 0o777) === 0o700, "~/.diagrams-so is mode 0700");
  const raw = readFileSync(cp, "utf8");
  assert(raw.startsWith('{"version":1,"api_key":"dgz_live_tokA","scope":'), "cache JSON starts with the exact spec'd key order");
  const j = JSON.parse(raw);
  assert(
    JSON.stringify(Object.keys(j)) ===
      JSON.stringify(["version", "api_key", "scope", "livemode", "auth_method", "created_at", "expires_at", "base_url"]),
    "cache has exactly the spec'd keys in order",
  );
  assert(j.version === 1 && j.api_key === "dgz_live_tokA" && j.scope === "diagrams:read diagrams:write", "version/api_key/scope correct");
  assert(j.livemode === true && j.auth_method === "device" && j.base_url === base, "livemode/auth_method/base_url correct");
  const created = Date.parse(j.created_at);
  const expires = Date.parse(j.expires_at);
  assert(Number.isFinite(created) && Math.abs(Date.now() - created) < 60_000, "created_at is ISO8601 ~now");
  assert(Number.isFinite(expires) && Math.abs(expires - created - 3600_000) < 5_000, "expires_at = created_at + expires_in");
}

// ---------------------------------------------------------------------------
// 2 — --test flag
// ---------------------------------------------------------------------------
console.log("\n-- login --test --");
const homeB = freshHome();
beginScenario(DEVICE_CODE(), [
  { status: 200, body: { access_token: "dgz_test_tokB", token_type: "bearer", scope: "diagrams:read", livemode: false } },
]);
{
  const r = await runCli(["login", "--test", "--base-url", base], envFor(homeB));
  assert(r.code === 0, "login --test exits 0");
  assert(
    r.out.includes("Test keys charge the same credits as live — not a free sandbox (lower rate limits only)."),
    "test-mode warning printed",
  );
  assert(state.deviceCodeBodies[0]?.livemode === false, "device/code requested livemode:false");
  const j = JSON.parse(readFileSync(credPathIn(homeB), "utf8"));
  assert(j.api_key === "dgz_test_tokB" && j.livemode === false, "test key cached with livemode:false");
  assert(j.expires_at === null, "expires_at is null when the token has no expires_in");
  assert(r.out.includes("(test)"), "connected line shows test mode");
}

// ---------------------------------------------------------------------------
// 3 — slow_down honored
// ---------------------------------------------------------------------------
console.log("\n-- login: slow_down --");
const homeC = freshHome();
beginScenario(DEVICE_CODE(), [
  { status: 400, body: { error: "slow_down" } },
  { status: 200, body: { access_token: "dgz_live_tokC", token_type: "bearer", scope: "diagrams:read", livemode: true, expires_in: 3600 } },
]);
{
  const r = await runCli(["login", "--base-url", base], envFor(homeC));
  assert(r.code === 0, "login exits 0 after slow_down");
  const gap = state.tokenTimes[1] - state.tokenTimes[0];
  assert(state.tokenTimes.length === 2 && gap >= 4500, `slow_down grew the poll interval by 5s (gap ${gap}ms)`);
}

// ---------------------------------------------------------------------------
// 4/5/6 — terminal error codes
// ---------------------------------------------------------------------------
console.log("\n-- login: terminal errors --");
for (const [err, expected] of [
  ["access_denied", "Login denied."],
  ["expired_token", "Code expired — run login again."],
  ["key_limit_reached", "You have 25 active keys. Revoke one at https://diagrams.so/api-keys, then re-run login."],
]) {
  const home = freshHome();
  beginScenario(DEVICE_CODE(), [{ status: 400, body: { error: err } }]);
  const r = await runCli(["login", "--base-url", base], envFor(home));
  assert(r.code === 1, `${err}: exits 1 (got ${r.code})`);
  assert(r.all.includes(expected), `${err}: prints "${expected}"`);
  assert(!existsSync(credPathIn(home)), `${err}: no cache file left behind`);
}

// 7 — local expiry
{
  const home = freshHome();
  beginScenario(DEVICE_CODE({ expires_in: 1 }), [{ status: 400, body: { error: "authorization_pending" } }]);
  const r = await runCli(["login", "--base-url", base], envFor(home));
  assert(r.code === 1 && r.all.includes("Timed out waiting for approval — run login again."), "local expires_in elapse: timed-out message + exit 1");
}

// ---------------------------------------------------------------------------
// 8/9 — CLI whoami: env precedence, then cache
// ---------------------------------------------------------------------------
console.log("\n-- whoami: credential precedence (CLI) --");
{
  const r = await runCli(["whoami"], envFor(homeA, { DIAGRAMS_API_KEY: "dgz_live_envkey", DIAGRAMS_API_BASE: base }));
  assert(r.code === 0 && r.out.includes("dgz_live_envkey@stub"), "env var wins over the cache");
  assert(r.out.includes("env (DIAGRAMS_API_KEY)"), "whoami reports source env");
}
{
  const r = await runCli(["whoami"], envFor(homeA, { DIAGRAMS_API_BASE: base }));
  assert(r.code === 0 && r.out.includes("dgz_live_tokA@stub"), "cache used when no env var");
  assert(r.out.includes("login ("), "whoami reports source login");
}

// ---------------------------------------------------------------------------
// 10/11 — MCP server: env precedence, then cache
// ---------------------------------------------------------------------------
console.log("\n-- MCP server: credential precedence --");
await withMcp(envFor(homeA, { DIAGRAMS_API_KEY: "dgz_live_envkey", DIAGRAMS_API_BASE: base }), async (call) => {
  const r = await call("whoami");
  assert(!r.isError && r.text.includes("dgz_live_envkey@stub"), "server: env var wins over the cache");
});
await withMcp(envFor(homeA, { DIAGRAMS_API_BASE: base }), async (call) => {
  const r = await call("whoami");
  assert(!r.isError && r.text.includes("dgz_live_tokA@stub"), "server: cache credential used when no env var");
});

// ---------------------------------------------------------------------------
// 12/13 — corrupt cache + base_url mismatch → treated as absent
// ---------------------------------------------------------------------------
console.log("\n-- corrupt / mismatched cache --");
const NOT_CONNECTED = "Not connected — run `npx @diagrams-so/mcp login` in a terminal (or set DIAGRAMS_API_KEY).";
{
  const home = freshHome();
  mkdirSync(join(home, ".diagrams-so"), { recursive: true });
  writeFileSync(credPathIn(home), "{ this is not json", { mode: 0o600 });
  await withMcp(envFor(home, { DIAGRAMS_API_BASE: base, DIAGRAMS_NO_AUTO_LOGIN: "1" }), async (call) => {
    const r = await call("whoami");
    assert(r.isError && r.text.includes(NOT_CONNECTED), "server: corrupt cache treated as absent (actionable message, no crash)");
  });
  // Auto-login ON (default): the same corrupt cache yields a clickable connect
  // offer instead — the no-terminal path for Claude Desktop.
  state.deviceCodeResponse = {
    device_code: "dev-inline-1",
    user_code: "TQRV-9WXZ",
    verification_uri: "https://diagrams.so/device",
    verification_uri_complete: "https://diagrams.so/device?code=TQRV-9WXZ",
    expires_in: 900,
    interval: 5,
  };
  state.tokenPlan = [{ status: 400, body: { error: "authorization_pending" } }];
  await withMcp(envFor(home, { DIAGRAMS_API_BASE: base }), async (call) => {
    const r = await call("whoami");
    assert(r.isError && /device\?code=[A-Z0-9-]{9}/.test(r.text), "server: in-tool connect offers a link with a code");
    assert(r.isError && r.text.includes("click Approve"), "server: connect offer explains the approve step");
  });
  const cli = await runCli(["whoami"], envFor(home, { DIAGRAMS_API_BASE: base }));
  assert(cli.code === 1 && cli.all.includes(NOT_CONNECTED), "CLI: corrupt cache treated as absent");
}
{
  const home = freshHome();
  mkdirSync(join(home, ".diagrams-so"), { recursive: true });
  writeFileSync(
    credPathIn(home),
    JSON.stringify({
      version: 1, api_key: "dgz_live_otherbase", scope: "", livemode: true, auth_method: "device",
      created_at: new Date().toISOString(), expires_at: null, base_url: "https://other.example/api/v2",
    }),
    { mode: 0o600 },
  );
  await withMcp(envFor(home, { DIAGRAMS_API_BASE: base, DIAGRAMS_NO_AUTO_LOGIN: "1" }), async (call) => {
    const r = await call("whoami");
    assert(r.isError && r.text.includes(NOT_CONNECTED), "server: cache with mismatched base_url is ignored");
  });
}

// ---------------------------------------------------------------------------
// 14/15 — 402 and 401 mappings
// ---------------------------------------------------------------------------
console.log("\n-- 402 / 401 error mappings --");
await withMcp(envFor(freshHome(), { DIAGRAMS_API_KEY: "dgz_live_envkey", DIAGRAMS_API_BASE: base, DIAGRAMS_API_RETRY_DELAYS_MS: "10,10,10" }), async (call) => {
  const r = await call("generate_diagram", { prompt: "anything" });
  assert(
    r.isError &&
      r.text.includes("Out of credits — free credits are one-time. Top up ($5 for 25) or upgrade: https://diagrams.so/upgrade?src=mcp"),
    "402 QUOTA_EXCEEDED maps to the out-of-credits wording with upgrade_url",
  );
});
await withMcp(envFor(freshHome(), { DIAGRAMS_API_KEY: "dgz_revoked", DIAGRAMS_API_BASE: base }), async (call) => {
  const r = await call("whoami");
  assert(
    r.isError && r.text.includes("Session credential expired or revoked — run `npx @diagrams-so/mcp login` again."),
    "401 maps to the run-login-again wording",
  );
});

clearTimeout(guard);
stub.close();
console.log(`\n✓ device-login test passed — ${passed} assertions`);
process.exit(0);
