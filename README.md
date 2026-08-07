# @diagrams-so/mcp

[![CI](https://github.com/RedHold/diagrams-mcp-app-core/actions/workflows/ci.yml/badge.svg)](https://github.com/RedHold/diagrams-mcp-app-core/actions/workflows/ci.yml)
[![Smithery](https://img.shields.io/badge/Smithery-diagrams--so%2Fmcp-orange)](https://smithery.ai/servers/diagrams-so/mcp)

The **Diagrams.so MCP server** — generate, edit, and manage cloud architecture diagrams from any MCP client (Claude Desktop, Claude Code, Cursor). It's a thin stdio client over the public Diagrams.so API (`/api/v2`); every tool is one REST call.

## Quick start

Needs **Node ≥ 18**. No API key to copy: you connect by approving in a browser.

```bash
# 1. add the server to Claude Code
claude mcp add diagrams-so -- npx -y @diagrams-so/mcp

# 2. connect this machine (a browser opens, press Approve)
npx @diagrams-so/mcp login
```

Restart your client, then ask: *"Generate an AWS 3-tier web app diagram and show me the warnings."*
Run `/mcp` if you want to confirm all 23 tools registered first.

Using it a lot? Install once and the command gets shorter:

```bash
npm i -g @diagrams-so/mcp
diagrams-so login
```

> The server talks to production (`https://api.diagrams.so/api/v2`) by default. Point it at a
> local or self-hosted API with `DIAGRAMS_API_BASE`.

Using Claude Desktop or Cursor instead of the CLI? See [Add it to your MCP client](#add-it-to-your-mcp-client). Prefer a one-click, no-terminal install? See [One-click install (MCPB)](#one-click-install-mcpb).

<details>
<summary>No terminal at all (Claude Desktop)</summary>

Add the server to your client config (below), then just ask for a diagram. Because the machine
isn't connected yet, the first tool call replies with a link. Open it, press **Approve**, and ask
again. Nothing to install or type.
</details>

## Generating a diagram from Claude

`login` only connects the machine. It never generates anything itself, so there is no
`generate` command to type in a terminal. You write the prompt **in your assistant's normal
chat box** and it calls the tools for you.

| Client | Where you type the prompt |
|---|---|
| Claude Code | the terminal chat, same place you ask anything else |
| Claude Desktop | the normal message box |
| Cursor | the chat or composer panel |

**MCP servers load at startup, so restart your client after adding it.** Then run `/mcp` and
confirm `diagrams-so` shows 23 tools.

Now just ask, in plain English:

> Generate an AWS three-tier web app with an ALB, EC2 Auto Scaling and RDS Multi-AZ.
> Show me the design warnings, then export it as draw.io.

Behind that one sentence the assistant calls `generate_diagram`, then `get_warnings`, then
`export_diagram`. You never name a tool or write JSON.

More things worth asking, once you have a diagram:

> The warnings mention no encryption in transit. Fix that one and show me the new score.

> Add a CloudFront distribution in front of the ALB.

> Re-export it as SVG so I can drop it in the README.

Each reply carries the credit cost and your remaining balance. Generating, editing, fixing and
re-laying-out spend credits; reading, warnings and **every export** are free.

The `.drawio` file the assistant saves opens at [app.diagrams.net](https://app.diagrams.net) or
in the desktop app, fully editable — it is real draw.io XML, not a picture.

**Prefer not to use an assistant at all?** [diagrams.so/create](https://diagrams.so/create) has
the same thing as a web page: type the prompt in the box. No install, no `login`, no MCP.

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
| `export_diagram` | Raw `drawio` or `svg` file (free on every plan; free-plan SVG is watermarked) |
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

Reads and exports are free; `generate` / `edit` / `fix` / `relayout` cost credits, and `delete` is destructive. `relayout` asks for `confirm=true` before it charges.

## CLI

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
| `DIAGRAMS_API_KEY` | ❌ | — (CI and headless only; `login` is the normal path) |
| `DIAGRAMS_API_BASE` | ❌ | `https://api.diagrams.so/api/v2` (production; override for local/self-hosted) |
| `DIAGRAMS_API_TIMEOUT_MS` | ❌ | `450000` (per-request safety-net; sits above the API's full server-side timeout ladder) |
| `DIAGRAMS_BROWSER` | ❌ | — (`login` opens your default browser; set e.g. `Google Chrome` when your Diagrams.so session lives in a non-default browser) |
| `DIAGRAMS_NO_BROWSER` | ❌ | — (set to any value to stop `login` opening a browser; the URL is always printed) |
| `DIAGRAMS_NO_AUTO_LOGIN` | ❌ | — (set to any value to disable in-tool connect; unauthenticated tools then just say to run `login`) |

## Add it to your MCP client

The published package runs straight from npm, so there is no path to fill in and no key in the
config. Run `npx @diagrams-so/mcp install` to print these blocks for your client.

### Claude Code (CLI)
```bash
claude mcp add diagrams-so -- npx -y @diagrams-so/mcp
npx @diagrams-so/mcp login
```

### Claude Desktop / Cursor (`claude_desktop_config.json` / `mcp.json`)
```jsonc
{
  "mcpServers": {
    "diagrams-so": {
      "command": "npx",
      "args": ["-y", "@diagrams-so/mcp"]
      // optional: "env": { "DIAGRAMS_API_BASE": "http://localhost:8000/api/v2" } for a local API
    }
  }
}
```

Connect either by running `npx @diagrams-so/mcp login` once, or by asking for a diagram and
clicking the link the first tool call gives you. Set `DIAGRAMS_API_KEY` instead only for CI and
headless machines, where no browser can open.

Restart the client, then ask: *"Generate an AWS 3-tier web app diagram and show me the warnings."*

### One-click install (MCPB)
Download `diagrams-so.mcpb` from the
[latest release](https://github.com/RedHold/diagrams-mcp-app-core/releases/latest) and drag it into
Claude Desktop. No terminal, and it no longer asks for an API key: install it, then connect on first
use by clicking the link the first tool call gives you.

Building the bundle yourself is a contributor step, see [Developing locally](#developing-locally).

### Smithery
The server is listed at [smithery.ai/servers/diagrams-so/mcp](https://smithery.ai/servers/diagrams-so/mcp),
which installs it for you and lists all 23 tools with their parameters:

```bash
npx -y smithery mcp add diagrams-so/mcp
```

Same package, same `login` step. It's the MCPB bundle Smithery installs, not the npm package, so the
version shown there follows releases rather than `npm dist-tags`.

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

## Developing locally

Only needed if you are changing the server itself. Users should install from npm, see
[Quick start](#quick-start).

```bash
git clone https://github.com/RedHold/diagrams-mcp-app-core.git
cd diagrams-mcp-app-core
npm install                  # installs deps and builds dist/ via the prepare hook
node scripts/ci-smoke.mjs    # all 23 tools register; no API calls, no credits

# point a client at your working copy
claude mcp add diagrams-so-dev -- node "$(pwd)/dist/index.js"

# build the MCPB bundle
npm run build && npx @anthropic-ai/mcpb pack
```
