#!/usr/bin/env node
/**
 * Builds the MCPB bundle Smithery needs for a stdio release.
 *
 * WHY THIS EXISTS
 * ---------------
 * Smithery's server record and its RELEASE are two different things, and only
 * the second one makes a listing real. Measured 2026-09-06: creating the record
 * for redditapis/redditapis-mcp returned 201 and both smithery hosts then served
 * it, while `GET .../releases` returned an empty array, the public page was 421
 * bytes of shell, and a registry search for "redditapis" returned ten rows with
 * ours absent. A present-but-empty listing reads as done and does nothing, which
 * is the worse half of not being listed at all.
 *
 * A stdio release is a multipart upload of an MCPB bundle, so the bundle has to
 * exist before the listing can. This script builds it.
 *
 * THE MANIFEST IS GENERATED, NEVER HAND-WRITTEN
 * --------------------------------------------
 * Every field it carries already lives somewhere authoritative: name, version,
 * description, license and author in package.json; the configuration a user has
 * to supply in smithery.yaml, which is the file Smithery already reads. Writing
 * a fourth copy by hand would create exactly the drift the prepublish version
 * check was added to stop this morning, when the registry served 0.3.0 while
 * server.json said 0.4.0 and npm said 0.5.0.
 *
 * THE BUNDLE CONTENTS COME FROM `npm pack`, NOT FROM A HAND-PICKED LIST. The
 * same source of truth the tenant-isolation gate uses, so the bundle a Smithery
 * user installs is byte-for-byte the tarball an npm user installs, and a change
 * to the `files` field cannot silently desynchronise the two.
 *
 * Usage:
 *   node scripts/build-mcpb.mjs            # build + validate
 *   node scripts/build-mcpb.mjs --out DIR  # write somewhere other than dist/
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--out");
const OUT_DIR = outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : join(PKG_ROOT, "dist");

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));

/**
 * Read smithery.yaml's configSchema without adding a YAML dependency for one
 * file we control. This is deliberately narrow: it handles the flat
 * string-property shape that file actually has, and THROWS on anything it does
 * not recognise rather than silently emitting an empty user_config. A bundle
 * that forgets to ask for the API key installs cleanly and then fails on every
 * call, which is the failure mode worth being loud about.
 */
export function parseSmitheryConfig(yaml) {
  const lines = yaml.split("\n");
  const required = new Set();

  const reqIdx = lines.findIndex((l) => /^\s*required:\s*$/.test(l));
  if (reqIdx >= 0) {
    for (let i = reqIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s*(\S+)\s*$/);
      if (!m) break;
      required.add(m[1]);
    }
  }

  const propsIdx = lines.findIndex((l) => /^\s*properties:\s*$/.test(l));
  if (propsIdx === -1) throw new Error("smithery.yaml has no properties: block");
  const propIndent = (lines[propsIdx].match(/^(\s*)/)[1] || "").length + 2;

  // Count the keys at the property indent level INDEPENDENTLY of parsing them,
  // then assert the two agree. The first version of this function used one
  // regex to do both, matched redditapisKey and silently dropped
  // redditapisBaseUrl, and returned a non-empty object so the "parsed to ZERO
  // fields" guard never fired. A parser that can lose a field quietly is worse
  // than one that cannot parse at all, because the bundle still builds.
  const keyLines = [];
  for (let i = propsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = (line.match(/^(\s*)/)[1] || "").length;
    if (indent < propIndent) break; // left the properties block
    if (indent === propIndent && /^\s*\w+:\s*$/.test(line)) keyLines.push(i);
  }

  const props = {};
  for (let n = 0; n < keyLines.length; n++) {
    const at = keyLines[n];
    const key = lines[at].trim().replace(/:$/, "");
    const stop = n + 1 < keyLines.length ? keyLines[n + 1] : lines.length;
    const scalars = {};
    for (let i = at + 1; i < stop; i++) {
      const m = lines[i].match(/^\s+(\w+):\s*(.+?)\s*$/);
      if (m) scalars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (!scalars.type) throw new Error(`smithery.yaml property "${key}" declares no type`);
    props[key] = { type: scalars.type, title: scalars.title, description: scalars.description };
    if (scalars.default !== undefined) props[key].default = scalars.default;
  }

  if (Object.keys(props).length !== keyLines.length) {
    throw new Error(
      `parsed ${Object.keys(props).length} propert(ies) but the file declares ${keyLines.length}; ` +
        "the parser is dropping fields",
    );
  }
  if (!keyLines.length) throw new Error("smithery.yaml properties: block parsed to ZERO fields");
  for (const r of required) {
    if (!(r in props)) throw new Error(`smithery.yaml requires "${r}" but declares no such property`);
  }
  return { props, required };
}

