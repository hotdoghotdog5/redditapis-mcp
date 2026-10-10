#!/usr/bin/env node
// prepublishOnly gate: proves the files npm is ABOUT TO PUBLISH carry no
// foreign-tenant identity, before they leave this machine.
//
// Scanning `apps/mcp/` directly (the naive version of this check) always
// false-positives: AGENTS.md self-referentially explains that this directory
// sits inside the parent monorepo, and the parent checkout's own git remote
// resolves to that repo too. Neither ships. So this assembles the
// REAL publish set -- exactly what `npm pack` would put in the tarball, read
// from npm itself via `--dry-run --json` rather than hand-copied from the
// `files` field in package.json, which would silently go stale if `files`
// ever changed here without this script being updated too -- into a scratch
// directory and scans only that.
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractConstraints } from "./refresh-registry-constraints.mjs";
import { toolNames, versionClassVerdict, selftest } from "./version-class.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── VERSION PARITY, asserted at the only moment it can be created ───────────
//
// server.json is the manifest the OFFICIAL MCP REGISTRY publishes from, and it
// carries the version TWICE: once at the top level and once in packages[0].
// Nothing tied it to package.json, so a release that bumped package.json and
// published to npm left it behind silently.
//
// Measured 2026-09-06, three different versions across three surfaces at once:
//   official MCP registry   0.3.0
//   server.json             0.4.0
//   package.json / npm      0.5.0
// The registry version is what a buyer browsing sees, so trailing npm by two
// minor versions reads as unmaintained. I created the middle one myself, by
// bumping package.json and CHANGELOG.md for the 0.5.0 publish and not knowing
// this file needed the same edit.
//
// This runs in prepublishOnly on purpose: publishing is the ONE action that
// creates the drift, so refusing here means it cannot be created rather than
// merely being reported later by a sweep. Publishing is irreversible, which is
// why the check goes before it and not after.
// ---------------------------------------------------------------------------
// VERSION CLASS. A tool added to the catalog is a capability change, and the
// CHANGELOG states at 0.4.0 and 0.5.0 that it ships as a MINOR so a consumer
// pinned to the previous minor opts in rather than receiving it silently.
// Nothing enforced that: 0.6.0 was first cut as 0.5.4 while adding
// reddit_user_achievements (43 to 44 tools) and only an adversarial review
// caught it (2026-09-11). This compares the authored catalog against the
// PUBLISHED tarball, the emitting system, never a recorded count. It is pure in
// versionClassVerdict so it can be red-tested without the network, and the live
// path fails CLOSED when npm cannot be read: a publish that cannot see what it
// is replacing must not proceed.
function assertVersionClass() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  let published;
  try {
    published = execFileSync("npm", ["view", pkg.name, "version"], { encoding: "utf8" }).trim();
  } catch (e) {
    console.error(`\n[prepublish-tenant-check] BLOCKED: could not read the published version of ${pkg.name} from npm (${e.message.split("\n")[0]}). A publish that cannot see what it replaces does not proceed.`);
    process.exit(1);
  }
  const scratch = mkdtempSync(join(tmpdir(), "prepublish-class-"));
  let publishedTools;
  try {
    execFileSync("npm", ["pack", `${pkg.name}@${published}`, "--pack-destination", scratch], { stdio: "pipe" });
    const tgz = execFileSync("ls", [scratch], { encoding: "utf8" }).trim().split("\n").find((f) => f.endsWith(".tgz"));
    execFileSync("tar", ["-xzf", join(scratch, tgz), "-C", scratch]);
    publishedTools = readFileSync(join(scratch, "package", "src", "tools.js"), "utf8");
  } catch (e) {
    console.error(`\n[prepublish-tenant-check] BLOCKED: could not read the published tarball of ${pkg.name}@${published} (${e.message.split("\n")[0]}). If src/tools.js moved in the published layout, update the path this check reads rather than skipping it.`);
    process.exit(1);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const localNames = toolNames(readFileSync(join(PKG_ROOT, "src", "tools.js"), "utf8"));
  const publishedNames = toolNames(publishedTools);
  if (localNames.length === 0 || publishedNames.length === 0) {
    console.error(`\n[prepublish-tenant-check] BLOCKED: tool name reader saw ${localNames.length} authored and ${publishedNames.length} published tools; a zero means the anchor drifted, not an empty catalog.`);
    process.exit(1);
  }
  const v = versionClassVerdict(pkg.version, published, localNames, publishedNames);
  if (!v.ok) {
    console.error(`\n[prepublish-tenant-check] BLOCKED: ${v.reason}.`);
    process.exit(1);
  }
  console.log(`[prepublish-tenant-check] version class OK: ${v.reason}.`);
}

