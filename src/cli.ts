/**
 * CLI subcommands for the @diagrams-so/mcp bin (v1.4.1).
 *
 *   login  [--test] [--base-url <url>]  — OAuth 2.0 Device Authorization Grant
 *                                         (RFC 8628); caches the minted API key
 *                                         in ~/.diagrams-so/credentials.json.
 *   logout                              — delete the cached credential.
 *   whoami                              — show which credential would be used
 *                                         (env vs login) and the account behind it.
 *   install [claude-code|claude-desktop|cursor]
 *                                       — print ready-to-paste MCP client config.
 *
 * Terminal-facing only: a human ran the bin with a subcommand. The MCP server
 * path (no args) never loads this module.
 */

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  BASE,
  CLIENT_ID,
  CRED_DIR,
  CRED_PATH,
  NOT_CONNECTED_MSG,
  USER_AGENT,
  readCachedCredentials,
  sleep,
  writeCredentials,
  credentialRecord,
  postDeviceJson,
  CLI_NAME,
} from "./client.js";

// ---------------------------------------------------------------------------
// Small fetch helpers (the device-flow endpoints use OAuth's flat error shape
// {"error":"<code>"}, not the API's house envelope, so apiRequest doesn't fit).
// ---------------------------------------------------------------------------


async function getJsonAuthed(url: string, key: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT, "X-Diagrams-Client": CLIENT_ID },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Only auto-open server-supplied URLs that are https, or http to a loopback
 * host (self-hosted/dev). Anything else — javascript:, file:, leading-dash
 * argument tricks — is refused; the URL is still printed for the human. */
function isSafeToOpen(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

/** Best-effort cross-platform browser open. Failures are silently ignored —
 * the verification URL is printed either way. On Windows we use rundll32's
 * FileProtocolHandler instead of `cmd /c start`: cmd re-parses its argument
 * line, so URL metacharacters (&, ^, ") could inject commands (CVE-2024-27980
 * class); rundll32 takes the URL as a plain argv entry. */
function openBrowser(url: string): void {
  if (process.env.DIAGRAMS_NO_BROWSER) return;
  if (!isSafeToOpen(url)) return;
  // DIAGRAMS_BROWSER lets you target a non-default browser — your account
  // session often lives in one specific browser (e.g. "Google Chrome").
  const pick = (process.env.DIAGRAMS_BROWSER || "").trim();
  try {
    const [cmd, args]: [string, string[]] = pick
      ? process.platform === "darwin"
        ? ["open", ["-a", pick, url]]
        : [pick, [url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore — the URL is printed */
  }
}

// ---------------------------------------------------------------------------
// Credential cache write (atomic: tmp file + rename, dir 0700, file 0600).
// write+rename are both synchronous, so a Ctrl-C can never land between them —
// credentials.json is either the old content or the complete new content.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Shared "who is this key" line: email + mode from /me, approx credits from
// /me if present, else /usage. Every field is optional — print what we can.
// ---------------------------------------------------------------------------

const OUT_OF_CREDITS_MSG_FALLBACK =
  "Out of credits — free credits are one-time. Top up ($5 for 25) or upgrade: https://diagrams.so/pricing";

async function accountLine(base: string, key: string, fallbackLivemode?: boolean): Promise<string> {
  const m = await getJsonAuthed(`${base}/me`, key);
  const email = m?.email ?? "(unknown email)";
  const livemode = typeof m?.livemode === "boolean" ? m.livemode : fallbackLivemode;
  const mode = livemode === undefined ? "unknown mode" : livemode ? "live" : "test";
  let credits: unknown = m?.credits_remaining ?? m?.credits;
  if (typeof credits !== "number") {
    try {
      const u = await getJsonAuthed(`${base}/usage`, key);
      credits = u?.credits_remaining ?? u?.credits_left ?? u?.credits?.remaining ?? u?.credits;
    } catch {
      /* credits stay unknown */
    }
  }
  return (
    `Connected as ${email} (${mode}).` + (typeof credits === "number" ? ` ~${credits} credits left.` : "")
  );
}

// ---------------------------------------------------------------------------
// login — RFC 8628 device flow (code delivered by email, never in a URL)
// ---------------------------------------------------------------------------

function promptEmail(): Promise<string> {
  // Interactive command; if stdin isn't a TTY, allow DIAGRAMS_LOGIN_EMAIL so
  // automation can still supply the address.
  if (!process.stdin.isTTY) return Promise.resolve((process.env.DIAGRAMS_LOGIN_EMAIL || "").trim());
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Email to receive your sign-in code: ", (a) => {
      rl.close();
      resolve((a || "").trim());
    });
  });
}

