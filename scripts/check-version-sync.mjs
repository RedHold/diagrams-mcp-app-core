#!/usr/bin/env node
/**
 * Fail the build when the version drifts between the files that carry it.
 *
 * Six places must agree. They have drifted before: v1.4.0 shipped with
 * SERVER_VERSION still reading the previous value, so the server announced one
 * version at handshake while the registry listing and npm page claimed another.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const json = (f) => JSON.parse(read(f));

const pkg = json("package.json");
const expected = pkg.version;

const found = [
  ["package.json", expected],
  ["manifest.json", json("manifest.json").version],
  ["server.json (server)", json("server.json").version],
  ["server.json (package)", json("server.json").packages?.[0]?.version],
  ["src/index.ts SERVER_VERSION", read("src/index.ts").match(/SERVER_VERSION = "([^"]+)"/)?.[1]],
  ["src/client.ts CLIENT_ID", read("src/client.ts").match(/CLIENT_ID = "mcp\/([^"]+)"/)?.[1]],
  ["src/client.ts USER_AGENT", read("src/client.ts").match(/USER_AGENT = "@diagrams-so\/mcp\/([^"]+)"/)?.[1]],
];

const bad = found.filter(([, v]) => v !== expected);

for (const [where, v] of found) {
  console.log(`${v === expected ? "✓" : "✗"} ${where.padEnd(30)} ${v ?? "(not found)"}`);
}

if (bad.length) {
  console.error(`\n✗ version drift — package.json says ${expected}, but:`);
  for (const [where, v] of bad) console.error(`    ${where} = ${v ?? "(not found)"}`);
  process.exit(1);
}

console.log(`\n✓ version ${expected} consistent across ${found.length} locations`);
