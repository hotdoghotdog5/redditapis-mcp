// compact.test.mjs: the response-size guard.
//
// THE DEFECT THIS EXISTS FOR. A client that puts every tool result back into the
// next request (Open WebUI, Claude, Cursor: all of them) had no bound on what one
// Reddit read could cost. Four calls in one research turn returned the numbers
// asserted in check 3 below as the RAW baseline -- a 25-post search page, a
// subreddit listing, a 60-comment thread with reply chains, and a deep comment
// search -- and the pair of search pages alone is larger than a whole session's
// worth of budget in a small-context client. The report this change came in with
// was four calls producing ~800,000 characters in one turn and a chat that died
// on context.
//
// WHAT IS CHECKED, in order:
//   1  the defaulted `limit` reaches the wire, and only when the caller omitted it
//   2  a compacted result carries the `context` block with honest counts
//   3  the four-call batch, RAW against compacted: the regression itself
//   4  comment trees: the top N by score, reply caps, depth cap, [deleted] pruned,
//      and the SURVIVORS still in the endpoint's own order
//   5  the Reddit field families are gone and the readable parts survive
//   6  an unknown giant field cannot blow the budget (the structural ceiling)
//   7  REDDITAPIS_MCP_RAW / raw:true is byte-identical to the old behaviour
//   8  writes and the free /feedback mount are never shaped (a webhook secret shown
//      once must not be filtered away)
//   9  a body that is not JSON is still bounded
//   10 Reddit's raw `{kind,data}` listing wrapper is handled, not guessed at
//   11 skipTools registration filter
//   12 an error result is passed through untouched
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { compactionFromEnv, shapeBody, COMPACT_DEFAULTS } from "../src/compact.js";
import { post, comment, commentTree, searchPage, wrappedSearchPage } from "./fixtures/reddit-shapes.mjs";
import { liveThread, liveListing } from "./fixtures/live-shapes.mjs";

let n = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);
const bytes = (s) => Buffer.byteLength(s);

// ── the fake upstream: Reddit-shaped bodies, and every URL that was asked for ──
function connect(opts = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const p = u.pathname;
    let body = "{}";
    if (p === "/api/reddit/search" || p === "/api/reddit/posts") body = JSON.stringify(searchPage({ n: 25 }));
    else if (p === "/api/reddit/search/wrapped") body = JSON.stringify(wrappedSearchPage({ n: 3 }));
    else if (p === "/api/reddit/comments") body = JSON.stringify(commentTree({ top: 60, chain: 6 }));
    else if (p === "/api/reddit/post/p1") body = JSON.stringify({ post: post(1, { gallery: true }), comments: commentTree({ top: 60, chain: 6 }).comments });
    else if (p === "/api/reddit/search/comments/deep") {
      body = JSON.stringify({
        comments: Array.from({ length: 140 }, (_, i) => comment(2000 + i, { score: 300 - i, depth: 0 })),
        meta: { parents_expanded: 5, truncated: false },
        after: null,
      });
    } else if (p === "/api/reddit/sub/rust/comments") {
      body = JSON.stringify({ comments: Array.from({ length: 40 }, (_, i) => comment(3000 + i, { depth: 0 })), after: "cursor" });
    } else if (p === "/api/reddit/monitor/deliveries") {
      body = JSON.stringify({
        deliveries: Array.from({ length: 50 }, (_, i) => ({
          id: `dlv_${i}`, status: "delivered", created_at: "2026-10-01T00:00:00Z", monitor_id: "mon_1",
          payload: { items: [{ title: `Match ${i}`, subreddit: "startups", permalink: `/r/startups/comments/x/${i}/`, enrichment: { relevance: { score: 0.7, method: "keyword" }, sentiment: { polarity: 0.2, label: "positive" } } }] },
        })),
        count: 50,
      });
    } else if (p === "/api/reddit/monitor/webhook/create") {
      body = JSON.stringify({ webhook: { id: "wh_1", url: "https://hooks.slack.com/services/T/B/X", kind: "slack", secret: "whsec_secret_shown_once" } });
    } else if (p === "/feedback") {
      body = JSON.stringify({ feedback: [{ id: "fb_1", type: "bug", status: "triaged", title: "x", details: LOREMSHORT }], count: 1, next_cursor: null });
    } else if (p === "/api/reddit/unknown/giant") {
      body = JSON.stringify({ posts: [{ ...post(7, { gallery: true }), mystery_blob: "z".repeat(300000) }] });
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => body };
  };
  const { server, compactor } = createServer({
    apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl, ...opts,
  });
  return connectWith(server, calls, compactor);
}
const LOREMSHORT = "the report body as stored on the server";

