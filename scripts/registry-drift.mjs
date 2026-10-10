#!/usr/bin/env node
// registry-drift.mjs: keeps the official MCP registry in step with npm.
//
// WHY. npm and the official MCP registry (registry.modelcontextprotocol.io) are
// two separate publishes. An npm release never updated the registry, so the
// registry listing fell behind by many versions and every client that installs
// from it got an old server. This script is both halves of the fix:
//
//   node scripts/registry-drift.mjs            CHECK: exit 1 on drift
//   node scripts/registry-drift.mjs --publish  PUBLISH the registry entry when it
//                                              lags npm, then re-check
//
// `--publish` runs as `postpublish`, so every npm release also updates the
// registry. It authenticates with `mcp-publisher login github --token`, a PAT
// for an account that owns this server's io.github.<owner> namespace, read from
// MCP_REGISTRY_GITHUB_TOKEN. No interactive login is needed.
//
// What must agree: server.json version == its npm package version == npm
// latest == the registry's latest entry for this server name.
//
// EXIT 0 in step | 1 drift (or a failed publish) | 2 cannot evaluate. A check
// that could not run is never a pass.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.MCP_REGISTRY_URL || "https://registry.modelcontextprotocol.io";
const publish = process.argv.includes("--publish");

function fail2(msg) {
  console.error(`[registry-drift] CANNOT EVALUATE: ${msg}`);
  process.exit(2);
}

let server;
try {
  server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
} catch (e) {
  fail2(`server.json unreadable: ${e.message}`);
}
const name = server.name;
const pkg = (server.packages || []).find((p) => p.registryType === "npm" || p.registry_type === "npm");
if (!name || !pkg?.identifier) fail2("server.json has no name or no npm package entry");
const serverVersion = server.version;
const pkgVersion = pkg.version;

function npmLatest() {
  try {
    return execFileSync("npm", ["view", pkg.identifier, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
  } catch (e) {
    fail2(`npm view ${pkg.identifier} failed: ${(e.stderr || e.message).toString().trim()}`);
  }
}

async function registryLatest() {
  // The direct per-server endpoint, not search: search is slower and matches
  // loosely. The registry is often slow (measured 0.1s to 30s+ on 2026-09-30),
  // so each attempt is bounded and retried; if every attempt fails it is
  // CANNOT EVALUATE, never a pass.
  const url = `${REGISTRY}/v0/servers/${encodeURIComponent(name)}/versions/latest`;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (r.status === 404) return { latest: null };
      if (!r.ok) { lastErr = `HTTP ${r.status}`; continue; }
      const body = await r.json();
      const srv = body.server || body;
      if (srv.name !== name) fail2(`registry answered for ${srv.name}, not ${name}`);
      return { latest: srv.version };
    } catch (e) {
      lastErr = e.message;
    }
  }
  fail2(`registry unreachable after 3 attempts (${lastErr}): ${url}`);
}

async function check(label) {
  const npm = npmLatest();
  const reg = await registryLatest();
  console.log(`[registry-drift] ${label}: ${name}`);
  console.log(`  server.json version ${serverVersion}, package entry ${pkgVersion}`);
  console.log(`  npm latest          ${npm}`);
  console.log(`  registry latest     ${reg.latest ?? "(none)"}`);
  const problems = [];
  if (serverVersion !== pkgVersion) problems.push(`server.json version ${serverVersion} != its package entry ${pkgVersion}`);
  if (pkgVersion !== npm) problems.push(`server.json declares ${pkgVersion} but npm latest is ${npm}`);
  if (reg.latest !== npm) problems.push(`registry latest ${reg.latest ?? "(none)"} lags npm latest ${npm}`);
  return { npm, reg, problems };
}

// As postpublish, npm has ALREADY published (irreversibly) when this runs, and
// `npm view` can lag a fresh publish for a while. Wait for npm to show the
// version server.json declares before judging, so a lag is never reported as
// a failure of a publish that succeeded.
let first = await check("before");
if (publish && pkgVersion !== first.npm) {
  // Measured 2026-09-30: npm view took 2 to 3 minutes to list a fresh publish on
  // both products, so a 2-minute wait failed real releases. Wait up to 6.
  for (let i = 0; i < 36 && pkgVersion !== first.npm; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    first = await check(`waiting for npm to list ${pkgVersion} (${i + 1})`);
  }
}
const NPM_OK = publish ? " The npm publish itself SUCCEEDED; only the registry step did not. Re-run: npm run check:registry-drift -- --publish" : "";
if (first.problems.length === 0) {
  console.log("[registry-drift] IN STEP: registry, npm and server.json agree.");
  process.exit(0);
}
for (const p of first.problems) console.log(`  DRIFT: ${p}`);
if (!publish) {
  console.log("[registry-drift] run with --publish (postpublish does) to update the registry.");
  process.exit(1);
}
if (serverVersion !== first.npm || pkgVersion !== first.npm) {
  console.error("[registry-drift] REFUSED to publish: server.json does not describe the version on npm. Fix server.json first." + NPM_OK);
  process.exit(1);
}
const token = process.env.MCP_REGISTRY_GITHUB_TOKEN || "";
if (!token) {
  console.error("[registry-drift] REFUSED to publish: MCP_REGISTRY_GITHUB_TOKEN is not set (a PAT for the namespace owner)." + NPM_OK);
  process.exit(1);
}
try {
  execFileSync("mcp-publisher", ["login", "github", "--token", token], { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
  const out = execFileSync("mcp-publisher", ["publish"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  console.log(out.trim().split("\n").slice(-3).join("\n"));
} catch (e) {
  console.error(`[registry-drift] PUBLISH FAILED: ${(e.stderr || "").toString().trim().split("\n").slice(-3).join(" | ") || "mcp-publisher exited non-zero"}.${NPM_OK}`);
  process.exit(1);
}
// The registry can take a moment to list a new version; poll before judging.
for (let i = 0; i < 12; i++) {
  const again = await check(`after publish (poll ${i + 1})`);
  if (again.problems.length === 0) {
    console.log("[registry-drift] IN STEP after publish.");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.error("[registry-drift] published, but the registry still lags npm after 2 minutes." + NPM_OK);
process.exit(1);
