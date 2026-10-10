#!/usr/bin/env node
// Regenerates registry-schema-constraints.json from the JSON Schema that
// server.json DECLARES in its own $schema field.
//
// The URL is read from server.json rather than written here on purpose: the
// manifest already names the schema version it claims to satisfy, so a second
// copy of that URL in this file is a place for the two to disagree. Bump
// $schema in server.json and re-run this; nothing else needs editing.
//
// Run it manually, not on publish. The prepublish gate enforces the PINNED
// file and only compares against the live one, so a network blip can never
// silently widen a limit.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(PKG_ROOT, "registry-schema-constraints.json");

export function extractConstraints(schema) {
  const ref = schema.$ref || "#/definitions/ServerDetail";
  const key = ref.split("/").pop();
  const defs = schema.definitions || schema.$defs || {};
  const detail = defs[key];
  if (!detail) throw new Error(`schema has no definition ${key} (looked in definitions/$defs)`);
  const fields = {};
  for (const [name, spec] of Object.entries(detail.properties || {})) {
    const c = {};
    if (spec.minLength != null) c.minLength = spec.minLength;
    if (spec.maxLength != null) c.maxLength = spec.maxLength;
    if (spec.pattern) c.pattern = spec.pattern;
    if (Object.keys(c).length) fields[name] = c;
  }
  if (!Object.keys(fields).length) {
    throw new Error("extracted ZERO constrained fields, which means the schema shape changed");
  }
  return { required: detail.required || [], fields };
}

async function main() {
  const srv = JSON.parse(readFileSync(join(PKG_ROOT, "server.json"), "utf8"));
  const url = srv.$schema;
  if (!url) throw new Error("server.json declares no $schema, so there is nothing to read constraints from");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const { required, fields } = extractConstraints(await res.json());
  const out = {
    _comment:
      "GENERATED, do not hand-edit. Constraints extracted from the JSON Schema that apps/mcp/server.json declares in its own $schema field. Refresh with: node scripts/refresh-registry-constraints.mjs",
    source_schema: url,
    fetched_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    required,
    fields,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`[refresh-registry-constraints] wrote ${OUT} from ${url}`);
  console.log(`  ${Object.keys(fields).length} constrained field(s): ${Object.keys(fields).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`[refresh-registry-constraints] FAILED: ${e.message}`);
    process.exit(1);
  });
}