/**
 * MCPB user_config, derived from the Smithery config schema. The API key is
 * marked sensitive so a host stores it as a secret rather than in plain config;
 * getting that wrong is a credential-handling defect, not a cosmetic one.
 */
export function toUserConfig({ props, required }) {
  const out = {};
  for (const [key, spec] of Object.entries(props)) {
    const sensitive = /key|token|secret|password/i.test(key);
    out[key] = {
      type: spec.type === "string" ? "string" : spec.type,
      title: spec.title || key,
      description: spec.description || spec.title || key,
      required: required.has(key),
      ...(sensitive ? { sensitive: true } : {}),
      ...(spec.default !== undefined ? { default: spec.default } : {}),
    };
  }
  return out;
}

/** Map a user_config key to the env var the server actually reads. */
const ENV_FOR = { redditapisKey: "REDDITAPIS_KEY", redditapisBaseUrl: "REDDITAPIS_BASE_URL" };

export function buildManifest(pkgJson, userConfig) {
  const env = {};
  for (const key of Object.keys(userConfig)) {
    const name = ENV_FOR[key];
    if (!name) throw new Error(`no env mapping for config key "${key}"; add it to ENV_FOR rather than dropping it`);
    env[name] = `\${user_config.${key}}`;
  }
  return {
    manifest_version: "0.2",
    name: pkgJson.name,
    display_name: "RedditAPIs",
    version: pkgJson.version,
    description: pkgJson.description,
    author: { name: "RedditAPIs", url: "https://www.redditapis.com" },
    homepage: pkgJson.homepage,
    documentation: "https://docs.redditapis.com",
    repository: { type: "git", url: pkgJson.repository?.url },
    license: pkgJson.license,
    keywords: pkgJson.keywords,
    server: {
      type: "node",
      entry_point: "src/index.js",
      mcp_config: { command: "node", args: ["${__dirname}/src/index.js"], env },
    },
    user_config: userConfig,
  };
}

function main() {
  const yaml = readFileSync(join(PKG_ROOT, "smithery.yaml"), "utf8");
  const userConfig = toUserConfig(parseSmitheryConfig(yaml));
  const manifest = buildManifest(pkg, userConfig);

  // The publish set npm would ship, read from npm rather than from a copy of
  // the `files` field, so the two cannot drift.
  const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PKG_ROOT, encoding: "utf8" });
  const [{ files }] = JSON.parse(packJson);
  if (!files.length) throw new Error("npm pack reported ZERO files");

  const stage = mkdtempSync(join(tmpdir(), "redditapis-mcpb-"));
  try {
    for (const { path: rel } of files) {
      const dest = join(stage, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(join(PKG_ROOT, rel), dest);
    }
    if (!existsSync(join(stage, manifest.server.entry_point))) {
      throw new Error(`entry_point ${manifest.server.entry_point} is not in the npm publish set`);
    }
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "validate", join(stage, "manifest.json")], {
      stdio: "inherit",
    });

    mkdirSync(OUT_DIR, { recursive: true });
    const out = join(OUT_DIR, `${pkg.name}-${pkg.version}.mcpb`);
    execFileSync("npx", ["--yes", "@anthropic-ai/mcpb", "pack", stage, out], { stdio: "inherit" });
    console.log(`\n[build-mcpb] ${out}`);
    console.log(`[build-mcpb] ${files.length} file(s) from the npm publish set, plus a generated manifest.`);
    console.log(`[build-mcpb] user_config: ${Object.keys(userConfig).join(", ")}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
