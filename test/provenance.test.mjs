// provenance.test.mjs: the read ledger behind reddit_explain.
//
// THE CLAIM THIS TEST HAS TO BE ABLE TO FALSIFY: that a row's provenance is
// real. Two ways it could be fake and both are checked here.
//
//   1. The age is invented. Checked with an injected clock: a recorded call at
//      T must report exactly the seconds that elapsed, and a row never reports
//      a negative age.
//   2. The ledger leaks across callers. Checked end to end through two real
//      createServer instances sharing one fetch: each must see only its own
//      calls. This is the same failure the key and the last-error record were
//      hardened against, and a ledger is one more piece of per-caller state.
//
// It also pins what the tool must NOT claim: there is no cache on the read
// path, so the result reports response_cache "none" rather than an age for a
// row nobody stored. If a cache is ever added, this assertion is the thing that
// has to be changed deliberately, which is the point of asserting it.
//
// Run alone: node test/provenance.test.mjs
import assert from "node:assert/strict";
import { createReadLedger, createExplainHandler, FRESHNESS, LEDGER_CAP } from "../src/provenance.js";
import { createServer } from "../src/server.js";

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const acheck = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

// ── the ledger ──────────────────────────────────────────────────────────────

check("the ledger is newest-first and bounded, dropping the oldest entry", () => {
  const l = createReadLedger({ cap: 3 });
  for (const t of ["a", "b", "c", "d"]) l.record({ tool: t, path: `/${t}` });
  assert.deepEqual(l.list().map((e) => e.tool), ["d", "c", "b"]);
  assert.equal(l.size, 3);
});

check("the ledger starts empty and refuses a malformed entry rather than storing a half row", () => {
  const l = createReadLedger();
  assert.deepEqual(l.list(), []);
  l.record(null);
  l.record({ path: "/x" });
  l.record({ tool: 42 });
  assert.deepEqual(l.list(), [], "only an entry naming its tool is a provenance record");
});

check("list() hands back a copy, so a caller cannot mutate the ledger through it", () => {
  const l = createReadLedger();
  l.record({ tool: "a", path: "/a" });
  l.list().push({ tool: "forged" });
  assert.equal(l.size, 1);
});

check("the default cap is the one the tool description publishes", () => {
  assert.equal(LEDGER_CAP, 20);
});

// ── the handler ─────────────────────────────────────────────────────────────

function at(ms) { return () => ms; }

await acheck("age is measured against the clock, not invented", async () => {
  const l = createReadLedger({ now: at(1_000_000) });
  l.record({ tool: "reddit_search", path: "/api/reddit/search", method: "GET", requestId: "req-7", bytes: 1234 });
  const h = createExplainHandler({ listReads: () => l.list(), now: at(1_000_000 + 95_000) });
  const r = await h({});
  const c = r.structuredContent.calls[0];
  assert.equal(c.age_seconds, 95);
  assert.equal(c.tool, "reddit_search");
  assert.equal(c.endpoint, "/api/reddit/search");
  assert.equal(c.request_id, "req-7");
  assert.equal(c.response_bytes, 1234);
  assert.equal(c.observed_at, new Date(1_000_000).toISOString());
});

await acheck("NEGATIVE: a clock that went backwards reports 0, never a negative age", async () => {
  const l = createReadLedger({ now: at(2_000_000) });
  l.record({ tool: "reddit_post", path: "/api/reddit/post/x" });
  const h = createExplainHandler({ listReads: () => l.list(), now: at(1_000_000) });
  assert.equal((await h({})).structuredContent.calls[0].age_seconds, 0);
});

await acheck("the tool filter narrows to one tool, and an unknown tool is an empty answer, not an error", async () => {
  const l = createReadLedger();
  l.record({ tool: "reddit_search", path: "/a" });
  l.record({ tool: "reddit_post", path: "/b" });
  const h = createExplainHandler({ listReads: () => l.list() });
  assert.deepEqual((await h({ tool: "reddit_search" })).structuredContent.calls.map((c) => c.endpoint), ["/a"]);
  const none = await h({ tool: "reddit_nothing" });
  assert.equal(none.structuredContent.call_count, 0);
  assert.ok(!none.isError);
  assert.match(none.content[0].text, /No completed call by reddit_nothing/);
});

