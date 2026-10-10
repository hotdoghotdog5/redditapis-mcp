// version-class.mjs: pure helpers for the publish-time version-class check.
// Kept in their own module so a test can import them without running the
// gate that uses them (the gate module executes on import by design).
//
// A tool ADDED, REMOVED or RENAMED is a capability change for a pinned
// consumer, and ships as a MINOR so anyone pinned to the previous minor opts
// in rather than receiving it silently. A count comparison cannot see a
// removal paired with an addition, or a rename, so this works on the SET of
// tool names read from the catalog source on both sides.
export function toolNames(toolsSource) {
  return [...toolsSource.matchAll(/^    name: "([^"]+)"/gm)].map((m) => m[1]);
}
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? m.slice(1).map(Number) : null;
}
export function versionClassVerdict(localVersion, publishedVersion, localNames, publishedNames) {
  const l = parse(localVersion);
  const p = parse(publishedVersion);
  if (!l) return { ok: false, reason: `authored version ${JSON.stringify(localVersion)} is not MAJOR.MINOR.PATCH` };
  if (!p) return { ok: false, reason: `published version ${JSON.stringify(publishedVersion)} is not MAJOR.MINOR.PATCH` };
  const cmp = l[0] - p[0] || l[1] - p[1] || l[2] - p[2];
  if (cmp <= 0) return { ok: false, reason: `authored ${localVersion} is not above published ${publishedVersion}` };
  const local = new Set(localNames);
  const pub = new Set(publishedNames);
  const added = [...local].filter((n) => !pub.has(n));
  const removed = [...pub].filter((n) => !local.has(n));
  if (added.length === 0 && removed.length === 0) {
    return { ok: true, reason: `tool catalog unchanged by name (${pub.size} published, ${local.size} authored)` };
  }
  const change = `added [${added.join(", ")}] removed [${removed.join(", ")}]`;
  const minorOrMajor = l[0] > p[0] || (l[0] === p[0] && l[1] > p[1]);
  if (minorOrMajor) return { ok: true, reason: `tool catalog changed (${change}) and ${localVersion} is a minor or major over ${publishedVersion}` };
  return { ok: false, reason: `tool catalog changed (${change}) but ${localVersion} is a PATCH over ${publishedVersion}; cut a minor` };
}
export function selftest() {
  const A = ["a", "b", "c"];
  const cases = [
    ["unchanged, patch", ["0.6.1", "0.6.0", A, A], true],
    ["added, minor", ["0.6.0", "0.5.3", [...A, "d"], A], true],
    ["added, major", ["1.0.0", "0.5.3", [...A, "d"], A], true],
    ["added, PATCH must be refused", ["0.5.4", "0.5.3", [...A, "d"], A], false],
    ["removed, PATCH must be refused", ["0.6.1", "0.6.0", ["a", "b"], A], false],
    ["renamed, same count, PATCH must be refused", ["0.6.1", "0.6.0", ["a", "b", "x"], A], false],
    ["removed, minor", ["0.7.0", "0.6.0", ["a", "b"], A], true],
    ["downgrade is refused with its own reason", ["0.5.4", "0.6.0", A, A], false],
    ["malformed authored version is refused", ["v1.0.0", "0.6.0", A, A], false],
    ["prerelease is refused", ["0.6.1-rc1", "0.6.0", A, A], false],
  ];
  let bad = 0;
  for (const [name, args, want] of cases) {
    const got = versionClassVerdict(...args).ok;
    console.log(`  [${got === want ? "PASS" : "FAIL"}] ${name}: ok=${got} want=${want}`);
    if (got !== want) bad += 1;
  }
  const names = toolNames('export const TOOLS = [\n  {\n    name: "a",\n  },\n  {\n    name: "b",\n    shape: { name: z.string() },\n  },\n];');
  const okNames = names.length === 2 && names[0] === "a" && names[1] === "b";
  console.log(`  [${okNames ? "PASS" : "FAIL"}] toolNames anchors on the tool row, not nested name keys: got ${JSON.stringify(names)}`);
  if (!okNames) bad += 1;
  console.log(`[version-class --selftest] ${bad === 0 ? "PASS" : "FAIL"} ${cases.length + 1 - bad} of ${cases.length + 1}`);
  return bad === 0;
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}