function assertVersionParity() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  const srv = JSON.parse(readFileSync(join(PKG_ROOT, "server.json"), "utf8"));
  const want = pkg.version;
  const found = [
    ["server.json version", srv.version],
    ["server.json packages[0].version", srv.packages?.[0]?.version],
  ];
  const bad = found.filter(([, v]) => v !== want);
  if (bad.length) {
    console.error(
      `\n[prepublish-tenant-check] BLOCKED: server.json does not match package.json ${want}.`
    );
    for (const [where, v] of bad) console.error(`  ${where} = ${v ?? "(missing)"}`);
    console.error(
      "  server.json is what the official MCP registry publishes from. Shipping this\n" +
        "  would advertise an old tool surface to anyone resolving us from the registry.\n" +
        "  Set BOTH version fields in apps/mcp/server.json and publish again."
    );
    process.exit(1);
  }
  // Named rather than silent: a passing check that prints nothing is
  // indistinguishable from one that never ran.
  console.log(`[prepublish-tenant-check] version parity OK: package.json, server.json (x2) all ${want}.`);
}
if (process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
assertVersionParity();
assertVersionClass();

// ── THE REGISTRY'S OWN LIMITS, READ FROM THE REGISTRY'S OWN SCHEMA ─────────
//
// The official MCP registry rejects a server.json description over 100
// characters with a 422. Measured 2026-09-06: ours was 110 and the publish
// failed at the registry, AFTER login, with the length reported only in the
// error body. That failure is the wrong shape: a value the registry will
// refuse should be refused HERE, where the fix is a one-line edit, rather
// than at the irreversible step.
//
// The first version of this check hardcoded `100` and looked at `description`
// alone. Both halves were wrong in the same way. 100 is THEIR number, not
// ours, so a copy of it here is a place for the two to disagree silently; and
// a gate that validates one of four constrained fields still prints a clean
// pass, which reads as "the manifest is valid" when it means "the one field I
// know about is". Measured against the live schema the same day, ServerDetail
// constrains FOUR fields: description (1..100), name (3..200 plus a pattern),
// title (1..100) and version (..255).
//
// So the constraints are extracted from the schema server.json DECLARES in
// its own $schema field, pinned into registry-schema-constraints.json by
// scripts/refresh-registry-constraints.mjs, and enforced from that pin. The
// pin is what blocks, so a network failure at publish time can never widen a
// limit. The live schema is consulted only to detect DRIFT: if it disagrees
// with the pin, that is a finding about our pin and it blocks, because
// silently adopting a new bound is how a gate stops describing reality.
const CONSTRAINTS_FILE = "registry-schema-constraints.json";

function violation(value, c) {
  if (value === undefined || value === null) return null; // presence is `required`'s job
  const v = String(value);
  if (c.minLength != null && v.length < c.minLength)
    return `is ${v.length} characters; the registry requires at least ${c.minLength}`;
  if (c.maxLength != null && v.length > c.maxLength)
    return `is ${v.length} characters; the registry rejects anything over ${c.maxLength} with a 422`;
  if (c.pattern && !new RegExp(c.pattern).test(v))
    return `does not match the registry's required pattern ${c.pattern}`;
  return null;
}

function assertRegistryLimits() {
  const srv = JSON.parse(readFileSync(join(PKG_ROOT, "server.json"), "utf8"));
  const pin = JSON.parse(readFileSync(join(PKG_ROOT, CONSTRAINTS_FILE), "utf8"));
  const fields = pin.fields || {};
  const names = Object.keys(fields);
  if (!names.length) {
    console.error(`\n[prepublish-tenant-check] BLOCKED: ${CONSTRAINTS_FILE} constrains no fields.`);
    console.error("  An empty pin cannot refuse anything. Re-run scripts/refresh-registry-constraints.mjs.");
    process.exit(1);
  }

  const problems = [];
  for (const req of pin.required || []) {
    if (srv[req] === undefined || srv[req] === null || String(srv[req]) === "")
      problems.push(`server.json is missing required field "${req}"`);
  }
  for (const [name, c] of Object.entries(fields)) {
    const why = violation(srv[name], c);
    if (why) problems.push(`server.json ${name} ${why}\n    value: ${JSON.stringify(srv[name])}`);
  }

  if (problems.length) {
    console.error("\n[prepublish-tenant-check] BLOCKED: server.json violates the MCP registry schema.");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`  Schema: ${pin.source_schema}`);
    console.error("  Fix apps/mcp/server.json and publish again.");
    process.exit(1);
  }

  // Named rather than silent, and it says WHICH fields it checked: a pass that
  // does not name its coverage is how "one of four" reads as "all of them".
  const shown = names.map((n) => `${n} ${String(srv[n] ?? "").length}/${fields[n].maxLength ?? "-"}`);
  console.log(
    `[prepublish-tenant-check] registry schema OK (${names.length} constrained field(s)): ${shown.join(", ")}.`,
  );
}
assertRegistryLimits();

