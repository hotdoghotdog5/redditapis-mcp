// scripts/measure-context.mjs: what one Reddit read costs the model's context,
// before and after src/compact.js, measured rather than asserted in prose.
//
// Run: npm run measure:context
//
// It needs no API key and no network: the bodies come from the same Reddit-shaped
// fixtures the test suite uses (test/fixtures/reddit-shapes.mjs), because the
// defect being measured is a byte count and a byte count does not need a live key
// to be counted. What it does NOT establish is the exact byte count of a live
// redditapis.com response; those bodies come from Reddit and vary with the thread.
// The ratio it reports is the one that matters, and it is a floor: a real r/pics
// search with gallery posts carries more media_metadata than the fixture does.
import { createServer } from "../src/server.js";
import { TOOLS } from "../src/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { searchPage, commentTree, comment } from "../test/fixtures/reddit-shapes.mjs";

const BODIES = {
  "/api/reddit/search": () => searchPage({ n: 25 }),
  "/api/reddit/posts": () => searchPage({ n: 25 }),
  "/api/reddit/comments": () => commentTree({ top: 60, chain: 6 }),
  "/api/reddit/search/comments/deep": () => ({
    comments: Array.from({ length: 140 }, (_, i) => comment(2000 + i, { score: 300 - i, depth: 0 })),
    meta: { parents_expanded: 5 },
    after: null,
  }),
};

const CALLS = [
  ["reddit_search", { q: "rust vs go" }],
  ["reddit_subreddit_posts", { subreddit: "rust", sort: "top", t: "week" }],
  ["reddit_post_comments", { permalink: "/r/rust/comments/p1/x/" }],
  ["reddit_deep_comment_search", { q: "best mechanical keyboard" }],
];

async function runBatch(compact) {
  const fetchImpl = async (url) => {
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      // A relative URL from a mis-set base: report it as an unknown body rather
      // than throwing out of a measurement script.
    }
    const make = BODIES[path] || (() => ({}));
    return { ok: true, status: 200, headers: { get: () => "req-measure" }, text: async () => JSON.stringify(make()) };
  };
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl, compact });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "measure", version: "1" });
  await client.connect(clientT);
  const rows = [];
  for (const [name, args] of CALLS) {
    const result = await client.callTool({ name, arguments: args });
    const t = result.content[0].text;
    rows.push({ name, bytes: Buffer.byteLength(t) });
  }
  await client.close();
  return rows;
}

function describeTools(skipTools) {
  createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" }), skipTools });
  const registered = TOOLS.filter((t) => !(skipTools || []).some((p) => new RegExp(`^${String(p).split("*").join(".*")}$`, "i").test(t.name)));
  const bytes = registered.reduce((a, t) => a + (t.description || "").length + JSON.stringify(t.shape ? Object.fromEntries(Object.entries(t.shape).map(([k, v]) => [k, v?.description || ""])) : {}).length, 0);
  return { count: registered.length, bytes };
}

const tok = (b) => Math.round(b / 4);
const pad = (s) => String(s).padStart(12);

const raw = await runBatch({ raw: true });
const small = await runBatch({});

console.log(`one batch of ${CALLS.length} reads, measured on test/fixtures/reddit-shapes.mjs (no API key, no network)\n`);
console.log("tool                            unshaped bytes   compacted bytes");
for (let i = 0; i < CALLS.length; i++) {
  console.log(`${CALLS[i][0].padEnd(32)}${pad(raw[i].bytes)}${pad(small[i].bytes)}`);
}
const total = (rows) => rows.reduce((a, r) => a + r.bytes, 0);
console.log(`${"TOTAL".padEnd(32)}${pad(total(raw))}${pad(total(small))}`);
console.log(`\nas tokens at 4 bytes/token:   ${pad(tok(total(raw)))}${pad(tok(total(small)))}`);
console.log(`ratio: ${(total(raw) / total(small)).toFixed(1)}x smaller; per-call ceiling is ${small.every((r) => r.bytes <= 16000) ? "held" : "BROKEN"}`);
console.log(`a 262,144-token window: this batch alone would take ${tok(total(raw))} tokens unshaped, ${tok(total(small))} shaped`);

const all = describeTools([]);
const readsOnly = describeTools(["reddit_monitor_*", "reddit_feedback_*", "reddit_set_watch", "reddit_explain", "reddit_account_me", "reddit_verify_comments"]);
console.log(`\ntools/list text a client carries on EVERY turn:`);
console.log(`  full catalog:      ${all.count} tools, ${all.bytes} bytes (~${tok(all.bytes)} tokens)`);
console.log(`  read-only client:  ${readsOnly.count} tools, ${readsOnly.bytes} bytes (~${tok(readsOnly.bytes)} tokens) with REDDITAPIS_MCP_SKIP_TOOLS`);