async function confirmKey(base: string, apiKey: string): Promise<void> {
  // Best-effort: once the new key is saved, tell the server so it can retire the
  // previous same-device key. A failure just leaves the old key valid — never a lockout.
  try {
    await fetch(`${base}/oauth/device/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
        "X-Diagrams-Client": CLIENT_ID,
      },
      body: "{}",
    });
  } catch {
    /* ignore — old key simply lives on */
  }
}

async function cmdLogin(args: string[]): Promise<number> {
  let livemode = true;
  let base = BASE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--test") livemode = false;
    else if (a === "--base-url") {
      const v = args[++i];
      if (!v) {
        console.error("--base-url requires a value.");
        return 1;
      }
      base = v.replace(/\/+$/, "");
    } else {
      console.error(`Unknown option: ${a}\nUsage: login [--test] [--base-url <url>]`);
      return 1;
    }
  }

  const email = await promptEmail();
  if (!email || !email.includes("@")) {
    console.error("A valid email is required to receive your sign-in code.");
    return 1;
  }

  let dc: any;
  try {
    const r = await postDeviceJson(`${base}/oauth/device/code`, {
      client_id: "mcp",
      livemode,
      device_name: hostname(),
      email,
    });
    if (r.status !== 200 || !r.json?.device_code) {
      console.error(`Could not start login (HTTP ${r.status}): ${JSON.stringify(r.json)}`);
      return 1;
    }
    dc = r.json;
  } catch (e: any) {
    console.error(`Could not reach ${base}: ${e?.message ?? e}`);
    return 1;
  }

  // The one-time code is EMAILED (never in a URL). Open the plain page; the user
  // signs in and enters the code from their inbox.
  const verifyUrl = String(dc.verification_uri || "https://diagrams.so/device");
  console.log("");
  console.log(`  We emailed a sign-in code to ${email}.`);
  console.log(`  Opening ${verifyUrl} — sign in and enter the code to approve.`);
  console.log("  (If your browser didn't open, visit the link above yourself.)");
  if (!livemode) {
    console.log("");
    console.log("  Test keys charge the same credits as live — not a free sandbox (lower rate limits only).");
  }
  console.log("");
  openBrowser(verifyUrl);

  let interval = Number.isFinite(Number(dc.interval)) ? Math.max(0, Number(dc.interval)) : 5;
  const expiresInMs = Number(dc.expires_in) > 0 ? Number(dc.expires_in) * 1000 : 900_000;
  const deadline = Date.now() + expiresInMs;
  process.stdout.write("  Waiting for approval");

  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    let status: number;
    let json: any;
    try {
      ({ status, json } = await postDeviceJson(`${base}/oauth/device/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dc.device_code,
        client_id: "mcp",
      }));
    } catch {
      // transient network blip — keep polling until the code expires
      process.stdout.write("!");
      continue;
    }

    if (status === 200 && json?.access_token) {
      console.log("\n");
      return finishLogin(base, json);
    }

    const err = typeof json?.error === "string" ? json.error : json?.error?.code;
    if (err === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    console.log(""); // end the dots line before the verdict
    if (err === "access_denied") {
      console.error("Login denied.");
      return 1;
    }
    if (err === "expired_token") {
      console.error("Code expired — run login again.");
      return 1;
    }
    if (err === "key_limit_reached") {
      console.error("You have 25 active keys. Revoke one at https://diagrams.so/api-keys, then re-run login.");
      return 1;
    }
    console.error(`Login failed (HTTP ${status}): ${err ?? JSON.stringify(json)}`);
    return 1;
  }

  console.log("");
  console.error("Timed out waiting for approval — run login again.");
  return 1;
}

