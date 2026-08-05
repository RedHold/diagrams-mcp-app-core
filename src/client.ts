/**
 * Thin HTTP client for the Diagrams.so public API (/api/v2).
 *
 * The MCP server is a pure client: every tool goes through here, and this file
 * is the ONLY place that knows about HTTP, auth, or the API's error shape.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const BASE = (process.env.DIAGRAMS_API_BASE || "https://api.diagrams.so/api/v2").replace(/\/+$/, "");
// Identify this client so the API attributes charges to source="mcp" in the
// credit-consumption history (X-Diagrams-Client wins; User-Agent is a fallback).
export const CLIENT_ID = "mcp/1.4.2";
export const USER_AGENT = "@diagrams-so/mcp/1.4.2";
// Safety-net timeout so a hung/slow API surfaces a clean tool error instead of
// hanging the MCP client forever. 450s sits ABOVE the server-side ladder
// (LLM worst-case ~160s < gunicorn 300s < nginx 330s < ALB 360s) so the client
// never aborts work the server would still deliver. Override with
// DIAGRAMS_API_TIMEOUT_MS.
const TIMEOUT_MS = Math.max(1000, Number(process.env.DIAGRAMS_API_TIMEOUT_MS) || 450_000);

/** The API's house error envelope: {error:{code,message,request_id,details}}. */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Credential resolution: DIAGRAMS_API_KEY env > `login` cache file > none.
//
// The cache is written by the `login` CLI subcommand (OAuth device flow) to
// ~/.diagrams-so/credentials.json. It is honored only when it is well-formed
// JSON, version === 1, has an api_key, AND was minted against the SAME base
// URL this process is configured for — a key for prod must never be sent to a
// self-hosted API (or vice versa). Any read/parse problem = treated as absent;
// resolution never throws.
// ---------------------------------------------------------------------------

export const CRED_DIR = join(homedir(), ".diagrams-so");
export const CRED_PATH = join(CRED_DIR, "credentials.json");

export interface CachedCredentials {
  version: 1;
  api_key: string;
  scope?: string;
  livemode?: boolean;
  auth_method?: string;
  created_at?: string;
  expires_at?: string | null;
  base_url?: string;
}

/** Read + validate the login cache, or null. Never throws. */
export function readCachedCredentials(baseUrl: string = BASE): CachedCredentials | null {
  try {
    const j: any = JSON.parse(readFileSync(CRED_PATH, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    if (j.version !== 1) return null;
    if (typeof j.api_key !== "string" || !j.api_key) return null;
    if (j.base_url !== baseUrl) return null;
    return j as CachedCredentials;
  } catch {
    return null;
  }
}

/** Resolve the credential to use, with its provenance. Resolved per request so
 * a `login` run while the server is up is picked up without a restart. */
export function resolveCredential(): { key: string; source: "env" | "login" } | null {
  const env = process.env.DIAGRAMS_API_KEY;
  if (env) return { key: env, source: "env" };
  const cached = readCachedCredentials(BASE);
  if (cached) return { key: cached.api_key, source: "login" };
  return null;
}

/** How to tell the user to run the CLI. When the package is installed (globally
 * or otherwise) argv[1] is one of our bin names, so we can suggest the short
 * command; otherwise fall back to the zero-install npx form. */
export const CLI_NAME = (() => {
  try {
    const b = (process.argv[1] || "").split(/[\\/]/).pop() || "";
    if (b === "diagrams-so" || b === "diagrams-so-mcp") return b;
  } catch {
    /* fall through */
  }
  return "npx @diagrams-so/mcp";
})();

export const NOT_CONNECTED_MSG =
  `Not connected — run \`${CLI_NAME} login\` in a terminal (or set DIAGRAMS_API_KEY).`;

// ---------------------------------------------------------------------------
// Credential cache WRITE (shared by `login` and in-tool connect, so the on-disk
// contract can never drift between the two paths).
// Atomic: tmp file + rename; dir 0700, file 0600; random tmp name + O_EXCL so a
// local attacker can't pre-plant a symlink at a predictable path.
// ---------------------------------------------------------------------------
export function writeCredentials(record: object): void {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CRED_DIR, 0o700); // a pre-existing dir may be looser
  } catch {
    /* best-effort */
  }
  const tmp = join(CRED_DIR, `.credentials.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, CRED_PATH);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp may not exist */
    }
    throw e;
  }
}

/** The v1 on-disk credential record — one definition, used by every write path. */
export interface CredentialRecord {
  version: 1;
  api_key: string;
  scope: string;
  livemode: boolean;
  auth_method: "device";
  created_at: string;
  expires_at: string | null;
  base_url: string;
}

export function credentialRecord(base: string, tok: any): CredentialRecord {
  const now = new Date();
  const expiresIn = Number(tok?.expires_in) || 0;
  return {
    version: 1,
    api_key: String(tok.access_token),
    scope: typeof tok.scope === "string" ? tok.scope : "",
    livemode: Boolean(tok.livemode),
    auth_method: "device",
    created_at: now.toISOString(),
    expires_at: expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
    base_url: base,
  };
}

/** POST helper for the device endpoints (flat OAuth error shape, not the house
 * envelope — so apiRequest doesn't fit). */
export async function postDeviceJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, "X-Diagrams-Client": CLIENT_ID },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// In-tool connect (no terminal): when a tool runs with no credential we start a
// device-flow grant, hand the user a link to click, and poll in the background.
// The moment they approve, the key is cached and the next tool call just works
// — the whole flow stays inside the chat client (Claude Desktop has no terminal).
// Disable with DIAGRAMS_NO_AUTO_LOGIN=1 (CI/headless).
// ---------------------------------------------------------------------------
interface PendingConnect {
  url: string;
  code: string;
  expiresAt: number;
}
let pendingConnect: PendingConnect | null = null;

function connectMessage(p: PendingConnect): string {
  return (
    `Not connected to your Diagrams.so account yet — this takes about 15 seconds:\n\n` +
    `1. Open ${p.url}\n` +
    `2. Check the page shows code ${p.code}, then click Approve\n` +
    `3. Ask me again — I'll be connected.\n\n` +
    `New here? You can sign up on that page. Prefer a terminal? Run ` +
    `\`npx @diagrams-so/mcp login\` instead, or set DIAGRAMS_API_KEY for CI.`
  );
}