async function connectWith(server, calls, compactor) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "compact-test", version: "1" });
  await client.connect(clientT);
  return { client, calls, compactor, text: async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text };
}

// 1 ───────────────────────────────────────────────────────────────────────────
const s = await connect({});
{
  await s.text("reddit_subreddit_posts", { subreddit: "rust", sort: "top", t: "week" });
  assert.match(s.calls.at(-1), /[?&]limit=10(&|$)/, `a read with no limit must send this server's default, got ${s.calls.at(-1)}`);

  await s.text("reddit_search", { q: "rust vs go", limit: 50 });
  assert.match(s.calls.at(-1), /[?&]limit=50(&|$)/, "a caller's own limit is never overwritten");
  assert.doesNotMatch(s.calls.at(-1), /limit=10(&|$)/, "and it is not merged with the default");

  // The one read that bills for fan-out must never have its default RAISED.
  await s.text("reddit_deep_comment_search", { q: "best mechanical keyboard" });
  assert.match(s.calls.at(-1), /[?&]limit=5(&|$)/, "deep comment search keeps the endpoint's own 5-parent default");

  await s.text("reddit_monitor_deliveries", {});
  assert.match(s.calls.at(-1), /[?&]limit=20(&|$)/, "deliveries default to 20 rows, not the endpoint's 50");

  // A tool with no `limit` argument grows no argument of its own.
  await s.text("reddit_post_comments", { permalink: "/r/rust/comments/p1/x/" });
  assert.doesNotMatch(s.calls.at(-1), /limit=/, "reddit_post_comments takes no limit; none is invented");
  ok("defaulted `limit` reaches the wire for the tools that take one, and never overrides a caller's");
}

// 2 ───────────────────────────────────────────────────────────────────────────
{
  const raw = await s.text("reddit_search", { q: "rust" });
  const j = JSON.parse(raw);
  assert.ok(j.context, "a trimmed result must carry `context`");
  assert.equal(j.context.source_bytes, bytes(JSON.stringify(searchPage({ n: 25 }))), "context.source_bytes is the upstream body size");
  assert.ok(j.context.bytes <= COMPACT_DEFAULTS.maxBytes, `context.bytes ${j.context.bytes} over budget`);
  assert.equal(j.context.bytes, bytes(raw), "context.bytes is the size of the text actually returned");
  assert.equal(j.context.budget_bytes, COMPACT_DEFAULTS.maxBytes);
  assert.ok(j.context.est_tokens >= Math.floor(j.context.bytes / 4) - 1, "est_tokens is reported as an estimate of the same text");
  assert.ok(j.context.trimmed.fields > 0, "the field families dropped are counted");
  assert.ok(j.context.trimmed.bodies > 0, "the shortened bodies are counted");
  assert.match(j.context.how_to_widen, /limit/, "and the result says how to widen it");
  assert.equal(j.context.limit_defaulted, 10, "and says that the page size was chosen for the caller");
  // The listing envelope survives: a caller still gets its cursor and its
  // completeness flags, which is how it knows whether the answer is partial.
  assert.equal(j.after, "t3_lastcursor");
  assert.equal(j.listing_status, "unknown");
  assert.ok(j.meta && j.meta.matched === 4210, "the endpoint's own `meta` is not disturbed by `context`");
  ok(`a 25-post page returns ${j.context.bytes} bytes of ${j.context.source_bytes} upstream, with the counts and the cursor intact`);
}

