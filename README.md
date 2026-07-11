# @diagrams-so/mcp

The **Diagrams.so MCP server** — generate, edit, and manage cloud architecture diagrams from any MCP client (Claude Desktop, Claude Code, Cursor). It's a thin stdio client over the public Diagrams.so API (`/api/v2`); every tool is one REST call.

## Tools (22)

**Create & change (mutating)**

| Tool | What it does | Cost |
|---|---|---|
| `generate_diagram` | Create a diagram from a prompt → id + draw.io XML + warnings + score | credits |
| `edit_diagram` | Apply a natural-language change (new version) | credits |
| `fix_warning` | Resolve one Well-Architected warning | credits |
| `relayout_diagram` | AI re-arrange the layout (async; first 2/diagram free, then confirm) | credits* |
| `import_diagram` | Import existing draw.io XML as a new diagram | free |
| `update_diagram` | Rename / change visibility / replace XML | free |
| `revert_diagram` | Revert to an earlier version | free |
| `delete_diagram` | Soft-delete a diagram (destructive) | free |
| `fork_template` | Copy a public/library diagram into your account (private) | free |

**Read (free)**

| Tool | What it does |
|---|---|
| `get_diagram` | Fetch a diagram's XML + score |
| `list_diagrams` | List your diagrams (cursor-paginated) |
| `get_warnings` | Well-Architected findings for a diagram |
| `export_diagram` | Raw `drawio` or `svg` file (SVG is a paid feature) |
| `list_versions` | Version history (with `is_current`) |
| `get_version` | A specific version's XML + score |
| `get_relayout_status` | Poll an async re-layout job |
| `search_gallery` | Search public community + curated library diagrams |
| `enhance_prompt` | Turn a rough idea into a detailed prompt |
| `clarify_prompt` | Get clarifying questions for a vague prompt |
| `get_usage` | Plan + credits + cost estimates |
| `whoami` | Account, plan, scopes, live/test mode |
| `list_capabilities` | Valid diagram types / providers / export formats |

Reads are marked read-only; `generate` / `edit` / `fix` / `relayout` cost credits, `delete` is destructive. *`relayout` is free for the first two per diagram, then requires `confirm=true`.

## Setup

You need a **Diagrams.so API key** (`dgz_live_…` or `dgz_test_…`) and Node ≥ 18.

```bash
npm install      # install deps
npm run build    # compile to dist/
```

### Environment
| Var | Required | Default |
|---|---|---|
| `DIAGRAMS_API_KEY` | ✅ | — |
| `DIAGRAMS_API_BASE` | ❌ | `http://localhost:8000/api/v2` (set to `https://api.diagrams.so/api/v2` in prod) |
| `DIAGRAMS_API_TIMEOUT_MS` | ❌ | `180000` (per-request safety-net timeout) |

## Add it to your MCP client

Point the client at the built server and pass your key. Use the **absolute** path to `dist/index.js`.

### Claude Code (CLI)
```bash
claude mcp add diagrams-so \
  --env DIAGRAMS_API_KEY=dgz_live_your_key \
  --env DIAGRAMS_API_BASE=http://localhost:8000/api/v2 \
  -- node /ABSOLUTE/PATH/TO/mcp/dist/index.js
```

### Claude Desktop / Cursor (`claude_desktop_config.json` / `mcp.json`)
```jsonc
{
  "mcpServers": {
    "diagrams-so": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp/dist/index.js"],
      "env": {
        "DIAGRAMS_API_KEY": "dgz_live_your_key",
        "DIAGRAMS_API_BASE": "http://localhost:8000/api/v2"
      }
    }
  }
}
```

Restart the client, then ask: *"Generate an AWS 3-tier web app diagram and show me the warnings."*

### One-click install (MCPB)
For non-technical users, build the bundle and drag `diagrams-so.mcpb` into Claude Desktop → it prompts for the API key, no terminal needed:
```bash
npm run build && npx @anthropic-ai/mcpb pack
```

## Verify it works
```bash
DIAGRAMS_API_KEY=dgz_live_your_key node test-smoke.mjs
```
Runs the full flow (connect → list tools → whoami → generate → warnings → fix → export → error handling).

## Notes
- **stdout is the MCP channel** — the server logs only to stderr.
- Errors come back as clean MCP tool errors carrying the API's `code`, HTTP status, and `request_id`.
- The server never talks to internal services or the database — only the public `/api/v2`.