// Drift check, advisory on the network and blocking on a real disagreement.
// Skipped entirely with SKIP_REGISTRY_SCHEMA_DRIFT=1, which is audit-visible.
async function assertPinMatchesLiveSchema() {
  if (process.env.SKIP_REGISTRY_SCHEMA_DRIFT === "1") {
    console.log("[prepublish-tenant-check] registry schema drift check SKIPPED (SKIP_REGISTRY_SCHEMA_DRIFT=1).");
    return;
  }
  const pin = JSON.parse(readFileSync(join(PKG_ROOT, CONSTRAINTS_FILE), "utf8"));
  const srv = JSON.parse(readFileSync(join(PKG_ROOT, "server.json"), "utf8"));
  if (srv.$schema && pin.source_schema && srv.$schema !== pin.source_schema) {
    console.error("\n[prepublish-tenant-check] BLOCKED: the pin was built from a different schema than");
    console.error(`  server.json now declares.\n    server.json $schema: ${srv.$schema}\n    pin source_schema:   ${pin.source_schema}`);
    console.error("  Re-run scripts/refresh-registry-constraints.mjs.");
    process.exit(1);
  }
  let live;
  try {
    const res = await fetch(pin.source_schema, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    live = extractConstraints(await res.json());
  } catch (e) {
    // Unreachable is not a violation: the pin above already blocked or passed.
    console.log(`[prepublish-tenant-check] registry schema drift check UNAVAILABLE (${e.message}); enforced the pin.`);
    return;
  }
  const pinned = JSON.stringify({ required: pin.required, fields: pin.fields });
  const fresh = JSON.stringify({ required: live.required, fields: live.fields });
  if (pinned !== fresh) {
    console.error("\n[prepublish-tenant-check] BLOCKED: the MCP registry schema has CHANGED since our pin.");
    console.error(`  pinned ${pin.fetched_utc}: ${pinned}`);
    console.error(`  live now:                  ${fresh}`);
    console.error("  Re-run scripts/refresh-registry-constraints.mjs, re-read the diff, then publish.");
    process.exit(1);
  }
  console.log(`[prepublish-tenant-check] registry schema pin matches live (${pin.source_schema}).`);
}
await assertPinMatchesLiveSchema();

// ── npm's OWN LIMIT, WHICH IT DOES NOT TELL YOU ABOUT ──────────────────────
//
// The MCP registry refuses an over-long description with a 422. npm does not
// refuse it. It TRUNCATES, silently, and serves the stump.
//
// MEASURED 2026-09-06 against the live registry, not read in a doc: this
// package's description is 394 characters in package.json, and
// registry.npmjs.org/redditapis-mcp/latest stores exactly 255 of them. 139
// characters were cut, and the visible end of the description on the npm page
// was the fragment "register/test/dele". That is the first thing a buyer reads
// about this package, and it had read like a broken string since the
// description was last lengthened.
//
// 255 IS AN OBSERVED BOUND, NOT A DOCUMENTED ONE, and this comment says so
// rather than dressing it up. The evidence is our own truncation landing on
// exactly 255, which is the signature of a hard cap rather than of a wrap; a
// sample of six popular packages found none stored above it (webpack, the
// longest, is 239). If npm moves the bound this reports a stale number rather
// than drifting silently, which is the right failure.
//
// The SECOND assertion is the one that would have caught this earlier and costs
// nothing: a description that does not end in sentence punctuation has almost
// certainly been cut. Length alone passes every version of this string that sits
// under the cap, and the VISIBLE defect was never the length.
const NPM_MAX_DESCRIPTION_OBSERVED = 255;

function assertNpmDescription() {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  const desc = String(pkg.description || "");
  if (!desc) {
    console.error("\n[prepublish-tenant-check] BLOCKED: package.json has no description.");
    process.exit(1);
  }
  if (desc.length > NPM_MAX_DESCRIPTION_OBSERVED) {
    console.error(`\n[prepublish-tenant-check] BLOCKED: package.json description is ${desc.length} characters.`);
    console.error(`  npm stores at most ${NPM_MAX_DESCRIPTION_OBSERVED} and truncates the rest WITHOUT an error,`);
    console.error(`  so ${desc.length - NPM_MAX_DESCRIPTION_OBSERVED} character(s) would vanish from the package page.`);
    console.error(
      `  It would be cut at: ...${JSON.stringify(desc.slice(NPM_MAX_DESCRIPTION_OBSERVED - 30, NPM_MAX_DESCRIPTION_OBSERVED))}`,
    );
    process.exit(1);
  }
  if (!/[.!?]$/.test(desc.trim())) {
    console.error("\n[prepublish-tenant-check] BLOCKED: package.json description does not end in a full stop.");
    console.error("  A description that stops mid-thought is what a truncated one looks like, and this");
    console.error("  check is cheaper than noticing it on the published page.");
    console.error(`  ends: ...${JSON.stringify(desc.trim().slice(-40))}`);
    process.exit(1);
  }
  console.log(
    `[prepublish-tenant-check] npm description OK: ${desc.length}/${NPM_MAX_DESCRIPTION_OBSERVED} chars, ends as a sentence.`,
  );
}
assertNpmDescription();

const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PKG_ROOT, encoding: "utf8" });
const [{ files }] = JSON.parse(packJson);
const paths = files.map((f) => f.path);

const scratch = mkdtempSync(join(tmpdir(), "redditapis-mcp-prepublish-"));
const dest = join(scratch, "package");
mkdirSync(dest, { recursive: true });
for (const rel of paths) {
  const src = join(PKG_ROOT, rel);
  const out = join(dest, rel);
  mkdirSync(dirname(out), { recursive: true });
  cpSync(src, out);
}

let ok = false;
try {
  execFileSync(
    "python3",
    [join(process.env.HOME, ".claude/scripts/tenant-isolation-scan.py"), "--tenant", "redditapis", "--path", dest],
    { stdio: "inherit" },
  );
  ok = true;
} catch {
  ok = false;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (!ok) {
  console.error("\n[prepublish-tenant-check] BLOCKED: the publish set failed the tenant isolation scan. Not publishing.");
  process.exit(1);
}
console.log(`[prepublish-tenant-check] PASS: ${paths.length} publish-set file(s) clean of foreign-tenant identity.`);