// 3 ───────────────────────────────────────────────────────────────────────────
// THE REPORTED FAILURE, as a four-call batch: search, a listing, a comment tree,
// and a deep comment search. This is the regression check for the whole change.
{
  const raw = await connect({ compact: { raw: true } });
  const before = [];
  for (const [name, args] of [
    ["reddit_search", { q: "rust vs go" }],
    ["reddit_subreddit_posts", { subreddit: "rust", sort: "top", t: "week" }],
    ["reddit_post_comments", { permalink: "/r/rust/comments/p1/x/" }],
    ["reddit_deep_comment_search", { q: "best mechanical keyboard" }],
  ]) before.push(bytes(await raw.text(name, args)));
  const beforeTotal = before.reduce((a, b) => a + b, 0);
  assert.ok(beforeTotal > 400000, `the raw batch should reproduce the reported scale, got ${beforeTotal} bytes`);

  const after = [];
  for (const [name, args] of [
    ["reddit_search", { q: "rust vs go" }],
    ["reddit_subreddit_posts", { subreddit: "rust", sort: "top", t: "week" }],
    ["reddit_post_comments", { permalink: "/r/rust/comments/p1/x/" }],
    ["reddit_deep_comment_search", { q: "best mechanical keyboard" }],
  ]) after.push(bytes(await s.text(name, args)));
  const afterTotal = after.reduce((a, b) => a + b, 0);
  for (const [i, b] of after.entries()) {
    assert.ok(b <= COMPACT_DEFAULTS.maxBytes, `call ${i} returned ${b} bytes, over the ${COMPACT_DEFAULTS.maxBytes} budget`);
  }
  assert.ok(afterTotal <= 4 * COMPACT_DEFAULTS.maxBytes, `the batch cost ${afterTotal} bytes`);
  assert.ok(afterTotal < beforeTotal / 8, `expected an order of magnitude down, got ${beforeTotal} -> ${afterTotal}`);
  console.log(`     batch: ${beforeTotal} bytes raw -> ${afterTotal} bytes compacted (${(beforeTotal / afterTotal).toFixed(1)}x, ${Math.round(beforeTotal / 4)} -> ${Math.round(afterTotal / 4)} est. tokens)`);
  ok(`four reads cost ${beforeTotal} bytes RAW and ${afterTotal} bytes compacted, each under ${COMPACT_DEFAULTS.maxBytes}`);
}

// 4 ───────────────────────────────────────────────────────────────────────────
{
  const tree = JSON.parse(await s.text("reddit_post_comments", { permalink: "/r/rust/comments/p1/x/" }));
  assert.ok(tree.comments.length <= COMPACT_DEFAULTS.commentsPerPost, "the tree's top level is capped");
  if (tree.comments.length < COMPACT_DEFAULTS.commentsPerPost) {
    assert.ok(tree.context.tightened_to > 0, `fewer than ${COMPACT_DEFAULTS.commentsPerPost} comments came back without the ladder being reported`);
  }
  const minKeptScore = Math.min(...tree.comments.map((c) => c.score));
  for (const c of tree.comments) {
    assert.ok(c.score >= minKeptScore, "kept comments are the high-scoring ones");
    if (c.replies) assert.ok(c.replies.length <= COMPACT_DEFAULTS.repliesPerComment, "replies per comment are capped");
    for (const r of c.replies || []) assert.ok(r.depth <= COMPACT_DEFAULTS.commentDepth, "reply depth is capped");
    assert.notEqual(c.body, "[deleted]", "[deleted] comments carry no answer");
    assert.notEqual(c.body, "[removed]");
  }
  // Every kept comment must outscore every dropped one, or the wrong ten were kept.
  const droppedMax = Math.max(...commentTree({ top: 60, chain: 6 }).comments
    .filter((c) => !tree.comments.some((t) => t.id === c.id) && c.body !== "[deleted]" && c.body !== "[removed]")
    .map((c) => c.score));
  assert.ok(minKeptScore >= droppedMax, `the kept set (${minKeptScore}) must outscore the dropped set (${droppedMax})`);
  assert.ok(tree.context.trimmed.comments > 0 && tree.context.trimmed.pruned > 0, "dropped comments and [deleted] rows are counted");
  for (const c of tree.comments) {
    if (c.replies) assert.ok(c.replies.length <= COMPACT_DEFAULTS.repliesPerComment, "replies per comment are capped");
    if (c.replies) for (const r of c.replies) assert.ok(r.depth <= COMPACT_DEFAULTS.commentDepth, "reply depth is capped");
    assert.notEqual(c.body, "[deleted]", "[deleted] comments carry no answer");
    assert.notEqual(c.body, "[removed]");
  }
  assert.ok(tree.post && tree.post.title, "the post itself still comes back");
  assert.ok(!("media_metadata" in tree.post) && !("author_flair_template_id" in tree.post), "and the post carries no browser payload");

  // Reply selection by score with MORE replies than the cap, and survivors in the
  // upstream's own order: a caller asked for sort=new and must not get score order.
  const cap = COMPACT_DEFAULTS.repliesPerComment;
  const replies = Array.from({ length: 12 }, (_, i) => comment(9100 + i, { depth: 1, score: i * 10 }));
  const expected = replies.slice().sort((a, b) => b.score - a.score).slice(0, cap)
    .map((c) => c.id).sort((a, b) => Number.parseInt(a.slice(1), 36) - Number.parseInt(b.slice(1), 36));
  const many = {
    post: post(1),
    comments: [(() => {
      const root = comment(9000, { score: 500 });
      root.replies = replies;
      return root;
    })()],
  };
  const shaped = shapeBody(many, COMPACT_DEFAULTS, "reddit_post_comments").value;
  assert.equal(shaped.comments[0].replies.length, cap, `12 replies shrink to the cap of ${cap}`);
  // The survivors are the highest-scored, and they come back in the order Reddit
  // returned them, not sorted by score.
  assert.deepEqual(shaped.comments[0].replies.map((r) => r.id), expected,
    `the highest-scored replies are kept, in the upstream's own order, got ${JSON.stringify(shaped.comments[0].replies.map((r) => r.id))}`);
  const lvl3 = { ...comment(4, { depth: 3, score: 6 }) };
  const lvl2 = { ...comment(3, { depth: 2, score: 7 }), replies: [lvl3] };
  const lvl1 = { ...comment(2, { depth: 1, score: 8 }), replies: [lvl2] };
  const deep = { comments: [{ ...comment(1, { score: 9 }), replies: [lvl1] }] };
  const deepCut = shapeBody(deep, COMPACT_DEFAULTS, "reddit_post_comments").value;
  assert.ok(deepCut.comments[0].replies[0], "replies up to the configured depth are kept");
  if (COMPACT_DEFAULTS.commentDepth >= 1) {
    assert.ok(deepCut.comments[0].replies[0], `depth ${COMPACT_DEFAULTS.commentDepth} keeps the first reply level`);
    assert.equal(deepCut.comments[0].replies[0].replies, undefined, `and one level past depth ${COMPACT_DEFAULTS.commentDepth} is cut`);
  }
  ok(`a 60-comment tree with chains returns the top ${COMPACT_DEFAULTS.commentsPerPost} by score, ${COMPACT_DEFAULTS.repliesPerComment} replies per comment, to depth ${COMPACT_DEFAULTS.commentDepth}`);
}

