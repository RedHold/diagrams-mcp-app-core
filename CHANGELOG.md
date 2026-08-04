# Changelog

## [1.4.0] — 2026-08

Zero-friction auth release: the bin now doubles as a CLI. Tool surface
unchanged (23 tools).

- **New CLI subcommands** on the same bin (`npx @diagrams-so/mcp <cmd>`):
  `login`, `logout`, `whoami`, `install`. No args (or anything else) still
  starts the stdio MCP server exactly as before.
- **`login [--test] [--base-url <url>]`**: OAuth 2.0 Device Authorization Grant
  (RFC 8628) against `/oauth/device/code` + `/oauth/device/token` — prints the
  user code, auto-opens the browser (best-effort, cross-platform), polls with
  `slow_down` backoff, and writes the minted key atomically (tmp + rename) to
  `~/.diagrams-so/credentials.json` (dir 0700, file 0600). If the cache can't
  be written the key is printed once with manual `DIAGRAMS_API_KEY` steps.
  `--test` mints a test-mode key (and warns that test keys charge the same
  credits as live).
  Only `https:` (or loopback `http:`) verification URLs are auto-opened;
  `DIAGRAMS_BROWSER` targets a specific browser (e.g. `Google Chrome`) and
  `DIAGRAMS_NO_BROWSER` disables auto-open entirely.
- **Shorter command**: installing the package now also exposes `diagrams-so`, so
  `npm i -g @diagrams-so/mcp` then `diagrams-so login` works. The original
  `diagrams-so-mcp` name is unchanged, and the not-connected hint adapts to how
  the CLI was invoked.
- **In-tool connect (no terminal needed)**: a tool call with no credential now
  starts a device grant itself and returns a clickable link plus the code to
  match; the server polls in the background and caches the key the moment you
  approve, so the next tool call just works. This makes Claude Desktop usable
  without ever opening a terminal. Disable with `DIAGRAMS_NO_AUTO_LOGIN=1`.
- **MCPB bundle**: `api_key` is no longer required at install — install, then
  connect on first use.
- **Credential resolution** (server + CLI): `DIAGRAMS_API_KEY` env > login
  cache > none. The cache is honored only when well-formed (version 1, has
  `api_key`) AND minted against the configured base URL; any read/parse
  problem is treated as absent — never a crash.
- **Actionable auth/billing errors**: no credential → "Not connected — run
  `npx @diagrams-so/mcp login` in a terminal (or set DIAGRAMS_API_KEY)."; 401 →
  "Session credential expired or revoked — run `npx @diagrams-so/mcp login`
  again."; 402 → "Out of credits — free credits are one-time. Top up ($5 for
  25) or upgrade: <upgrade_url>"; billable calls now retry 429 with the same
  Idempotency-Key ("Rate limited — retrying shortly.").
- **`install`** prints ready-to-paste config for claude-code / claude-desktop /
  cursor (all three when no client is named) — after `login`, no API key env
  var is needed.
- New deterministic stub-API test: `npm run test:device-login`.

## [1.3.0] — 2026-07

Billing-safety release driven by the 2026-07-30 session audit. Tool surface
unchanged (23 tools).

- **Idempotency keys on billable calls** (`generate_diagram`, `edit_diagram`,
  `fix_warning`): every call sends a fresh `Idempotency-Key`, and an ambiguous
  failure (timeout / connection lost / 502 / 503 / 504 / 409-in-progress) is
  retried up to 3 times with the SAME key. If the server finished the original
  request, the retry replays the stored response — the diagram id is recovered
  and nothing is double-billed. Definite rejections (401/402/404/422) never
  retry. Previously a gateway 504 hid a successful, billed generation and any
  retry created a second diagram and a second charge.
- **Honest session tally**: billable calls that fail mid-flight are now recorded
  as `UNKNOWN — may still have been charged` instead of silently omitted;
  chargeable re-layouts (billed async, no usage block in the status payload) are
  recorded the same way; `get_usage_history` labels the tally "this process
  only — the ledger above is authoritative" and reports confirmed vs unknown
  separately.
- **Billable-tool errors now warn the agent** to check `get_usage_history` /
  `list_diagrams` before retrying after an ambiguous failure.
- **Re-layout billing text updated** for the 2026-08-01 product change: every
  re-layout is billed by tokens (no free allowance) and requires `confirm=true`;
  the unknown-charge tally keys off the server's own `chargeable` verdict.
- **Default `DIAGRAMS_API_TIMEOUT_MS` raised 180000 → 450000** so the client
  sits above the API's full server-side timeout ladder and never aborts work
  the server would still deliver.

## [1.2.0] — 2026-07

- **New tool `get_usage_history`** (23 tools total): itemized per-task credit
  consumption — action, credits charged, diagram, and the surface that ran it
  (api / sdk-python / sdk-ts / mcp / web) — with filters (`action`, `source`,
  `diagram_id`, `since`/`until`), cursor pagination, and a live tally of what
  this MCP session charged. Wraps `GET /api/v2/usage/history`.
- **Source attribution**: every request now sends `X-Diagrams-Client: mcp/<version>`
  (plus a matching User-Agent) so charges attribute to `source="mcp"` in the ledger.
- **Production by default**: `DIAGRAMS_API_BASE` now defaults to
  `https://api.diagrams.so/api/v2`; set it explicitly only for a local/self-hosted API.
- Added Apache-2.0 `LICENSE` + `NOTICE`; smoke tests and docs updated for the 23-tool surface.

## [1.1.0] — 2026-07

- Keep long LLM tool calls alive past the MCP client's 60s default timeout by
  emitting `notifications/progress` every 10s (for clients with
  `resetTimeoutOnProgress`).
- Smoke-test hardening: 200s per-call timeout, no crash on thrown calls.
- CI (build + free 22-tool registration smoke on Node 18/20/22), nightly live
  smoke, and tagged `.mcpb` release workflow.

## [1.0.0] — 2026-07

- Initial stdio MCP server over the Diagrams.so public `/api/v2`: generate /
  edit / fix / re-layout / import / export / versions / gallery / prompts /
  usage / capabilities.