await acheck("limit defaults to 5 and is clamped to the ledger cap", async () => {
  const l = createReadLedger();
  for (let i = 0; i < 20; i++) l.record({ tool: `t${i}`, path: `/${i}` });
  const h = createExplainHandler({ listReads: () => l.list() });
  assert.equal((await h({})).structuredContent.call_count, 5);
  assert.equal((await h({ limit: 20 })).structuredContent.call_count, 20);
  assert.equal((await h({ limit: 999 })).structuredContent.call_count, 20);
  assert.equal((await h({ limit: 0 })).structuredContent.call_count, 1);
});

await acheck("an empty session answers plainly rather than pretending to know something", async () => {
  const h = createExplainHandler({ listReads: () => [] });
  const r = await h({});
  assert.ok(!r.isError);
  assert.equal(r.structuredContent.call_count, 0);
  assert.match(r.content[0].text, /ledger starts empty/);
});

await acheck("the result states there is no response cache and points at the published retention page", async () => {
  const h = createExplainHandler({ listReads: () => [] });
  const sc = (await h({})).structuredContent;
  assert.equal(sc.response_cache, "none");
  assert.match(sc.response_cache_detail, /holds no response cache/);
  assert.equal(sc.retention_policy_url, "https://www.redditapis.com/privacy-and-data-handling");
  // The retention figures themselves are deliberately NOT restated here: the
  // published table is the emitting system, and a number copied into a tool
  // result drifts silently the day the table changes.
  assert.doesNotMatch(JSON.stringify(sc), /\b48\s*-?\s*hour|\b48h\b/i, "no retention period may be hardcoded into the result");
  assert.equal(FRESHNESS.response_cache, "none");
});

// ── end to end, through two real servers ────────────────────────────────────

await acheck("the ledger records a SUCCESS and never a failure, through the real call path", async () => {
  let status = 200;
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), {
    status, headers: { "content-type": "application/json", "x-request-id": "rid-1" },
  });
  const { server, callEndpoint, getReads } = createServer({ apiKey: "k", fetchImpl, feedbackEnv: {} });
  await callEndpoint("/api/reddit/post/{id}", { id: "abc" }, "GET", { name: "reddit_post" });
  assert.equal(getReads().length, 1);
  assert.equal(getReads()[0].endpoint, "/api/reddit/post/abc");
  assert.equal(getReads()[0].request_id, "rid-1");
  status = 500;
  await callEndpoint("/api/reddit/post/{id}", { id: "def" }, "GET", { name: "reddit_post" });
  assert.equal(getReads().length, 1, "a failed call produced no rows, so it has no provenance to record");
  await server.close();
});

await acheck("two servers sharing one fetch never see each other's calls", async () => {
  const fetchImpl = async () => new Response("{}", { status: 200, headers: { "x-request-id": "shared" } });
  const a = createServer({ apiKey: "ka", fetchImpl, feedbackEnv: {} });
  const b = createServer({ apiKey: "kb", fetchImpl, feedbackEnv: {} });
  await a.callEndpoint("/api/reddit/search", { q: "a" }, "GET", { name: "reddit_search" });
  await b.callEndpoint("/api/reddit/posts", { subreddit: "b" }, "GET", { name: "reddit_subreddit_posts" });
  assert.deepEqual(a.getReads().map((r) => r.tool), ["reddit_search"]);
  assert.deepEqual(b.getReads().map((r) => r.tool), ["reddit_subreddit_posts"]);
  // Positive control on the probe: if the ledger were shared, each side would
  // hold two rows, so a length of 1 on both is the discriminating result.
  assert.equal(a.getReads().length, 1);
  assert.equal(b.getReads().length, 1);
  await a.server.close();
  await b.server.close();
});

await acheck("reddit_explain makes no network call at all", async () => {
  let hits = 0;
  const fetchImpl = async () => { hits++; return new Response("{}", { status: 200 }); };
  const { server, callEndpoint } = createServer({ apiKey: "k", fetchImpl, feedbackEnv: {} });
  await callEndpoint("/api/reddit/search", { q: "x" }, "GET", { name: "reddit_search" });
  const before = hits;
  // Call the registered tool the way a client would, through the server's own
  // dispatch, so the assertion covers the shipped path rather than the module.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(ct);
  const out = await client.callTool({ name: "reddit_explain", arguments: {} });
  assert.equal(hits, before, "reddit_explain must reach no endpoint");
  assert.match(out.content[0].text, /reddit_search reached GET \/api\/reddit\/search/);
  await client.close();
});

console.log(`\nprovenance: ${n} passed, 0 failed`);
