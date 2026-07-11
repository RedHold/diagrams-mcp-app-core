#!/usr/bin/env node
/**
 * Diagrams.so MCP server (stdio).
 *
 * Exposes the public /api/v2 surface as MCP tools so any MCP client (Claude
 * Desktop/Code, Cursor) can generate, edit, and manage architecture diagrams.
 * Thin client — every tool calls the REST API; nothing internal is touched.
 *
 * Env: DIAGRAMS_API_KEY (required), DIAGRAMS_API_BASE (optional),
 *      DIAGRAMS_API_TIMEOUT_MS (optional).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiRequest, ApiError, usageLine, scoreLine, sleep } from "./client.js";

const SERVER_VERSION = "1.1.0";

const server = new McpServer(
  { name: "diagrams-so", version: SERVER_VERSION },
  {
    instructions:
      "Generate, edit, and manage cloud architecture diagrams via Diagrams.so. " +
      "Typical flow: generate_diagram → (get_warnings → fix_warning | edit_diagram) → export_diagram. " +
      "Every diagram has an `id` — pass it between tools. Diagrams are output as draw.io XML " +
      "(open at app.diagrams.net) or SVG. Generation/edit/fix/re-layout cost credits; reads are free. " +
      "Use list_capabilities to discover valid diagram types / providers / formats before generating.",
  },
);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (e: unknown): ToolResult => {
  const msg =
    e instanceof ApiError
      ? `Error [${e.code}]${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}` +
        (e.requestId ? ` — request ${e.requestId}` : "")
      : `Error: ${(e as any)?.message ?? e}`;
  return { content: [{ type: "text", text: msg }], isError: true };
};

const warningsText = (warnings?: { type: string; component?: string | null; message: string }[]): string => {
  if (!warnings?.length) return "\nNo Well-Architected warnings.";
  return (
    "\nWell-Architected warnings:\n" +
    warnings.map((w) => `  • [${w.type}]${w.component ? ` (${w.component})` : ""} ${w.message}`).join("\n")
  );
};

// Opinionated-mode improvement suggestions (paid) — advisory, not scored.
const suggestionsText = (suggestions?: { component?: string | null; message: string }[]): string => {
  if (!suggestions?.length) return "";
  return (
    "\nSuggestions (opinionated):\n" +
    suggestions.map((s) => `  • ${s.component ? `(${s.component}) ` : ""}${s.message}`).join("\n")
  );
};

const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;

// ---------------------------------------------------------------------------
// Generate / edit / fix / relayout  (billable, mutating)
// ---------------------------------------------------------------------------

server.registerTool(
  "generate_diagram",
  {
    title: "Generate a diagram",
    description:
      "Create a new cloud architecture diagram from a natural-language prompt. Returns the diagram id, " +
      "its draw.io XML, Well-Architected warnings, score, and credits used. Costs credits.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw, e.g. 'AWS 3-tier web app with ALB, EC2 Auto Scaling and RDS Multi-AZ'"),
      cloud_provider: z.string().optional().describe("aws | azure | gcp | kubernetes | oci | general (default: general)"),
      diagram_type: z.string().optional().describe("architecture | flowchart | sequence | data_pipeline | ... (default: architecture)"),
      opinionated: z.boolean().optional().describe("Apply best-practice hardening suggestions during generation (paid plans only)."),
    },
    annotations: WRITE,
  },
  async ({ prompt, cloud_provider, diagram_type, opinionated }) => {
    try {
      const d = await apiRequest("POST", "/diagrams", { body: { prompt, cloud_provider, diagram_type, opinionated } });
      return ok(
        `Diagram created.\nid: ${d.id}\ntitle: ${d.title}` +
          scoreLine(d.score) +
          warningsText(d.warnings) +
          suggestionsText(d.suggestions) +
          usageLine(d.usage) +
          `\n\ndraw.io XML:\n${d.xml}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "edit_diagram",
  {
    title: "Edit a diagram",
    description:
      "Apply a natural-language change to an existing diagram (e.g. 'add a Redis cache'). Creates a new " +
      "version and returns the updated XML. Costs credits. Confirm with the user before calling — it mutates the diagram.",
    inputSchema: {
      diagram_id: z.string().describe("The id returned by generate_diagram / list_diagrams"),
      edit_prompt: z.string().min(3).describe("The change to make, in plain language"),
    },
    annotations: WRITE,
  },
  async ({ diagram_id, edit_prompt }) => {
    try {
      const d = await apiRequest("POST", `/diagrams/${encodeURIComponent(diagram_id)}/edit`, {
        body: { edit_prompt },
      });
      return ok(`Diagram edited.\nid: ${d.id}` + scoreLine(d.score) + warningsText(d.warnings) + usageLine(d.usage) + `\n\ndraw.io XML:\n${d.xml}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "fix_warning",
  {
    title: "Fix one warning",
    description:
      "Resolve a single Well-Architected warning (from get_warnings), leaving the rest of the diagram " +
      "untouched. Creates a new version. Costs credits.",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      message: z.string().min(3).describe("The warning's `message` (as returned by get_warnings)"),
      component: z.string().optional().describe("The warning's `component`, if any"),
      warning_type: z.string().optional().describe("The warning's `type`, e.g. no_encryption_transit"),
    },
    annotations: WRITE,
  },
  async ({ diagram_id, message, component, warning_type }) => {
    try {
      const d = await apiRequest("POST", `/diagrams/${encodeURIComponent(diagram_id)}/fix`, {
        body: { message, component, warning_type },
      });
      return ok(`Warning fixed.\nid: ${d.id}` + scoreLine(d.score) + warningsText(d.warnings) + usageLine(d.usage) + `\n\ndraw.io XML:\n${d.xml}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "relayout_diagram",
  {
    title: "Re-arrange layout with AI",
    description:
      "Automatically re-arrange a diagram's layout for readability (async). Starts the job and waits for it " +
      "to finish, returning the re-laid XML + fresh warnings/score. The first 2 re-layouts per diagram are free; " +
      "after that it costs credits and you must pass confirm=true. If the job is still running when the wait " +
      "elapses, returns a job_id you can poll with get_relayout_status.",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      confirm: z.boolean().optional().describe("Opt into the charge for a chargeable (post-free) re-layout."),
    },
    annotations: WRITE,
  },
  async ({ diagram_id, confirm }) => {
    try {
      const id = encodeURIComponent(diagram_id);
      const start = await apiRequest("POST", `/diagrams/${id}/relayout`, { query: { confirm } });
      // Confirm gate: chargeable re-layout requested without confirm=true.
      if (start?.status === "confirmation_required") {
        return ok(`${start.message}\n\nRe-run relayout_diagram with confirm=true to proceed.`);
      }
      const jobId: string | undefined = start?.job_id;
      if (!jobId) return ok(`Re-layout started but no job_id was returned: ${JSON.stringify(start)}`);

      // Poll until terminal (done | failed) or the wait budget elapses.
      const deadline = Date.now() + 120_000;
      let last: any = start;
      while (Date.now() < deadline) {
        await sleep(1500);
        last = await apiRequest("GET", `/diagrams/${id}/relayout/${encodeURIComponent(jobId)}`);
        if (last.status === "done") {
          if (last.applied) {
            return ok(
              `Re-layout applied (v${last.version_number ?? "?"}).` +
                scoreLine(last.score) +
                warningsText(last.warnings) +
                `\n\ndraw.io XML:\n${last.xml ?? ""}`,
            );
          }
          return ok(`Re-layout finished without changes${last.reason ? ` (${last.reason})` : ""}.`);
        }
        if (last.status === "failed") {
          return fail(new ApiError("RELAYOUT_FAILED", last.reason || "The re-layout job failed.", 0));
        }
      }
      return ok(
        `Re-layout is still running (job_id: ${jobId}, ${last.progress ?? 0}%). ` +
          `Poll it with get_relayout_status(diagram_id, job_id).`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Create-from-existing / lifecycle mutations
// ---------------------------------------------------------------------------

server.registerTool(
  "import_diagram",
  {
    title: "Import a diagram",
    description:
      "Import an existing draw.io (mxGraphModel/mxfile) XML document as a new diagram in your account. " +
      "Validated and sanitized. Free (no AI).",
    inputSchema: {
      xml: z.string().min(1).describe("draw.io mxGraphModel/mxfile XML"),
      title: z.string().optional().describe("Optional title (derived if omitted)"),
      cloud_provider: z.string().optional().describe("aws | azure | gcp | ... (default: general)"),
      diagram_type: z.string().optional().describe("architecture | flowchart | ... (default: architecture)"),
    },
    annotations: WRITE,
  },
  async ({ xml, title, cloud_provider, diagram_type }) => {
    try {
      const d = await apiRequest("POST", "/diagrams/import", { body: { xml, title, cloud_provider, diagram_type } });
      return ok(`Imported.\nid: ${d.id}\ntitle: ${d.title}\ntype: ${d.cloud_provider}/${d.diagram_type}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "update_diagram",
  {
    title: "Update a diagram",
    description:
      "Update a diagram's metadata or XML: rename it, change visibility (public/private — paid plans for private), " +
      "or replace its XML. Pass only the fields you want to change. Free (no AI).",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      title: z.string().max(200).optional().describe("New title"),
      is_public: z.boolean().optional().describe("true = public in the gallery, false = private (paid)"),
      xml: z.string().optional().describe("Replace the diagram XML (validated + sanitized)"),
    },
    annotations: WRITE,
  },
  async ({ diagram_id, title, is_public, xml }) => {
    try {
      if (title === undefined && is_public === undefined && xml === undefined) {
        return fail(new ApiError("NOTHING_TO_UPDATE", "Provide at least one of: title, is_public, xml.", 0));
      }
      const d = await apiRequest("PATCH", `/diagrams/${encodeURIComponent(diagram_id)}`, {
        body: { title, is_public, xml },
      });
      return ok(`Updated.\nid: ${d.id}\ntitle: ${d.title}\nvisibility: ${d.is_public ? "public" : "private"}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "delete_diagram",
  {
    title: "Delete a diagram",
    description:
      "Delete (soft-delete) a diagram you own. It stops appearing in list_diagrams and can no longer be fetched. " +
      "Confirm with the user before calling — this is destructive.",
    inputSchema: { diagram_id: z.string().describe("The diagram id") },
    annotations: DESTRUCTIVE,
  },
  async ({ diagram_id }) => {
    try {
      await apiRequest("DELETE", `/diagrams/${encodeURIComponent(diagram_id)}`);
      return ok(`Deleted diagram ${diagram_id}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "revert_diagram",
  {
    title: "Revert to a version",
    description:
      "Revert a diagram to an earlier version (from list_versions). Pass either version_id or version_number. " +
      "Free (no AI).",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      version_id: z.string().optional().describe("The version's id (from list_versions)"),
      version_number: z.number().int().min(1).optional().describe("Or the version number, e.g. 2"),
    },
    annotations: WRITE,
  },
  async ({ diagram_id, version_id, version_number }) => {
    try {
      if (!version_id && version_number === undefined) {
        return fail(new ApiError("NO_VERSION", "Provide version_id or version_number.", 0));
      }
      const d = await apiRequest("POST", `/diagrams/${encodeURIComponent(diagram_id)}/revert`, {
        body: { version_id, version_number },
      });
      return ok(`Reverted.\nid: ${d.id}\ntitle: ${d.title}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

server.registerTool(
  "get_diagram",
  {
    title: "Get a diagram",
    description: "Fetch a diagram by id — returns its title, draw.io XML, and Well-Architected score.",
    inputSchema: { diagram_id: z.string().describe("The diagram id") },
    annotations: READ,
  },
  async ({ diagram_id }) => {
    try {
      const d = await apiRequest("GET", `/diagrams/${encodeURIComponent(diagram_id)}`);
      return ok(
        `id: ${d.id}\ntitle: ${d.title}\ncloud: ${d.cloud_provider} · type: ${d.diagram_type} · ${d.is_public ? "public" : "private"}` +
          scoreLine(d.score) +
          suggestionsText(d.suggestions) +
          `\n\ndraw.io XML:\n${d.xml}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_diagrams",
  {
    title: "List my diagrams",
    description: "List your diagrams (newest first, cursor-paginated). Returns id, title, cloud, type.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)"),
      cursor: z.string().optional().describe("next_cursor from a previous call"),
    },
    annotations: READ,
  },
  async ({ limit, cursor }) => {
    try {
      const r = await apiRequest("GET", "/diagrams", { query: { limit, cursor } });
      const items = r.items || [];
      if (!items.length) return ok("No diagrams yet.");
      const lines = items.map(
        (d: any) => `  ${d.id}  ${d.title}  [${d.cloud_provider}/${d.diagram_type}]` +
          (d.created_at ? `  ${String(d.created_at).slice(0, 10)}` : ""),
      );
      return ok(
        `${items.length} diagram(s):\n${lines.join("\n")}` +
          (r.has_more ? `\n\nMore available — pass cursor: ${r.next_cursor}` : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_warnings",
  {
    title: "Get Well-Architected warnings",
    description: "List the Well-Architected findings for a diagram (each has type, component, message). Free.",
    inputSchema: { diagram_id: z.string().describe("The diagram id") },
    annotations: READ,
  },
  async ({ diagram_id }) => {
    try {
      const w = await apiRequest("GET", `/diagrams/${encodeURIComponent(diagram_id)}/warnings`);
      if (!w?.length) return ok("No warnings — the diagram looks well-architected.");
      return ok(
        `${w.length} warning(s):\n` +
          w.map((x: any) => `  • [${x.type}]${x.component ? ` (${x.component})` : ""} ${x.message}`).join("\n"),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "export_diagram",
  {
    title: "Export a diagram",
    description:
      "Export a diagram as a raw file: `drawio` (open at app.diagrams.net) or `svg`. Returns the file content directly. " +
      "SVG export is a paid feature.",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      format: z.enum(["drawio", "svg"]).default("drawio").describe("drawio or svg"),
    },
    annotations: READ,
  },
  async ({ diagram_id, format }) => {
    try {
      const text = await apiRequest<string>("GET", `/diagrams/${encodeURIComponent(diagram_id)}/export`, {
        query: { format },
        raw: true,
      });
      return ok(`Exported ${format}:\n\n${text}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_versions",
  {
    title: "List diagram versions",
    description:
      "List a diagram's version history (ascending; `is_current` marks the live one). Use with revert_diagram / get_version.",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)"),
      cursor: z.string().optional().describe("next_cursor from a previous call"),
    },
    annotations: READ,
  },
  async ({ diagram_id, limit, cursor }) => {
    try {
      const r = await apiRequest("GET", `/diagrams/${encodeURIComponent(diagram_id)}/versions`, { query: { limit, cursor } });
      const items = r.items || [];
      if (!items.length) return ok("No versions.");
      const lines = items.map(
        (v: any) =>
          `  v${v.version_number}${v.is_current ? " (current)" : ""}  version_id: ${v.id}` +
          (v.created_at ? `  ${String(v.created_at).slice(0, 10)}` : "") +
          (v.prompt_text ? `  — ${String(v.prompt_text).slice(0, 80)}` : ""),
      );
      return ok(
        `${items.length} version(s):\n${lines.join("\n")}` +
          (r.has_more ? `\n\nMore available — pass cursor: ${r.next_cursor}` : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_version",
  {
    title: "Get a diagram version",
    description: "Fetch a specific version's XML + Well-Architected score (e.g. to inspect before reverting). Free.",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      version_id: z.string().describe("The version id (from list_versions)"),
    },
    annotations: READ,
  },
  async ({ diagram_id, version_id }) => {
    try {
      const d = await apiRequest(
        "GET",
        `/diagrams/${encodeURIComponent(diagram_id)}/versions/${encodeURIComponent(version_id)}`,
      );
      // Label clearly: d.id is the DIAGRAM id, not the version id. Echo the
      // version_id the caller passed so it isn't mistaken for a revert target.
      return ok(
        `diagram_id: ${d.id}\nversion_id: ${version_id}\ntitle: ${d.title}` +
          scoreLine(d.score) + `\n\ndraw.io XML:\n${d.xml}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_relayout_status",
  {
    title: "Poll a re-layout job",
    description:
      "Check the status of an async re-layout job started by relayout_diagram. Returns pending/done/failed; " +
      "when done+applied it includes the re-laid XML + fresh warnings/score. Free.",
    inputSchema: {
      diagram_id: z.string().describe("The diagram id"),
      job_id: z.string().describe("The job_id returned by relayout_diagram"),
    },
    annotations: READ,
  },
  async ({ diagram_id, job_id }) => {
    try {
      const s = await apiRequest(
        "GET",
        `/diagrams/${encodeURIComponent(diagram_id)}/relayout/${encodeURIComponent(job_id)}`,
      );
      if (s.status === "done" && s.applied) {
        return ok(
          `Re-layout done (v${s.version_number ?? "?"}).` +
            scoreLine(s.score) +
            warningsText(s.warnings) +
            `\n\ndraw.io XML:\n${s.xml ?? ""}`,
        );
      }
      if (s.status === "done") return ok(`Re-layout finished without changes${s.reason ? ` (${s.reason})` : ""}.`);
      if (s.status === "failed") return fail(new ApiError("RELAYOUT_FAILED", s.reason || "The re-layout job failed.", 0));
      return ok(`Re-layout still running (${s.progress ?? 0}%). Poll again shortly.`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------

server.registerTool(
  "search_gallery",
  {
    title: "Search the gallery",
    description:
      "Search public community diagrams and curated library templates to reuse as a starting point. " +
      "Returns id, title, and source (community/library). Fork one with fork_template.",
    inputSchema: {
      q: z.string().optional().describe("Search text (matches title/description)"),
      cloud_provider: z.string().optional().describe("Filter by provider"),
      diagram_type: z.string().optional().describe("Filter by diagram type"),
      source: z.enum(["all", "community", "library"]).optional().describe("all (default) · community · library"),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)"),
      cursor: z.string().optional().describe("next_cursor from a previous call (community feed is paginated)"),
    },
    annotations: READ,
  },
  async ({ q, cloud_provider, diagram_type, source, limit, cursor }) => {
    try {
      const r = await apiRequest("GET", "/gallery", { query: { q, cloud_provider, diagram_type, source, limit, cursor } });
      const items = r.items || [];
      if (!items.length) return ok("No matching public diagrams.");
      const lines = items.map((d: any) => {
        const desc = d.description ? ` — ${String(d.description).slice(0, 80)}` : "";
        return `  ${d.id}  ${d.title}  [${d.cloud_provider}/${d.diagram_type}] (${d.source})${desc}`;
      });
      return ok(
        `${items.length} public diagram(s):\n${lines.join("\n")}` +
          (r.has_more ? `\n\nMore available — pass cursor: ${r.next_cursor}` : ""),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "fork_template",
  {
    title: "Fork a public diagram",
    description:
      "Copy a PUBLIC gallery diagram or curated library template into your own account (private) so you can edit it. " +
      "Returns the new diagram id.",
    inputSchema: { diagram_id: z.string().describe("A public/library diagram id from search_gallery") },
    annotations: WRITE,
  },
  async ({ diagram_id }) => {
    try {
      const r = await apiRequest("POST", `/gallery/${encodeURIComponent(diagram_id)}/fork`);
      const from = r.forked_from_id || r.forked_from_library_id || "?";
      return ok(`Forked.\nnew id: ${r.id}\ntitle: ${r.title}\nforked from: ${from}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Prompt helpers + identity + capabilities
// ---------------------------------------------------------------------------

server.registerTool(
  "enhance_prompt",
  {
    title: "Enhance a prompt",
    description: "Turn a rough idea into a detailed generation prompt. Free.",
    inputSchema: {
      prompt: z.string().min(5).describe("Your rough prompt"),
      cloud_provider: z.string().optional(),
    },
    annotations: READ,
  },
  async ({ prompt, cloud_provider }) => {
    try {
      const r = await apiRequest("POST", "/prompts/enhance", { body: { prompt, cloud_provider } });
      return ok(`Enhanced prompt:\n${r.enhanced_prompt}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "clarify_prompt",
  {
    title: "Clarify a vague prompt",
    description: "Get 1–3 clarifying questions (and a suggested diagram type) for a vague prompt, before generating. Free.",
    inputSchema: { prompt: z.string().min(1).describe("Your prompt") },
    annotations: READ,
  },
  async ({ prompt }) => {
    try {
      const r = await apiRequest("POST", "/prompts/clarify", { body: { prompt } });
      if (!r.questions?.length) return ok("Prompt is clear enough — go ahead and generate.");
      const qs = r.questions
        .map((q: any, i: number) => `  ${i + 1}. ${q.text}${q.options ? ` (${q.options.join(" / ")})` : ""}`)
        .join("\n");
      return ok(`Clarifying questions:\n${qs}` + (r.suggested_diagram_type ? `\nSuggested type: ${r.suggested_diagram_type}` : ""));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_usage",
  {
    title: "Get usage & credits",
    description: "Show your current plan, credits remaining, and per-action cost estimates. Free.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const u = await apiRequest("GET", "/usage");
      return ok(JSON.stringify(u, null, 2));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "whoami",
  {
    title: "Who am I",
    description: "Show the account, plan, scopes, and live/test mode of the configured API key. Free.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const m = await apiRequest("GET", "/me");
      return ok(
        `email: ${m.email}\nplan: ${m.plan}\nmode: ${m.livemode ? "live" : "test"}\nscopes: ${(m.scopes || []).join(", ")}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_capabilities",
  {
    title: "List capabilities",
    description:
      "Discover the valid diagram types, cloud providers, and export formats the API supports — so you pass valid " +
      "values to generate_diagram / export_diagram. Free.",
    inputSchema: {},
    annotations: READ,
  },
  async () => {
    try {
      const [types, providers, formats] = await Promise.all([
        apiRequest("GET", "/meta/diagram-types"),
        apiRequest("GET", "/meta/providers"),
        apiRequest("GET", "/meta/formats"),
      ]);
      return ok(
        `diagram_types: ${(types.diagram_types || []).join(", ")}\n` +
          `cloud_providers: ${(providers.providers || []).join(", ")}\n` +
          `export_formats: ${(formats.export_formats || []).join(", ")}`,
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel — logs must go to stderr.
  console.error(`diagrams-so MCP server v${SERVER_VERSION} running on stdio.`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
