#!/usr/bin/env node
/**
 * Build the .mcpb bundle we hand to Smithery.
 *
 * Why this is not just `mcpb pack`:
 *
 * Smithery's publish path (`@smithery/cli` → PUT /servers/:name/releases) copies
 * `manifest.json` `tools[]` straight into the release payload's `serverCard.tools`,
 * and its ServerCard schema requires `inputSchema` on every tool. `mcpb pack`
 * validates the same array against the MCPB spec, which allows only
 * `{name, description}` and rejects `title` / `inputSchema` / `annotations`.
 * The two validators are mutually exclusive on the same file.
 *
 * Publishing with `tools` stripped (the earlier workaround) satisfies both, but
 * the listing then shows "No capabilities found" and Smithery's quality score
 * loses the whole 40-point capability bucket — the score gate for the verified
 * badge is 80.
 *
 * So: pack with the MCPB-legal manifest, then rewrite `manifest.json` inside the
 * bundle (a .mcpb is a zip) with the real `tools/list` response from the built
 * server. Smithery gets the full metadata; `mcpb pack` never sees it.
 *
 * The tool list is read from the server itself, not hand-maintained, so it
 * cannot drift from what a client actually sees.
 *
 * Usage: node scripts/build-smithery-bundle.mjs [--out diagrams-so-smithery.mcpb]
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outArg = process.argv.indexOf("--out");
const outFile = resolve(repoRoot, outArg > -1 ? process.argv[outArg + 1] : "diagrams-so-smithery.mcpb");

// Keys Smithery's ServerCard tool schema accepts. It sets additionalProperties:false,
// so anything else the SDK starts emitting would 400 the whole release.
const TOOL_KEYS = ["name", "title", "icons", "description", "inputSchema", "outputSchema", "annotations", "execution", "_meta"];

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** Start the built server on stdio and return its real tools/list response. */
function readToolsFromServer() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, "dist/index.js")], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
      // A dummy key keeps the server from trying to open a browser for login.
      env: { ...process.env, DIAGRAMS_API_KEY: "dgz_live_bundle_build_probe" },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("server did not answer tools/list within 20s"));
    }, 20_000);
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // banner or other non-JSON chatter
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(msg.result?.tools ?? []);
        }
      }
    });
    child.on("error", reject);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bundle-build", version: "1" } },
    });
  });
}

/**
 * Smithery scores capability quality all-or-nothing per criterion: one tool
 * missing a description, or one parameter missing one, zeroes that whole band.
 * Fail the build rather than ship a listing that quietly drops below the gate.
 */
function assertScorable(tools) {
  const noDescription = tools.filter((t) => !t.description?.trim()).map((t) => t.name);
  const noAnnotations = tools.filter((t) => !t.annotations).map((t) => t.name);
  const undocumentedParams = tools.flatMap((t) => {
    const props = t.inputSchema?.properties ?? {};
    return Object.entries(props)
      .filter(([, schema]) => !schema?.description?.trim())
      .map(([param]) => `${t.name}.${param}`);
  });
  const problems = [];
  if (!tools.length) problems.push("server returned no tools");
  if (noDescription.length) problems.push(`tools without a description: ${noDescription.join(", ")}`);
  if (noAnnotations.length) problems.push(`tools without annotations: ${noAnnotations.join(", ")}`);
  if (undocumentedParams.length) problems.push(`parameters without a description: ${undocumentedParams.join(", ")}`);
  if (problems.length) die(`bundle would score below Smithery's quality gate:\n  - ${problems.join("\n  - ")}`);
}

const tools = await readToolsFromServer();
assertScorable(tools);
console.log(`tools/list: ${tools.length} tools, all described and annotated`);

const manifest = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8"));
const staging = mkdtempSync(join(tmpdir(), "diagrams-smithery-"));
try {
  for (const entry of ["dist", "node_modules", "package.json", "package-lock.json", "manifest.json", "LICENSE", "NOTICE", "README.md", "icon.png"]) {
    const from = join(repoRoot, entry);
    if (existsSync(from)) cpSync(from, join(staging, entry), { recursive: true, dereference: true });
  }

  // Prune dev deps in the copy, not in the repo — typescript alone is 19MB and
  // Smithery caps a bundle at 25MB.
  const prune = spawnSync("npm", ["prune", "--omit=dev"], { cwd: staging, stdio: "inherit" });
  if (prune.status !== 0) die("npm prune --omit=dev failed");

  // MCPB-legal manifest for the pack step: drop the optional tools array entirely.
  const packable = { ...manifest };
  delete packable.tools;
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(packable, null, 2)}\n`);

  rmSync(outFile, { force: true });
  const pack = spawnSync("npx", ["--yes", "@anthropic-ai/mcpb", "pack", ".", outFile], { cwd: staging, stdio: "inherit" });
  if (pack.status !== 0) die("mcpb pack failed");

  // Now put the real metadata back, inside the zip, where only Smithery reads it.
  const enriched = {
    ...manifest,
    tools: tools.map((t) => Object.fromEntries(TOOL_KEYS.filter((k) => k in t).map((k) => [k, t[k]]))),
  };
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(enriched, null, 2)}\n`);
  const zip = spawnSync("zip", ["-q", outFile, "manifest.json"], { cwd: staging, stdio: "inherit" });
  if (zip.status !== 0) die("rewriting manifest.json inside the bundle failed");
} finally {
  rmSync(staging, { recursive: true, force: true });
}

// Read the manifest back out of the finished bundle — the rewrite is the whole
// point of this script, so verify it landed instead of trusting the exit code.
const check = spawnSync("unzip", ["-p", outFile, "manifest.json"], { encoding: "utf8" });
if (check.status !== 0) die("could not read manifest.json back out of the bundle");
const packed = JSON.parse(check.stdout);
const withSchema = (packed.tools ?? []).filter((t) => t.inputSchema).length;
if (withSchema !== tools.length) die(`bundle carries ${withSchema} tools with inputSchema, expected ${tools.length}`);
console.log(`${outFile}: ${packed.tools.length} tools, all with inputSchema. Version ${packed.version}.`);
