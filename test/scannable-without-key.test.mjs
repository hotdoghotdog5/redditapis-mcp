/**
 * A REGISTRY SCANNER MUST BE ABLE TO ENUMERATE OUR TOOLS WITH NO CREDENTIALS.
 *
 * Self-running, like the other tests here: `node test/scannable-without-key.test.mjs`.
 * Spawns the real server as a scanner would, over real stdio, with a DELIBERATELY
 * EMPTY env. Nothing here is mocked, because the regression being guarded against
 * is a process that exits before it can answer, and a mock cannot exit.
 *
 * WHY THIS EXISTS. src/index.js used to `process.exit(1)` when REDDITAPIS_KEY was
 * unset. tools/list is the DISCOVERY step in the MCP spec, ahead of tool selection
 * and any invocation, so a scanner calls it before it could possibly hold a key,
 * and it got nothing.
 *
 * Measured 2026-09-06 against the published package by speaking raw MCP stdio
 * with an empty env: redditapis-mcp@0.5.2 answered neither initialize nor
 * tools/list. A directory that spawns the server to enumerate its catalog gets
 * an initialization failure, not a server with zero tools.
 */
import { spawn } from "node:child_process";
import assert from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let n = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);

// Only PATH and HOME. Anything else risks inheriting a key from the developer's
// shell, which would make this test pass for the wrong reason -- the exact shape
// of a check that cannot see the defect it is named for.
function rpc(requests, env = { PATH: process.env.PATH, HOME: process.env.HOME }) {
  return new Promise((resolve) => {
    const p = spawn("node", [path.join(ROOT, "src/index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
    const results = {};
    let buf = "", stderr = "";
    const timer = setTimeout(() => p.kill(), 45000);
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        results[m.id] = m.result ?? m.error;
        const next = requests[Object.keys(results).length];
        if (next) p.stdin.write(JSON.stringify(next) + "\n");
        else { clearTimeout(timer); p.kill(); }
      }
    });
    p.on("close", (code) => resolve({ results, stderr, code }));
    p.stdin.write(JSON.stringify(requests[0]) + "\n");
  });
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "registry-scanner", version: "1" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const CALL = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reddit_subreddit_about", arguments: { name: "programming" } } };

const { results, stderr } = await rpc([INIT, LIST, CALL]);

// 1. The server must survive initialize with no key at all.
assert.ok(results[1], "the server must answer initialize with no key set");
ok("the server starts and completes initialize with an empty env");

// 2. THE POINT. A scanner enumerates the catalog without credentials.
const tools = results[2]?.tools;
assert.ok(Array.isArray(tools), `tools/list must return a list, got ${JSON.stringify(results[2])}`);
assert.ok(tools.length > 0, "tools/list must return a NON-EMPTY catalog with no key set");
ok(`tools/list returns ${tools.length} tools with no credentials`);

// 3. NEGATIVE CONTROL for the relaxation. Listing freely must not mean calling
// freely, and the failure must NAME the missing key rather than surface a 401
// about an "invalid" one, which is what a "Bearer undefined" request would do.
const call = results[3];
assert.strictEqual(call?.isError, true, `a tool call with no key must fail, got ${JSON.stringify(call).slice(0, 200)}`);
const text = call.content?.[0]?.text || "";
assert.match(text, /Missing REDDITAPIS_KEY/, `the failure must name the missing key, got: ${text.slice(0, 160)}`);
assert.doesNotMatch(text, /invalid or missing API key/, "an UNSET key must not be reported as an INVALID one");
ok("a tool call with no key fails, and says the key is missing rather than invalid");

// 4. The operator still gets told, on stderr, where the tools are.
assert.match(stderr, /Missing REDDITAPIS_KEY/, "startup must still warn that no key is set");
assert.match(stderr, /every call will fail until it is set/, "the warning must say what the consequence is");
ok("startup still warns on stderr without exiting");

console.log(`\nscannable-without-key: ${n} passed, 0 failed`);
