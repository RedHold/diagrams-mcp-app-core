# @diagrams-so/mcp

[![CI](https://github.com/RedHold/diagrams-mcp-app-core/actions/workflows/ci.yml/badge.svg)](https://github.com/RedHold/diagrams-mcp-app-core/actions/workflows/ci.yml)

The **Diagrams.so MCP server** — generate, edit, and manage cloud architecture diagrams from any MCP client (Claude Desktop, Claude Code, Cursor). It's a thin stdio client over the public Diagrams.so API (`/api/v2`); every tool is one REST call.

## Quick start

Needs **Node ≥ 18** and a **Diagrams.so API key** (`dgz_live_…` or `dgz_test_…`) from diagrams.so → Settings → API Keys.

```bash
# 1. clone & build
git clone https://github.com/RedHold/diagrams-mcp-app-core.git
cd diagrams-mcp-app-core
npm install          # installs deps and builds dist/ (via the prepare hook)

# 2. (optional) confirm the server launches and all 23 tools register — no API calls, no credits
node scripts/ci-smoke.mjs

# 3. add it to Claude Code (use the ABSOLUTE path printed by `pwd`)
claude mcp add diagrams-so \
  --env DIAGRAMS_API_KEY=dgz_live_your_key \
  -- node "$(pwd)/dist/index.js"
```

Restart your client, then ask: *"Generate an AWS 3-tier web app diagram and show me the warnings."*

> The server talks to production (`https://api.diagrams.so/api/v2`) by default. Point it at a local/self-hosted API with `--env DIAGRAMS_API_BASE=http://localhost:8000/api/v2`.

Using Claude Desktop or Cursor instead of the CLI? See [Add it to your MCP client](#add-it-to-your-mcp-client). Prefer a one-click, no-terminal install? See [One-click install (MCPB)](#one-click-install-mcpb).

## Tools (23)

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
| `get_usage_history` | Itemized credit ledger per task (action, credits, diagram, surface) with filters + a live session tally |
| `whoami` | Account, plan, scopes, live/test mode |
| `list_capabilities` | Valid diagram types / providers / export formats |

Reads are marked read-only; `generate` / `edit` / `fix` / `relayout` cost credits, `delete` is destructive. *`relayout` is free for the first two per diagram, then requires `confirm=true`.

## Setup

You need a **Diagrams.so API key** (`dgz_live_…` or `dgz_test_…`) and Node ≥ 18.

```bash
npm install      # install deps
npm run build    # compile to dist/
```

### Commands

Installing the package puts `diagrams-so` on your PATH. The longer
`diagrams-so-mcp` name still works, and `npx @diagrams-so/mcp <command>` works
without installing anything.

```bash
npm i -g @diagrams-so/mcp

diagrams-so login          # connect this machine (a browser opens, press Approve)
diagrams-so whoami         # which account is this machine connected as
diagrams-so logout         # remove the local credential
diagrams-so install        # print client config to paste
```

### Environment
| Var | Required | Default |
|---|---|---|
| `DIAGRAMS_API_KEY` | ✅ | — |
| `DIAGRAMS_API_BASE` | ❌ | `https://api.diagrams.so/api/v2` (production; override for local/self-hosted) |
| `DIAGRAMS_API_TIMEOUT_MS` | ❌ | `450000` (per-request safety-net; sits above the API's full server-side timeout ladder) |
| `DIAGRAMS_BROWSER` | ❌ | — (`login` opens your default browser; set e.g. `Google Chrome` when your Diagrams.so session lives in a non-default browser) |
| `DIAGRAMS_NO_BROWSER` | ❌ | — (set to any value to stop `login` opening a browser; the URL is always printed) |
| `DIAGRAMS_NO_AUTO_LOGIN` | ❌ | — (set to any value to disable in-tool connect; unauthenticated tools then just say to run `login`) |

## Add it to your MCP client

Point the client at the built server and pass your key. Use the **absolute** path to `dist/index.js`.

### Claude Code (CLI)
```bash
claude mcp add diagrams-so \
  --env DIAGRAMS_API_KEY=dgz_live_your_key \
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
        "DIAGRAMS_API_KEY": "dgz_live_your_key"
        // optional: "DIAGRAMS_API_BASE": "http://localhost:8000/api/v2" for a local API
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

## Continuous integration & releases

| Workflow | Trigger | What it does |
|---|---|---|
| **CI** (`ci.yml`) | every push / PR | `npm ci` + `npm run build` on Node 18/20/22, then a **free** smoke (`scripts/ci-smoke.mjs`) that launches the built server and asserts all 23 tools register. **No API calls, no credits.** |
| **Live smoke** (`live-smoke.yml`) | nightly + manual | the full end-to-end flow (`test-smoke.mjs`) against the real API. **Spends credits** — runs only when the `DIAGRAMS_API_KEY` secret is set. |
| **Release** (`release.yml`) | tag `vX.Y.Z` | build → `npm prune --omit=dev` → pack `diagrams-so.mcpb` → attach to a GitHub Release. Publishes to npm too if an `NPM_TOKEN` secret is set. |

**Cut a release:**
```bash
# bump "version" in package.json + manifest.json to match, commit, then:
git tag v1.2.0 && git push origin v1.2.0
```
The tag must match `package.json`'s `version` (the workflow enforces this). The
`.mcpb` bundle appears on the GitHub Release; manual `workflow_dispatch` produces
it as a downloadable artifact without publishing (handy for testing a bundle).

**Repo secrets/variables (optional):** `DIAGRAMS_API_KEY` (live smoke),
`NPM_TOKEN` (npm publish), `DIAGRAMS_API_BASE` variable (non-prod live-smoke target).

## Notes
- **stdout is the MCP channel** — the server logs only to stderr.
- Errors come back as clean MCP tool errors carrying the API's `code`, HTTP status, and `request_id`.
- The server never talks to internal services or the database — only the public `/api/v2`.
- **Long-running tools stay alive past client timeouts.** `generate` / `edit` / `fix` / `relayout` / `enhance_prompt` / `clarify_prompt` emit a `notifications/progress` every 10s while running, so MCP clients that reset their request timeout on progress (`resetTimeoutOnProgress`) won't abort a slow generation at the SDK's 60s default. If your client doesn't reset on progress, raise its per-call timeout for these tools.