// 5 ───────────────────────────────────────────────────────────────────────────
{
  const j = JSON.parse(await s.text("reddit_subreddit_posts", { subreddit: "rust" }));
  const p = j.posts[0];
  for (const gone of ["media_metadata", "preview", "all_awardings", "author_flair_template_id", "link_flair_background_color", "crosspost_parent_list", "dismissable_vote_status", "can_gild", "thumbnail", "gildings", "suggested_sort", "user_reports", "mod_reports"]) {
    assert.ok(!(gone in p), `${gone} should be dropped from a post`);
  }
  const keptFields = ["id", "title", "author", "score", "num_comments", "permalink", "url", "subreddit", "created_utc", "is_self", "stickied", "upvote_ratio"];
  for (const kept of keptFields) {
    assert.ok(kept in p, `${kept} must survive: it is what a reader answers with`);
  }
  assert.equal(p.link_flair_text, "Performance", "the readable part of a dropped family survives");
  assert.match(p.selftext, /\[…\d+ chars\]$/, "a shortened body says how much was shortened");
  assert.ok(p.selftext.length <= COMPACT_DEFAULTS.bodyChars + 20, "and is bounded");
  ok("Reddit's browser fields are gone; the readable fields, the flair text and a labelled truncation stay");
}

// 6 ───────────────────────────────────────────────────────────────────────────
{
  // Fields of a size no drop list could have anticipated. The ceiling has to hold
  // on shapes this package has never seen: a giant string is truncated, and a
  // giant nested structure becomes a marker that names its own size.
  const shaped = shapeBody({ posts: [{ ...post(7, { gallery: true }), mystery_blob: "z".repeat(300000), mystery_tree: { deep: Array.from({ length: 60 }, (_, i) => ({ i, t: "q".repeat(200) })) } }] }, COMPACT_DEFAULTS, "reddit_search").value;
  const out = JSON.stringify(shaped);
  assert.ok(shaped.posts[0].mystery_blob.length < 600, `a 300 KB unknown string came back at ${shaped.posts[0].mystery_blob.length} characters`);
  assert.match(shaped.posts[0].mystery_blob, /\[…\d+ chars\]$/, "and says how much was cut");
  assert.match(out, /"deep":"\[trimmed \d+ bytes: deep\]"/, "an unknown oversized nested list becomes a marker that names its size");
  assert.ok(out.length < 3000, `the whole shaped page is ${out.length} bytes`);
  const longBody = shapeBody({ comments: [{ ...comment(1), body: "y".repeat(500000) }] }, { ...COMPACT_DEFAULTS, commentBodyChars: 50 }, "reddit_post_comments").value;
  assert.ok(longBody.comments[0].body.length < 120, "and a comment body respects its own ceiling");
  ok("unseen oversized fields cannot blow the budget: strings truncate, structures become size markers");
}

