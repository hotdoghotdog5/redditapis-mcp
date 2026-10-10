// playbooks.test.mjs: the three playbooks served as MCP resources.
//
// WHAT WOULD MAKE THIS GREEN FOR THE WRONG REASON, and what stops it: a test
// that imports PLAYBOOKS and asserts over the array proves the array is
// well-formed, not that a client can reach it. Everything below goes through a
// real McpServer built by the package's own createServer and a real client over
// an in-memory transport, so resources/list and resources/read are the shipped
// path, exactly as the description-compliance test does for tools.
//
// THE RECIPE-ROT CHECK is the one worth having: a playbook that names a tool
// the catalog does not carry is a recipe that fails on the first step, and it
// rots silently because nothing else reads these documents. Every reddit_ token
// in every body is checked against the live catalog.
//
// Run alone: node test/playbooks.test.mjs
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";
import { PLAYBOOKS, playbookUri, PLAYBOOK_SCHEME } from "../src/playbooks.js";

let n = 0;
const ok = (m) => console.log(`  ok  ${m}`);

const { server } = createServer({ apiKey: undefined, feedbackEnv: {} });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "playbooks-test", version: "1" });
await client.connect(ct);

const { resources } = await client.listResources();
assert.equal(resources.length, 3, `expected 3 playbooks, listed ${resources.length}`);
assert.deepEqual(
  resources.map((r) => r.uri).sort(),
  ["competitor-mention-watch", "pain-point-mining", "subreddit-audit"].map(playbookUri).sort(),
);
n++; ok("resources/list returns the three playbooks at playbook:// URIs");

for (const r of resources) {
  assert.ok(r.title && r.title.length > 3, `${r.uri}: no title`);
  assert.ok(r.description && r.description.length > 40, `${r.uri}: weak description`);
  assert.equal(r.mimeType, "text/markdown", `${r.uri}: unexpected mimeType`);
}
n++; ok("every playbook carries a title, a description and text/markdown");

const bodies = new Map();
for (const r of resources) {
  const read = await client.readResource({ uri: r.uri });
  assert.equal(read.contents.length, 1, `${r.uri}: expected one content part`);
  const c = read.contents[0];
  assert.equal(c.uri, r.uri, `${r.uri}: content uri does not match the resource uri`);
  assert.equal(c.mimeType, "text/markdown");
  assert.ok(c.text.startsWith("# "), `${r.uri}: a playbook body opens with its heading`);
  assert.ok(c.text.length > 800, `${r.uri}: body is only ${c.text.length} chars, too thin to follow`);
  assert.ok(/\n## Steps\n|\n## /.test(c.text), `${r.uri}: body has no sections`);
  bodies.set(r.uri, c.text);
}
n++; ok("resources/read returns a markdown document for each, matching its own URI");

// NEGATIVE CONTROL: a URI the server does not serve must fail, not return an
// empty document. Without this, a read that silently returns nothing would make
// every assertion above pass against a server serving no content at all.
let refused = false;
try {
  await client.readResource({ uri: `${PLAYBOOK_SCHEME}://not-a-playbook` });
} catch {
  refused = true;
}
assert.ok(refused, "an unknown playbook URI must be refused, not answered with an empty document");
n++; ok("NEGATIVE: an unknown playbook:// URI is refused");

// RECIPE ROT. Every tool a playbook names must exist in the catalog the same
// server just registered.
const catalog = new Set(TOOLS.map((t) => t.name));
const named = new Map();
for (const [uri, text] of bodies) {
  for (const m of text.matchAll(/\breddit_[a-z0-9_]+\b/g)) {
    if (!named.has(m[0])) named.set(m[0], uri);
  }
}
const ghosts = [...named.entries()].filter(([name]) => !catalog.has(name));
assert.deepEqual(ghosts, [], `playbooks name tools the catalog does not carry: ${JSON.stringify(ghosts)}`);
// Positive control on the scan: a playbook that named nothing would pass the
// line above vacuously, so the scan must have found real tool names.
assert.ok(named.size >= 10, `the tool-name scan found only ${named.size} names across 3 playbooks; the scan is broken, not the playbooks`);
n++; ok(`every one of the ${named.size} tools named across the playbooks exists in the catalog`);

// A playbook built on a capability this package does not expose would be a
// recipe nobody can run, so the new composite tool must actually appear.
assert.ok([...named.keys()].includes("reddit_set_watch"), "no playbook routes through the one-call watch");
assert.ok([...named.keys()].includes("reddit_monitor_health"), "no playbook checks that a monitor is actually watching");
n++; ok("the playbooks route through the composite watch and the health check");

// Registering resources must not disturb the tool catalog.
const { tools } = await client.listTools();
assert.ok(tools.length >= 46, `tools/list returned ${tools.length}; resources must not displace tools`);
assert.ok(tools.some((t) => t.name === "reddit_explain"));
n++; ok(`tools/list still returns the full ${tools.length}-tool catalog alongside the resources`);

assert.equal(PLAYBOOKS.length, 3);
assert.equal(new Set(PLAYBOOKS.map((p) => p.slug)).size, 3, "duplicate playbook slug");
assert.equal(new Set(PLAYBOOKS.map((p) => p.name)).size, 3, "duplicate playbook name");
n++; ok("playbook slugs and registration names are unique");

await client.close();
console.log(`\nplaybooks: ${n} passed, 0 failed`);
