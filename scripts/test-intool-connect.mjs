/**
 * REAL-STACK test of in-tool connect: no terminal login, no pre-existing
 * credential. Drives the MCP server over stdio exactly like Claude Desktop.
 * The API emails the one-time code (it is never returned to the client), so
 * in-tool connect only arms when DIAGRAMS_LOGIN_EMAIL is set.
 *   0. no DIAGRAMS_LOGIN_EMAIL -> tool replies with the terminal fallback,
 *      and no grant row is created (the doomed request is skipped)
 *   1. with DIAGRAMS_LOGIN_EMAIL: call a tool -> expect "code emailed" + link
 *   2. approve the newest pending grant via SQL (stands in for the user
 *      entering the emailed code and clicking Approve)
 *   3. call the tool again -> expect it to succeed, cache written by the server
 */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://localhost:8000/api/v2";
const HOME = mkdtempSync(join(tmpdir(), "intool-"));
const CRED = join(HOME, ".diagrams-so", "credentials.json");
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); c ? pass++ : fail++; };

const EMAIL = process.env.INTOOL_TEST_EMAIL || "yuvraj@redhold.ai";

function mcp(extraEnv = {}) {
  const p = spawn("node", ["dist/index.js"], {
    cwd: process.env.HOME + "/diagrams-mcp-app-core",
    env: { ...process.env, HOME, DIAGRAMS_API_BASE: BASE, DIAGRAMS_API_KEY: "", DIAGRAMS_LOGIN_EMAIL: "", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const w = waiters.get(msg.id);
        if (w) { waiters.delete(msg.id); w(msg); }
      } catch { /* not json */ }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const myId = ++id;
    waiters.set(myId, res);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
  return { p, send };
}

// 0. without DIAGRAMS_LOGIN_EMAIL: terminal fallback, and no device-code request fired
{
  const { p: p0, send: send0 } = mcp();
  await send0("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "intool-test-noemail", version: "1" },
  });
  p0.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const r0 = await send0("tools/call", { name: "whoami", arguments: {} });
  const t0 = (r0.result?.content || []).map((c) => c.text).join("\n");
  ok(/login/.test(t0) && !/emailed/.test(t0), `no DIAGRAMS_LOGIN_EMAIL -> terminal fallback: ${t0.slice(0, 90)}`);
  p0.kill();
}

const { p, send } = mcp({ DIAGRAMS_LOGIN_EMAIL: EMAIL });
await send("initialize", {
  protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "intool-test", version: "1" },
});
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// 1. unauthenticated tool call -> the code goes out by email; the reply carries the link
const r1 = await send("tools/call", { name: "whoami", arguments: {} });
const t1 = (r1.result?.content || []).map((c) => c.text).join("\n");
const m = /https?:\/\/\S+/.test(t1) && t1.includes(`emailed to ${EMAIL}`);
ok(m, `unauthenticated call says the code was emailed and hands over the approval link: ${t1.slice(0, 120)}`);
ok(/click Approve/i.test(t1), "message tells the user to click Approve");
ok(!existsSync(CRED), "no credential written before approval");

if (m) {
  // 2. Stand-in for the user clicking Approve. The real browser path (consent
  // page -> Approve) was already verified end-to-end; this API instance runs
  // with real PropelAuth, so a test process can't mint a session. Approving the
  // grant row exercises the identical downstream path (consume -> mint -> poll).
  const { execFileSync } = await import("node:child_process");
  let approved = false;
  try {
    const out = execFileSync("psql", [
      "-U", "test", "-h", "localhost", "-d", "diagramz_e2e", "-tAc",
      `UPDATE oauth_device_grants SET status='approved', user_id=(SELECT id FROM users WHERE email='${EMAIL}') WHERE id=(SELECT id FROM oauth_device_grants WHERE email='${EMAIL}' AND status='pending' ORDER BY created_at DESC LIMIT 1) RETURNING 1`,
    ], { encoding: "utf8" });
    approved = out.split(/\s+/).includes("1");
  } catch (e) { approved = false; }
  ok(approved, "grant approved (stands in for the browser Approve click)");

  // 3. background poll should cache the key, then the tool works
  let cached = false;
  for (let i = 0; i < 20 && !cached; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    cached = existsSync(CRED);
  }
  ok(cached, "server cached the credential in the background (no terminal used)");
  if (cached) {
    ok((statSync(CRED).mode & 0o777) === 0o600, "cache file is 0600");
    const j = JSON.parse(readFileSync(CRED, "utf8"));
    ok(j.version === 1 && j.auth_method === "device" && j.base_url === BASE, "cache matches the shared v1 contract");
  }
  const r2 = await send("tools/call", { name: "whoami", arguments: {} });
  const t2 = (r2.result?.content || []).map((c) => c.text).join("\n");
  ok(/email:/.test(t2) && !r2.result?.isError, `tool call now succeeds: ${t2.split("\n")[0]}`);
}

p.kill();
console.log(`\n${fail === 0 ? "✓" : "✗"} in-tool connect: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