// 7 ───────────────────────────────────────────────────────────────────────────
{
  const rawSrv = await connect({ compact: { raw: true } });
  const rawText = await rawSrv.text("reddit_search", { q: "rust" });
  assert.equal(rawText, JSON.stringify(searchPage({ n: 25 })), "raw:true is the verbatim upstream body");
  assert.ok(!("context" in JSON.parse(rawText)), "and nothing is added to it");
  assert.equal(rawSrv.calls[0].includes("limit=10"), false, "raw:true also stops the defaulted limit from reaching the wire");
  const viaEnv = compactionFromEnv({ REDDITAPIS_MCP_RAW: "1" });
  assert.equal(viaEnv.raw, true, "REDDITAPIS_MCP_RAW=1 means raw");
  const envSettings = compactionFromEnv({ REDDITAPIS_MCP_MAX_BYTES: "4000", REDDITAPIS_MCP_DEFAULT_LIMIT: "0", REDDITAPIS_MCP_MAX_COMMENTS: "3", REDDITAPIS_MCP_DROP_FIELDS: "preview,link_flair_*", REDDITAPIS_MCP_KEEP_FIELDS: "link_flair_text" });
  assert.equal(envSettings.maxBytes, 4000);
  assert.equal(envSettings.defaultLimit, 0, "0 disables the injected default rather than sending 0");
  assert.deepEqual(envSettings.dropExtra, ["preview", "link_flair_*"]);
  const noDefault = await connect({ compact: { defaultLimit: 0 } });
  await noDefault.text("reddit_subreddit_posts", { subreddit: "rust" });
  assert.doesNotMatch(noDefault.calls.at(-1), /limit=/, "defaultLimit 0 leaves the endpoint's own default alone");
  ok("raw:true and REDDITAPIS_MCP_RAW=1 restore the pre-0.11.0 byte-identical passthrough; the knobs parse out of env");
}

// 8 ───────────────────────────────────────────────────────────────────────────
{
  const wh = JSON.parse(await s.text("reddit_monitor_webhook_create", { url: "https://hooks.slack.com/services/T/B/X", kind: "slack" }));
  assert.equal(wh.webhook.secret, "whsec_secret_shown_once", "a signing secret shown once must never be filtered away");
  const fb = JSON.parse(await s.text("reddit_feedback_list", {}));
  assert.equal(fb.feedback[0].details, LOREMSHORT, "the free /feedback mount is not a Reddit read and is not shaped");
  assert.ok(!("context" in fb), "and it carries no context block");
  const explain = await s.text("reddit_explain", {});
  assert.doesNotMatch(explain, /context.*budget_bytes/, "a local tool's own answer is untouched");
  ok("writes, the /feedback mount and local tools are untouched by the shaper");
}

// 9 ───────────────────────────────────────────────────────────────────────────
{
  const shortBody = "not json at all";
  const passthrough = await passThrough(shortBody);
  assert.equal(passthrough, shortBody, "a short non-JSON body is returned exactly as it arrived");
  const long = await passThrough("<html>".repeat(4000));
  assert.ok(long.length < COMPACT_DEFAULTS.maxBytes + 200, "a long non-JSON body is bounded");
  assert.match(long, /REDDITAPIS_MCP_MAX_BYTES/, "and says which ceiling cut it");
  ok("a body that is not JSON is still bounded, and says so");
}

async function passThrough(body) {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl });
  const conn = await connectWith(server, [], null);
  return conn.text("reddit_subreddit_posts", { subreddit: "rust" });
}

