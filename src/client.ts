/**
 * Thin HTTP client for the Diagrams.so public API (/api/v2).
 *
 * The MCP server is a pure client: every tool goes through here, and this file
 * is the ONLY place that knows about HTTP, auth, or the API's error shape.
 */

const BASE = (process.env.DIAGRAMS_API_BASE || "http://localhost:8000/api/v2").replace(/\/+$/, "");
const KEY = process.env.DIAGRAMS_API_KEY;
// Identify this client so the API attributes charges to source="mcp" in the
// credit-consumption history (X-Diagrams-Client wins; User-Agent is a fallback).
const CLIENT_ID = "mcp/1.1.0";
const USER_AGENT = "@diagrams-so/mcp/1.1.0";
// Safety-net timeout so a hung/slow API surfaces a clean tool error instead of
// hanging the MCP client forever. Generous by default (LLM generate/edit are
// slow); override with DIAGRAMS_API_TIMEOUT_MS.
const TIMEOUT_MS = Math.max(1000, Number(process.env.DIAGRAMS_API_TIMEOUT_MS) || 180_000);

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

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOpts {
  query?: Query;
  body?: unknown;
  raw?: boolean; // export returns raw drawio/svg text, not JSON
}

export async function apiRequest<T = any>(
  method: string,
  path: string,
  opts: RequestOpts = {},
): Promise<T> {
  if (!KEY) {
    throw new ApiError(
      "NO_API_KEY",
      "DIAGRAMS_API_KEY is not set. Add your dgz_live_/dgz_test_ key to the server's environment.",
      0,
    );
  }

  const url = new URL(BASE + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${KEY}`,
    "User-Agent": USER_AGENT,
    "X-Diagrams-Client": CLIENT_ID,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

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
    if (contentType.includes("application/json")) {
      const j: any = await res.json().catch(() => null);
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
    throw new ApiError(code, message, res.status, requestId);
  }

  // 204 No Content (e.g. delete) — nothing to parse.
  if (res.status === 204) return undefined as unknown as T;
  if (opts.raw || !contentType.includes("application/json")) {
    return (await res.text()) as unknown as T;
  }
  return (await res.json()) as T;
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
 * gives the durable, cross-session record). */
export interface SessionCharge {
  action: string;
  diagramId?: string;
  creditsCharged?: number;
  creditsRemaining?: number;
}
export const sessionCharges: SessionCharge[] = [];

/** Record a billable task's charge from its response `usage` block. */
export function recordCharge<T extends { id?: string; usage?: Usage | null }>(action: string, result: T): T {
  const u = result?.usage;
  if (u) {
    sessionCharges.push({
      action,
      diagramId: result?.id,
      creditsCharged: u.credits_charged,
      creditsRemaining: u.credits_remaining,
    });
  }
  return result;
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
