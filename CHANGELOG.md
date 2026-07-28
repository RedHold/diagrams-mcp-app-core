# Changelog

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