// 10 ──────────────────────────────────────────────────────────────────────────
{
  // Reddit's raw `{kind, data}` wrapper, in case the endpoint passes it through
  // instead of flattening. The shaper must not be guessing which.
  const shaped = shapeBody(wrappedSearchPage({ n: 3 }), COMPACT_DEFAULTS, "reddit_search").value;
  for (const p of shaped.posts) {
    assert.ok("title" in p && "score" in p, "a wrapped post is readable without digging through kind/data");
    assert.ok(!("data" in p), "and is unwrapped exactly once");
  }
  // A Listing wrapper around replies too.
  const listingForm = { comments: [{ ...comment(1, { score: 9 }), replies: { kind: "Listing", children: [comment(2, { depth: 1 }), comment(3, { depth: 1 })] } }] };
  const unwrapped = shapeBody(listingForm, { ...COMPACT_DEFAULTS, repliesPerComment: 5 }, "reddit_post_comments").value;
  assert.equal(unwrapped.comments[0].replies.length, 2, "a {kind:Listing, children} reply block is unwrapped to its comments");
  assert.ok(unwrapped.comments[0].replies.every((r) => "body" in r && "score" in r), "and each child is readable without digging through kind/children");
  ok("both Reddit envelope forms ({kind,data} and Listing/children) are handled");
}

// 11 ──────────────────────────────────────────────────────────────────────────
{
  const skip = await connect({ skipTools: ["reddit_monitor_*", "reddit_webhook_*", "reddit_feedback_*", "reddit_set_watch"] });
  const { tools } = await skip.client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(!names.some((x) => x.startsWith("reddit_monitor_")), `monitor tools still registered: ${names.filter((x) => x.startsWith("reddit_monitor_"))}`);
  assert.ok(names.includes("reddit_search") && names.includes("reddit_post_comments"), "the reads a research client needs stay");
  const full = await connect({});
  const fullNames = (await full.client.listTools()).tools.map((t) => t.name);
  assert.ok(names.length < fullNames.length, "skipping must actually shrink tools/list");
  const descBytes = (list) => list.reduce((a, t) => a + (t.description || "").length + JSON.stringify(t.inputSchema || {}).length, 0);
  console.log(`     tools/list text: ${fullNames.length} tools ${descBytes((await full.client.listTools()).tools)} bytes -> ${names.length} tools ${descBytes(tools)} bytes`);
  const before = skip.calls.length;
  const r = await skip.client.callTool({ name: "reddit_monitor_list", arguments: {} }).catch((e) => ({ thrown: e }));
  assert.ok(r.thrown || r.isError, "a skipped tool must not answer");
  assert.equal(skip.calls.length, before, "and a call to it must never reach the API");
  ok(`skipTools leaves ${names.length} of ${fullNames.length} registered and the excluded ones unreachable`);
}

// 12 ──────────────────────────────────────────────────────────────────────────
{
  const fetchImpl = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => JSON.stringify({ error: "not_found" }) });
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl });
  const conn = await connectWith(server, [], null);
  const t = await conn.text("reddit_post", { id: "gone" });
  assert.match(t, /HTTP 404/, "an upstream error keeps its hint text");
  assert.match(t, /not_found/, "and its body");
  assert.doesNotMatch(t, /budget_bytes/, "and is not wrapped in a context block");
  ok("an error result passes through untouched");
}

// 13 ──────────────────────────────────────────────────────────────────────────
{
  // A settings mistake must fail at boot, not become NaN on the wire.
  assert.throws(() => createServer({ apiKey: "k", compact: { maxBytes: "abc" } }), TypeError);
  const env = compactionFromEnv({ REDDITAPIS_MCP_MAX_BYTES: "not a number" });
  assert.equal(env.maxBytes, COMPACT_DEFAULTS.maxBytes, "an env value that is not a number falls back to the default");
  // The floor: a budget so small it cannot hold one row is raised rather than
  // turned into a response with nothing in it.
  const tiny = await connect({ compact: { maxBytes: 1 } });
  const t = JSON.parse(await tiny.text("reddit_search", { q: "rust" }));
  assert.ok(Array.isArray(t.posts) && t.posts.length >= 1, `a raised floor keeps at least one real row, got ${t.posts?.length}`);
  assert.ok(t.context.bytes >= 512, `the floor is ${COMPACT_DEFAULTS.maxBytes && 512} bytes, got ${t.context.bytes}`);
  assert.equal(t.context.over_budget, true, "and a response that still cannot fit says so instead of overflowing");
  ok("bad compaction settings throw at boot or fall back; the byte budget has a floor");
}