/** Poll the token endpoint until approval/expiry, then cache the key. Silent by
 * design (stdout is the MCP transport — never write to it). Timers are unref'd
 * so this can never keep the process alive. */
function pollConnectInBackground(deviceCode: string, intervalSec: number, deadline: number): void {
  let interval = Math.max(1, intervalSec);
  const tick = async (): Promise<void> => {
    if (Date.now() >= deadline) {
      pendingConnect = null;
      return;
    }
    try {
      const { status, json } = await postDeviceJson(`${BASE}/oauth/device/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "mcp",
      });
      if (status === 200 && json?.access_token) {
        try {
          writeCredentials(credentialRecord(BASE, json));
        } catch {
          /* unwritable HOME — the user can still run `login` and see the key */
        }
        pendingConnect = null;
        return;
      }
      const err = typeof json?.error === "string" ? json.error : json?.error?.code;
      if (err === "slow_down") interval += 5;
      if (err === "access_denied" || err === "expired_token" || err === "key_limit_reached") {
        pendingConnect = null;
        return;
      }
    } catch {
      /* transient network blip — keep polling until the deadline */
    }
    setTimeout(() => void tick(), interval * 1000).unref();
  };
  setTimeout(() => void tick(), interval * 1000).unref();
}

/** Start (or reuse) an in-tool connect grant. Returns null when disabled or if
 * the API can't be reached — callers fall back to NOT_CONNECTED_MSG. */
export async function beginConnect(): Promise<PendingConnect | null> {
  if (process.env.DIAGRAMS_NO_AUTO_LOGIN) return null;
  if (pendingConnect && Date.now() < pendingConnect.expiresAt) return pendingConnect;
  try {
    const { status, json } = await postDeviceJson(`${BASE}/oauth/device/code`, {
      client_id: "mcp",
      livemode: true,
      device_name: hostname(),
    });
    if (status !== 200 || !json?.device_code || !json?.user_code) return null;
    const ttlMs = (Number(json.expires_in) > 0 ? Number(json.expires_in) : 900) * 1000;
    pendingConnect = {
      url: String(json.verification_uri_complete || json.verification_uri),
      code: String(json.user_code),
      expiresAt: Date.now() + ttlMs,
    };
    pollConnectInBackground(
      String(json.device_code),
      Number(json.interval) > 0 ? Number(json.interval) : 5,
      pendingConnect.expiresAt,
    );
    return pendingConnect;
  } catch {
    return null;
  }
}

/** Message for an unauthenticated tool call: a clickable connect link when we
 * can start a grant, else the terminal instruction. */
export async function notConnectedMessage(): Promise<string> {
  const p = await beginConnect();
  return p ? connectMessage(p) : NOT_CONNECTED_MSG;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOpts {
  query?: Query;
  body?: unknown;
  raw?: boolean; // export returns raw drawio/svg text, not JSON
  /** Sent as Idempotency-Key. The API replays the stored response for a repeat
   * of the same key+body within 24h instead of re-running (and re-billing). */
  idempotencyKey?: string;
}

export async function apiRequest<T = any>(
  method: string,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const cred = resolveCredential();
  if (!cred) {
    throw new ApiError("NO_API_KEY", await notConnectedMessage(), 0);
  }

  const url = new URL(BASE + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.key}`,
    "User-Agent": USER_AGENT,
    "X-Diagrams-Client": CLIENT_ID,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new ApiError(
        "TIMEOUT",
        `The Diagrams.so API did not respond within ${Math.round(TIMEOUT_MS / 1000)}s.`,
        0,
      );
    }
    throw new ApiError(
      "CONNECTION_ERROR",
      `Could not reach the Diagrams.so API at ${BASE}. Is it running? (${e?.message || e})`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get("content-type") || "";
  let requestId = res.headers.get("x-request-id") || undefined;

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText || "Request failed";
    let j: any = null;
    if (contentType.includes("application/json")) {
      j = await res.json().catch(() => null);
      if (j?.error?.code) {
        // House envelope: {error:{code,message,request_id,details}}
        code = j.error.code;
        message = j.error.message || message;
        requestId = requestId || j.error.request_id;
        if (j.error.details) message += ` (${typeof j.error.details === "string" ? j.error.details : JSON.stringify(j.error.details)})`;
      } else if (j?.detail) {
        // FastAPI validation errors (422) come as {detail:[...]}
        message = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
      }
    } else {
      message = (await res.text().catch(() => "")) || message;
    }
    // Actionable auth/billing mappings (the raw server text is less useful to
    // an agent than the fix):
    if (res.status === 401) {
      message = "Session credential expired or revoked — run `npx @diagrams-so/mcp login` again.";
    } else if (res.status === 402) {
      const upgradeUrl =
        j?.error?.upgrade_url ?? j?.error?.details?.upgrade_url ?? j?.upgrade_url ?? "https://diagrams.so/billing";
      message = `Out of credits — free credits are one-time. Top up ($5 for 25) or upgrade: ${upgradeUrl}`;
    }
    throw new ApiError(code, message, res.status, requestId);
  }

  // 204 No Content (e.g. delete) — nothing to parse.
  if (res.status === 204) return undefined as unknown as T;
  if (opts.raw || !contentType.includes("application/json")) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Billable calls: idempotency + bounded same-key retry (audit M2).
//
// The failure this exists for: a generation can outlive an intermediary's
// timeout — the client sees 504/timeout while the server finishes, BILLS, and
// stores the response under the Idempotency-Key. Retrying with the SAME key
// replays that stored response (diagram id recovered, zero double-charge);
// retrying without a key would create a second diagram and a second charge.
// ---------------------------------------------------------------------------

/** Errors where the outcome is UNKNOWN (work may have completed server-side). */
export function isAmbiguous(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.code === "TIMEOUT" || e.code === "CONNECTION_ERROR") return true;
  if (e.status === 502 || e.status === 503 || e.status === 504) return true;
  // Same key, original still running server-side — wait and re-ask.
  if (e.code === "IDEMPOTENCY_IN_PROGRESS" || e.status === 409) return true;
  return false;
}

// Overridable for tests (comma-separated ms); defaults chosen so the three
// retries fit inside one MCP tool call even on a slow API.
const RETRY_DELAYS_MS = (process.env.DIAGRAMS_API_RETRY_DELAYS_MS || "5000,15000,30000")
  .split(",")
  .map((s) => Math.max(0, Number(s.trim()) || 0));

// Hard wall-clock ceiling for one billable call INCLUDING retries. Without it,
// worst case is (attempts × TIMEOUT_MS) + delays ≈ 30 minutes, which every MCP
// host would kill anyway. When the budget is exhausted we stop retrying and
// surface the last ambiguous error (the unknown-charge tally path handles it).
const TOTAL_BUDGET_MS = Math.max(
  10_000,
  Number(process.env.DIAGRAMS_API_TOTAL_BUDGET_MS) || 600_000,
);

/** POST a billable call with a fresh Idempotency-Key and bounded same-key
 * retries on ambiguous failures. Definite rejections (401/402/404/422 …) are
 * never retried. On final ambiguous failure the caller should record an
 * unknown-outcome tally entry and tell the user to check get_usage_history. */
export async function apiRequestBillable<T = any>(
  method: string,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  const key = opts.idempotencyKey ?? randomUUID();
  const startedAt = Date.now();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await apiRequest<T>(method, path, { ...opts, idempotencyKey: key });
    } catch (e) {
      lastErr = e;
      // 429 is a definite rejection (nothing ran, nothing billed), so a
      // same-key retry is always safe — and unlike ambiguous failures it never
      // feeds the unknown-charge tally.
      const rateLimited = e instanceof ApiError && e.status === 429;
      const outOfBudget = Date.now() - startedAt + RETRY_DELAYS_MS[attempt] >= TOTAL_BUDGET_MS;
      if ((!isAmbiguous(e) && !rateLimited) || attempt === RETRY_DELAYS_MS.length || outOfBudget) throw e;
      console.error(
        rateLimited
          ? `[diagrams-so] ${method} ${path}: Rate limited — retrying shortly.`
          : `[diagrams-so] ${method} ${path}: ambiguous failure (${(e as ApiError).code}); ` +
              `retrying with the same Idempotency-Key in ${RETRY_DELAYS_MS[attempt] / 1000}s ` +
              `(attempt ${attempt + 2}/${RETRY_DELAYS_MS.length + 1})`,
      );
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr;
}

/** The `usage` object every billable endpoint returns. */
export interface Usage {
  credits_charged: number;
  credits_remaining: number;
  tier?: string | null;
}

/** Render a credits line for tool results (dossier §8.5). */
export function usageLine(usage?: Usage | null): string {
  if (!usage) return "";
  return `\nCredits: ${usage.credits_charged} charged · ${usage.credits_remaining} remaining (${usage.tier ?? "?"}).`;
}

/** In-process tally of what each billable task charged this MCP session, so the
 * agent can answer "how much did each task cost?" instantly (get_usage_history
 * gives the durable, cross-session record).
 *
 * Audit M3: the tally counts only what THIS PROCESS saw. A call that failed
 * ambiguously (timeout/5xx) may still have been charged server-side, so it is
 * recorded as status:"unknown" instead of being silently omitted, and every
 * rendering labels the ledger as authoritative. */
export interface SessionCharge {
  action: string;
  status: "confirmed" | "unknown";
  diagramId?: string;
  creditsCharged?: number;
  creditsRemaining?: number;
  note?: string;
}
export const sessionCharges: SessionCharge[] = [];

/** Record a billable task's charge from its response `usage` block. */
export function recordCharge<T extends { id?: string; usage?: Usage | null }>(action: string, result: T): T {
  const u = result?.usage;
  if (u) {
    sessionCharges.push({
      action,
      status: "confirmed",
      diagramId: result?.id,
      creditsCharged: u.credits_charged,
      creditsRemaining: u.credits_remaining,
    });
  }
  return result;
}

/** Record a billable call whose outcome this process never saw (audit M3):
 * the server may or may not have charged — only the ledger knows. */
export function recordUnknownCharge(action: string, note?: string): void {
  sessionCharges.push({ action, status: "unknown", note });
}

/** The Well-Architected `score` object returned on generate/get/edit/fix. */
export interface Score {
  score: number;
  tier: string;
  warning_count: number;
  recoverable_points: number;
}

/** Render a human-readable score line (nicer than raw JSON). */
export function scoreLine(score?: Score | null): string {
  if (!score) return "";
  return (
    `\nWell-Architected score: ${score.score}/100 (${score.tier})` +
    ` — ${score.warning_count} warning(s), ${score.recoverable_points} recoverable point(s).`
  );
}

/** Small sleep helper for polling async jobs. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