async function finishLogin(base: string, tok: any): Promise<number> {
  const record = credentialRecord(base, tok);
  try {
    writeCredentials(record);
    console.log(`Credential saved to ${CRED_PATH}.`);
  } catch (e: any) {
    console.error(`Could not write ${CRED_PATH}: ${e?.message ?? e}`);
    console.error("");
    if (process.stdout.isTTY && process.stderr.isTTY) {
      // Cache write failed — surface the key ONCE so the login isn't lost.
      // TTY-only: never leak a live key into CI logs or piped scrollback.
      console.error(`Your API key (shown once — it is not stored anywhere locally): ${tok.access_token}`);
      console.error("Set it manually, e.g. in your MCP client config or shell:");
      console.error(`  export DIAGRAMS_API_KEY="${tok.access_token}"`);
    } else {
      console.error("Login succeeded but the credential could not be saved. Re-run login in an interactive terminal.");
    }
  }

  // Now that the new key is in hand, confirm it so the server retires the
  // previous same-device key. Deferred until here so a failed save never
  // revokes the old key and strands the user (the lockout we're preventing).
  await confirmKey(base, String(tok.access_token));

  try {
    console.log(await accountLine(base, String(tok.access_token), record.livemode));
  } catch (e: any) {
    console.log(`Logged in, but could not fetch account details (${e?.message ?? e}).`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// logout / whoami
// ---------------------------------------------------------------------------

function cmdLogout(): number {
  try {
    unlinkSync(CRED_PATH);
    console.log(`Logged out — removed ${CRED_PATH}.`);
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      console.log("Logged out — no cached credential to remove.");
    } else {
      console.error(`Could not remove ${CRED_PATH}: ${e?.message ?? e}`);
      return 1;
    }
  }
  return 0;
}

async function cmdWhoami(args: string[]): Promise<number> {
  let base = BASE;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--base-url") {
      const v = args[++i];
      if (!v) {
        console.error("--base-url requires a value.");
        return 1;
      }
      base = v.replace(/\/+$/, "");
    } else {
      console.error(`Unknown option: ${a}\nUsage: whoami [--base-url <url>]`);
      return 1;
    }
  }
  const env = process.env.DIAGRAMS_API_KEY;
  let key: string | undefined;
  let source: string | undefined;
  if (env) {
    key = env;
    source = "env (DIAGRAMS_API_KEY)";
  } else {
    const cached = readCachedCredentials(base);
    if (cached) {
      key = cached.api_key;
      source = `login (${CRED_PATH})`;
    }
  }
  if (!key) {
    console.log(NOT_CONNECTED_MSG);
    return 1;
  }
  try {
    console.log(await accountLine(base, key));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error(`Credential source: ${source}`);
    // Same wording the tools use, so every surface says the same thing (F4).
    if (msg.includes("401")) {
      console.error(`Session credential expired or revoked — run \`${CLI_NAME} login\` again.`);
    } else if (msg.includes("402")) {
      console.error(OUT_OF_CREDITS_MSG_FALLBACK);
    } else {
      console.error(`Could not verify the credential against ${base}: ${msg}`);
    }
    return 1;
  }
  console.log(`Credential source: ${source}`);
  return 0;
}

// ---------------------------------------------------------------------------
// install — print (never write) ready-to-paste client config
// ---------------------------------------------------------------------------

const MCP_SERVERS_JSON = JSON.stringify(
  { mcpServers: { "diagrams-so": { command: "npx", args: ["-y", "@diagrams-so/mcp"] } } },
  null,
  2,
);

function printInstall(target?: string): number {
  const all = !target;
  if (target && !["claude-code", "claude-desktop", "cursor"].includes(target)) {
    console.error(`Unknown client "${target}" — showing all. (Valid: claude-code, claude-desktop, cursor)`);
    target = undefined;
  }
  if (all || target === "claude-code" || target === undefined) {
    console.log("── Claude Code ──────────────────────────────────────────────");
    console.log("  claude mcp add diagrams-so -- npx -y @diagrams-so/mcp");
    console.log("");
  }
  if (all || target === "claude-desktop" || target === undefined) {
    console.log("── Claude Desktop ───────────────────────────────────────────");
    console.log("  Add to claude_desktop_config.json:");
    console.log("    macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json");
    console.log("    Windows: %APPDATA%\\Claude\\claude_desktop_config.json");
    console.log("");
    console.log(MCP_SERVERS_JSON);
    console.log("");
  }
  if (all || target === "cursor" || target === undefined) {
    console.log("── Cursor ───────────────────────────────────────────────────");
    console.log("  Add to .cursor/mcp.json (project) or ~/.cursor/mcp.json (global):");
    console.log("");
    console.log(MCP_SERVERS_JSON);
    console.log("");
  }
  console.log("After `login`, no API key env var is needed.");
  return 0;
}

// ---------------------------------------------------------------------------

export async function runCli(cmd: string, rest: string[]): Promise<number> {
  switch (cmd) {
    case "login":
      return cmdLogin(rest);
    case "logout":
      return cmdLogout();
    case "whoami":
      return cmdWhoami(rest);
    case "install":
      return printInstall(rest[0]);
    default:
      console.error(`Unknown command: ${cmd}`);
      return 1;
  }
}