// 14 ──────────────────────────────────────────────────────────────────
{
  // An upstream field named `context` is never overwritten by this package's block.
  const colliding = shapeBody({ posts: [post(1)], context: { upstream: "the endpoint's own field" } }, COMPACT_DEFAULTS, "reddit_search").value;
  const srv = await connect({});
  const shaped = srv.compactor.compactResult(
    { name: "x", path: "/api/reddit/x", method: "GET", shape: { limit: {} } },
    { content: [{ type: "text", text: JSON.stringify({ posts: [post(1, { gallery: true })], context: { upstream: "the endpoint's own field" } }) }] },
    {},
  );
  const j = JSON.parse(shaped.content[0].text);
  assert.equal(j.context.upstream, "the endpoint's own field", "the upstream `context` survives intact");
  assert.ok(j._context && j._context.bytes > 0, "and this package's block lands under `_context`");
  assert.ok(colliding.context.upstream, "shapeBody leaves the field alone");
  ok("a `context` field that is already the endpoint's is kept, and the block moves to `_context`");
}

// 15 ──────────────────────────────────────────────────────────────────
{
  // The thread shape measured live through the Open WebUI gateway: ~60 comments,
  // each with replies, bodies 500-900 chars. This is the call that broke a 262K
  // context window. Two things are asserted: the size, and that the surviving
  // comments still carry readable bodies (a budget met by squeezing every comment
  // to a sentence is not a fix).
  const tree = liveThread(60);
  const raw = JSON.stringify(tree);
  const out = shapeBody(tree, COMPACT_DEFAULTS, "reddit_post_comments");
  const text = JSON.stringify(out.value);
  const kept = out.value.comments;
  const bodies = kept.flatMap((c) => [c, ...(c.replies || [])])
    .map((c) => (c.body || "").length).filter((n) => n > 0);
  assert.ok(kept.length === 10, `${kept.length} root comments kept`);
  const total = kept.reduce((a, c) => a + 1 + (c.replies || []).length, 0);
  assert.ok(total <= 20, `${total} comments in the kept forest (top 10 + one reply each)`);
  assert.ok(Buffer.byteLength(text) <= 16000, `${Buffer.byteLength(text)} bytes is inside the budget`);
  assert.ok(Math.min(...bodies) >= 350, `shortest kept comment body is ${Math.min(...bodies)} chars -- bodies stay readable`);
  assert.ok(raw.length / Buffer.byteLength(text) > 8, `${(raw.length / Buffer.byteLength(text)).toFixed(1)}x smaller than the live-shaped tree`);
  const c0 = kept[0];
  for (const junk of ["gilded", "archived", "downs", "author_fullname", "author_premium",
    "author_patreon_flair", "score_hidden", "controversiality", "subreddit_type", "created"])
    assert.ok(!(junk in c0), `the live junk field ${junk} is gone`);
  assert.ok("ups" in c0 && "score" in c0, "vote counts survive -- only the duplicate bookkeeping goes");
  assert.ok("score" in c0 && c0.score === 900, "sorted by score, so the best-argued comments are the ones kept");
  ok(`the live-shaped thread: ${raw.length} -> ${Buffer.byteLength(text)} bytes, ${total} comments kept at ${Math.min(...bodies)}+ chars each`);
  console.log(`     live shape: ${Object.keys(tree.comments[0]).length} keys in -> ${Object.keys(c0).length} keys out, trimmed=${JSON.stringify(out.counts)}`);
}

// 16 ──────────────────────────────────────────────────────────────────
{
  // A live-shaped listing: the wrapper's own field names, including `text` for the
  // body and `comments` as the comment COUNT (not an array). The count must not be
  // treated as a listing, and `text` must be shortened, not dropped.
  const listing = liveListing(10);
  const out = shapeBody(listing, COMPACT_DEFAULTS, "reddit_search");
  const p = out.value.posts[0];
  assert.ok(out.value.posts.length === 10, "all ten posts kept at the default limit");
  assert.ok(typeof p.comments === "number", "the comment COUNT survives as a number");
  assert.ok(p.text.length > 0 && p.text.length <= COMPACT_DEFAULTS.bodyChars + 20, `the body is shortened to ${p.text.length} chars, not dropped`);
  assert.ok(!("created" in p), "the duplicate `created` stamp is dropped in favour of created_utc");
  ok("a live-shaped listing keeps its ten posts, its comment counts, and a shortened body");
}

await s.client.close();
console.log(`\ncompact: ${n} passed, 0 failed`);
