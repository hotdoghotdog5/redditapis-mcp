// Unit tests for the tool catalog + query/path builders. No server or network:
// validates every tool is well-formed and that buildQuery/buildPath are correct,
// so the catalog can't regress without the test spawning stdio or hitting the API.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS, buildQuery, buildPath, buildBody, buildHeaders, SESSION_ARG_TO_HEADER } from "../src/tools.js";
import { INSTRUCTIONS as STEERING_INSTRUCTIONS } from "../src/server.js";

// The shipped README's tool table (`| `reddit_x` | METHOD /path | ... |`) is the
// published contract a customer integrates against -- it goes out in the npm
// tarball via package.json `files`. Parsed once here so the catalog can be
// checked against something real instead of a number typed into this file.
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const DOCUMENTED_TOOLS = [
  ...new Set([...README.matchAll(/^\| `(reddit_[a-z_]+)`/gm)].map((m) => m[1])),
];

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`PASS  ${name}`); };

// The path rule, as a function so the red test at the bottom can exercise the
// same code the catalog sweep runs rather than a restatement of it.
const FREE_UNPREFIXED_PATHS = new Set(["/feedback", "/account/me"]);
export function pathIsLegal(t) {
  if (t.path === null || t.path === undefined) return Boolean(t.local);
  return typeof t.path === "string" && (
    t.path.startsWith("/api/reddit/") || FREE_UNPREFIXED_PATHS.has(t.path) || t.path.startsWith("/feedback/")
  );
}

check("every tool has a unique name, path, description, and shape", () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.ok(t.name && /^reddit_[a-z_]+$/.test(t.name), `bad name: ${t.name}`);
    assert.ok(!names.has(t.name), `duplicate name: ${t.name}`);
    names.add(t.name);
    // THREE public mounts and no fourth: /api/reddit/* is the metered surface,
    // /feedback* is the free agent-feedback pair, and /account/me is the free
    // balance check. All three are served un-prefixed, mounted outside /api. A
    // path under anything else is a typo or an unpublished route, and fails
    // here before it can 404 live.
    //
    // /account/me WAS DELIBERATELY EXCLUDED and is now deliberately included.
    // The old comment named /account as an example of a mount we do not expose,
    // which was correct while no tool needed it. One does now: an agent
    // planning a costed run had no way to ask how much credit was left, so it
    // either ran blind into a 402 partway through or asked the user to go and
    // look.
    //
    // ADDED ON LIVE EVIDENCE, which is the bar this gate exists to enforce:
    //   /account/me            -> 401 unauthenticated (the route EXISTS)
    //   /account/<nonsense>    -> 404                 (so 401 is not generic)
    //   /api/<anything>        -> 401                 (which is why an /api
    //                                                  path could not prove it)
    // Listed as EXACT paths rather than an /account/ prefix, so /account/payments
    // and any future sibling still have to be added on purpose.
    //
    // A NULL PATH IS LEGAL FOR A LOCAL TOOL THAT REACHES NO ENDPOINT, and for
    // nothing else. reddit_explain reads an in-process ledger and makes no
    // request at all, so there is no endpoint to name and inventing one would
    // be a path that 404s the first time anyone trusts it. The narrowing is
    // tied to `local`: a tool with a null path must declare a local handler,
    // and the handler-name check below (plus createServer's boot-time refusal)
    // makes sure that handler exists. A NON-local tool with no path still
    // fails here, which the red test at the bottom of this file proves.
    assert.ok(
      pathIsLegal(t),
      `bad path: ${t.path}`,
    );
    assert.ok(typeof t.description === "string" && t.description.length > 40, `weak description: ${t.name}`);
    assert.ok(t.shape && typeof t.shape === "object", `missing shape: ${t.name}`);
  }
});

// Catalog size is a RATCHET, not a fixed number. `assert.equal(TOOLS.length, N)`
// fails the day someone legitimately ships tool N+1, so it gets bumped
// reflexively and stops meaning anything -- it had already drifted (asserted 32
// against a live 36) without anyone noticing, which is precisely the failure mode
// of an assertion nobody believes. The regression actually worth catching is the
// opposite direction: a tool silently DISAPPEARING from the catalog while every
// other test still passes, because each remaining tool is individually well-formed.
//
// Two checks cover that without punishing growth:
//   1. A floor. Adding a tool always passes. Removing one fails. Raise
//      CATALOG_FLOOR deliberately when you want to lock in new ground.
//   2. Parity against the shipped README's tool table: every tool documented
//      there must still exist by name, so a deletion fails and NAMES the tool
//      rather than reporting an off-by-one integer.
//
// Direction matters: this runs README -> catalog, never the reverse. The catalog
// deliberately carries tools the README table does not list (the cookie-
// authenticated user-history reads, which need a REST login step that is not
// itself an MCP tool), so requiring the reverse would fail on a documented-by-
// design omission. tools.js is the source of truth; the README is the published
// promise, and this asserts we have not broken a promise we already shipped.
//
// WHAT THIS STILL CANNOT SEE, stated plainly so nobody reads a green here as
// more than it is: removing an UNDOCUMENTED tool while adding any other tool in
// the same change keeps the length at or above the floor and leaves every
// README-documented name present, so both checks pass. The four cookie-
// authenticated user-history reads are the tools in that gap. Closing it needs a
// name-by-name manifest, which is the hand-maintained list this replaced, so the
// trade is deliberate rather than an oversight.
//
// IF YOU ADDED A TOOL: nothing here fails, and nothing needs editing. Bump
// CATALOG_FLOOR to the new total (42 as of 2026-09-06) only if you want the
// suite to guard the new tool's existence too, and add its README table row so
// the parity check covers it.
const CATALOG_FLOOR = 46;
// Parser-sanity floor for the README table, NOT a second contract about how many
// tools must be documented. It sits just under the 32 rows the table carries so
// a reformat that silently drops a handful of rows still trips it, rather than
// only a total collapse to zero. Deliberately un-documenting several tools at
// once should lower this in the same commit, exactly like CATALOG_FLOOR.
const README_ROW_FLOOR = 30;

check(`the catalog carries at least its ${CATALOG_FLOOR}-tool floor`, () => {
  assert.ok(
    TOOLS.length >= CATALOG_FLOOR,
    `catalog shrank to ${TOOLS.length} tools, below the ${CATALOG_FLOOR} floor -- a tool was removed. If that removal is intentional, lower CATALOG_FLOOR in the same commit and say why.`,
  );
});

check("every tool documented in the shipped README still exists in the catalog", () => {
  // Positive control FIRST: if the README's table format ever changes, the
  // regex above matches fewer rows (or none), the loop below iterates a short
  // list, and this check passes while seeing only part of the table. A parser
  // failure must look like a failure, not like a clean catalog.
  assert.ok(
    DOCUMENTED_TOOLS.length >= README_ROW_FLOOR,
    `parsed only ${DOCUMENTED_TOOLS.length} tool rows out of README.md, below the ${README_ROW_FLOOR} floor -- the parser broke, not the catalog`,
  );
  const names = new Set(TOOLS.map((t) => t.name));
  for (const n of DOCUMENTED_TOOLS) {
    assert.ok(names.has(n), `README.md documents ${n} but the catalog no longer exports it`);
  }
});

check("every path param {x} has a matching shape key", () => {
  for (const t of TOOLS) {
    // A local tool with no endpoint has no path params by construction.
    const params = [...String(t.path ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const p of params) assert.ok(p in t.shape, `${t.name}: path param {${p}} has no shape entry`);
  }
});

// This used to be "no tool is marked write/destructive" -- a hard invariant
// that the whole catalog was reads-only. Monitor/webhook management (2026-08-11,
// task #43) deliberately breaks that: those tools configure the caller's OWN
// redditapis.com account (an alerting subscription), never Reddit itself, so
// they are a different risk class from the comment/vote/DM writes this catalog
// still excludes. reddit_feedback_send (2026-09-04) joined them: it POSTs a
// report the USER reviewed to the team, never to Reddit. The invariant that
// survives: every GET tool is still a pure read, and every write is one of the
// named tools below -- so a future addition can't silently start mutating
// state without being caught here.
const WRITE_TOOL_NAMES = new Set([
  "reddit_monitor_add", "reddit_monitor_update", "reddit_monitor_remove",
  "reddit_monitor_webhook_create", "reddit_monitor_webhook_test", "reddit_monitor_webhook_delete",
  "reddit_feedback_send",
  // reddit_set_watch creates a monitor and may register a webhook. Same risk
  // class as the six above: it configures the caller's OWN redditapis.com
  // account and never posts, votes or messages on Reddit.
  "reddit_set_watch",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set(["reddit_monitor_remove", "reddit_monitor_webhook_delete"]);

// READS THAT USE POST. The verb is not the question, the EFFECT is: these send
// their input in a body because it does not fit in a URL (100 comment ids), and
// they change nothing on Reddit. The REST side already models this exactly the
// same way, with READ_TIER_POST_ALLOWLIST in scripts/reconcile-endpoints.mjs,
// so this list is the MCP mirror of that one and should move with it.
//
// Named individually rather than inferred from anything, because "POST but
// harmless" is precisely the claim a reviewer should be able to check by
// reading one line.
const READ_VIA_POST_TOOL_NAMES = new Set(["reddit_verify_comments"]);

check("only the 6 named monitor/webhook tools and reddit_feedback_send are writes; everything else is a pure read", () => {
  for (const t of TOOLS) {
    const method = t.method || "GET";
    if (WRITE_TOOL_NAMES.has(t.name)) {
      assert.equal(method, "POST", `${t.name}: a write tool must be POST`);
      assert.ok(t.write === true, `${t.name}: expected write: true`);
    } else if (READ_VIA_POST_TOOL_NAMES.has(t.name)) {
      // A read that posts. It must still NOT be marked write or destructive,
      // which is the property that matters to a client deciding whether to ask
      // the user first.
      assert.equal(method, "POST", `${t.name}: declared a read-via-POST but is not POST`);
      assert.ok(!t.write, `${t.name}: a read must never be marked write`);
      assert.ok(!t.destructive, `${t.name}: a read must never be marked destructive`);
    } else {
      assert.equal(method, "GET", `${t.name}: expected a plain read (GET)`);
      assert.ok(!t.write, `${t.name} unexpectedly marked write`);
    }
  }
  // Same anti-vacuity guard the write list gets: a rename must not leave this
  // exemption silently covering nothing.
  const allNames = new Set(TOOLS.map((t) => t.name));
  for (const n of READ_VIA_POST_TOOL_NAMES) {
    assert.ok(allNames.has(n), `read-via-POST tool ${n} not found in catalog`);
  }
  // Every name in the allowlist must actually exist in the catalog -- catches
  // a rename that would otherwise leave this check vacuously passing.
  const names = new Set(TOOLS.map((t) => t.name));
  for (const n of WRITE_TOOL_NAMES) assert.ok(names.has(n), `expected write tool ${n} not found in catalog`);
});

check("only remove/delete tools are destructive", () => {
  for (const t of TOOLS) {
    assert.equal(Boolean(t.destructive), DESTRUCTIVE_TOOL_NAMES.has(t.name), `${t.name}: destructive flag mismatch`);
  }
});

check("every write tool's filterSpecFields (if any) are all present in its own shape", () => {
  for (const t of TOOLS) {
    for (const f of t.filterSpecFields || []) {
      assert.ok(f in t.shape, `${t.name}: filterSpecFields names "${f}" but shape has no such key`);
    }
  }
});

// A local tool is dispatched inside this package (src/feedback.js) and its
// local-only args must never reach the API. Two things make that safe and both
// are pinned here: every `local` handler name is one src/server.js implements
// (createServer also refuses to build otherwise), and every `localArgs` entry is a
// real key of the tool's own shape (a misspelt entry would silently send the
// arg upstream).
const LOCAL_HANDLER_NAMES = new Set(["feedback", "set_watch", "explain"]);
check("local tools name an implemented handler and only local args that exist in their shape", () => {
  const locals = TOOLS.filter((t) => t.local);
  assert.ok(locals.length >= 3, `expected at least three local tools, found ${locals.length}`);
  for (const t of locals) {
    assert.ok(LOCAL_HANDLER_NAMES.has(t.local), `${t.name}: unknown local handler "${t.local}"`);
    for (const a of t.localArgs || []) assert.ok(a in t.shape, `${t.name}: localArgs names "${a}" but shape has no such key`);
  }
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.reddit_feedback_send.local, "feedback");
  assert.deepEqual(byName.reddit_feedback_send.localArgs, ["action", "ids"]);
  assert.equal(byName.reddit_feedback_get.local, undefined, "reddit_feedback_get is a plain read of /feedback/{id}");
  assert.equal(byName.reddit_feedback_get.method || "GET", "GET");
  // The composite watch tool: its three local-only args must never reach a
  // monitor request body, and its path is the call that makes the watch exist.
  assert.equal(byName.reddit_set_watch.local, "set_watch");
  assert.deepEqual(byName.reddit_set_watch.localArgs, ["watch", "deliver_to", "test_delivery"]);
  assert.equal(byName.reddit_set_watch.path, "/api/reddit/monitor/add");
  // The provenance tool reaches no endpoint at all.
  assert.equal(byName.reddit_explain.local, "explain");
  assert.equal(byName.reddit_explain.path, null);
  assert.equal(byName.reddit_explain.method || "GET", "GET");
  assert.ok(!byName.reddit_explain.write, "reddit_explain changes nothing and must not be marked write");
});

// RED TEST for the null-path narrowing above. The relaxation is only safe if it
// is bounded to local tools, so the bound is exercised here rather than
// asserted in a comment: a non-local tool with no path must still be refused,
// and a bad prefix must still be refused with or without a local handler.
check("a null path is legal ONLY for a local tool, and a bad prefix is refused either way", () => {
  assert.equal(pathIsLegal({ name: "x", path: null, local: "explain" }), true, "a local tool with no endpoint is legal");
  assert.equal(pathIsLegal({ name: "x", path: null }), false, "a NON-local tool with no path must be refused");
  assert.equal(pathIsLegal({ name: "x", path: undefined }), false, "an absent path on a non-local tool must be refused");
  assert.equal(pathIsLegal({ name: "x", path: "/api/twitter/posts" }), false, "a foreign prefix must be refused");
  assert.equal(pathIsLegal({ name: "x", path: "/api/twitter/posts", local: "explain" }), false, "a local handler must not launder a foreign prefix");
  assert.equal(pathIsLegal({ name: "x", path: "/account/payments" }), false, "a free-mount sibling must be added on purpose");
  assert.equal(pathIsLegal({ name: "x", path: "/api/reddit/monitor/add" }), true);
  assert.equal(pathIsLegal({ name: "x", path: "/account/me" }), true);
});

check("buildQuery skips empty/null/undefined and stringifies", () => {
  assert.equal(buildQuery({ a: 1, b: "x", c: undefined, d: null, e: "" }), "a=1&b=x");
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery(null), "");
  assert.equal(buildQuery({ q: "rust vs go" }), "q=rust+vs+go");
});

check("buildPath interpolates path params and removes them from the query rest", () => {
  const r = buildPath("/api/reddit/sub/{name}/top", { name: "science", t: "week", limit: 5 });
  assert.equal(r.path, "/api/reddit/sub/science/top");
  assert.deepEqual(r.rest, { t: "week", limit: 5 });
});

check("buildPath url-encodes path params and leaves non-templated paths untouched", () => {
  assert.equal(buildPath("/api/reddit/user/{name}", { name: "a b/c" }).path, "/api/reddit/user/a%20b%2Fc");
  const r = buildPath("/api/reddit/posts", { subreddit: "x", sort: "top" });
  assert.equal(r.path, "/api/reddit/posts");
  assert.deepEqual(r.rest, { subreddit: "x", sort: "top" });
});

check("a missing path param resolves to empty rather than throwing", () => {
  assert.equal(buildPath("/api/reddit/post/{id}", {}).path, "/api/reddit/post/");
});

check("buildBody nests filterSpecFields under filter_spec and leaves the rest top-level", () => {
  const tool = { filterSpecFields: ["subreddit", "q"] };
  const body = buildBody(tool, { subreddit: ["SaaS"], q: "launch", cadence_s: 300, baseline_item_id: undefined });
  assert.deepEqual(body, { cadence_s: 300, filter_spec: { subreddit: ["SaaS"], q: "launch" } });
});

check("buildBody omits filter_spec entirely when no filterSpecFields are present in args", () => {
  assert.deepEqual(buildBody({ filterSpecFields: ["subreddit", "q"] }, { id: "mon_1", active: false }), { id: "mon_1", active: false });
});

check("buildBody with no filterSpecFields declared sends everything top-level", () => {
  assert.deepEqual(buildBody({}, { id: "wh_1" }), { id: "wh_1" });
});

check("buildBody drops undefined but keeps false/0/empty-string args (real values, not omissions)", () => {
  assert.deepEqual(buildBody({}, { active: false, min_score: 0, group: "", skip: undefined }), { active: false, min_score: 0, group: "" });
});

check("search tools describe `t` as applying to 'relevance' (bug #11), listings keep the top/controversial caveat", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  // Reddit's SEARCH endpoint applies `t` to the whole result set, including the
  // 'relevance' and 'top' sorts, so the tool must NOT tell callers it is ignored,
  // and should steer them to bound a broad relevance query (else old viral posts win).
  for (const n of ["reddit_search", "reddit_search_comments", "reddit_search_media"]) {
    const d = byName[n].shape.t.description;
    assert.ok(typeof d === "string" && d.length > 0, `${n}: t has no description`);
    assert.doesNotMatch(d, /ignored for other sorts/i, `${n}: t must not claim it is ignored for relevance search`);
    assert.match(d, /relevance/i, `${n}: t description should say it applies to relevance`);
  }
  // A subreddit LISTING really does restrict `t` to top/controversial, so keep that.
  assert.match(
    byName["reddit_subreddit_posts"].shape.t.description,
    /top.*controversial/i,
    "reddit_subreddit_posts: listing t should keep the top/controversial caveat",
  );
});

check("reddit_search steers away from site-wide sort=top on generic queries (measured 2026-09-11)", () => {
  // Reddit orders top/new/comments by that one number over a LOOSELY matched set
  // (OCR, comments, and "reddit" is in nearly every big post), so a generic
  // multi-word query with sort=top and no subreddit returned the site-wide viral
  // listing while sort=relevance on the same query was on topic. The tool text
  // is the only place a caller learns this, so pin it.
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const t = byName["reddit_search"];
  // The steering clause in the PROSE, not the Example line: a mutation that kept
  // the example and deleted the guidance passed the first version of this test.
  //
  // 0.9.0 SPLIT IT IN TWO. The description states the FACT (which sort gives
  // best match then highest score, and that sort_type is page-local); the
  // STEERING ("fetch with ...") is model guidance, which the directory's
  // compliance rule keeps out of descriptions, so it lives in the server
  // instructions. Both halves are pinned, each where it now lives.
  assert.match(t.description, /Best match then highest score comes from sort='relevance' with a large `limit`, where sort_type='score' re-orders that returned page/, "description must carry the page-local relevance+sort_type=score fact");
  assert.match(STEERING_INSTRUCTIONS, /sort='relevance' with a large `limit` for best matches; sort_type='score' re-orders that page/, "server instructions must carry the relevance+sort_type=score steering");
  assert.match(t.shape.sort_type.description, /page-local/i, "sort_type must say it re-orders only the returned page");
  // The sort enum is SHARED by four search tools and only reddit_search accepts
  // sort_type, so the enum text must steer without naming a parameter three of
  // its consumers do not have, and must name the three score-only sorts rather
  // than sweeping `hot` in as "the others".
  const sortText = t.shape.sort.description;
  assert.match(sortText, /Only 'relevance' weights how well a post matches; 'top', 'new' and 'comments' rank/, "sort enum must say only relevance weights match quality and name the three sorts");
  assert.doesNotMatch(sortText, /sort_type/, "shared sort enum must not name sort_type, three consumers lack it");
  for (const n of ["reddit_search_comments", "reddit_deep_comment_search", "reddit_search_media"]) {
    assert.equal("sort_type" in byName[n].shape, false, `${n}: if this grows sort_type, revisit the shared enum text`);
  }
  // No search-family worked example models the anti-pattern, on any of the four.
  for (const n of ["reddit_search", "reddit_search_comments", "reddit_deep_comment_search", "reddit_search_media"]) {
    assert.doesNotMatch(byName[n].description, /Example:[^.]*sort='top'/, `${n}: the worked example must not model sort='top'`);
  }
});

check("every public read tool in the catalog has a README table row (catalog -> README, with the documented omissions named)", () => {
  // The README -> catalog check above cannot see a tool that ships UNDOCUMENTED.
  // reddit_user_achievements sat in the catalog on main from 2026-09-07 with no
  // README row and every test green, and README.md is in the npm files list, so
  // the next publish would have shipped a tool the shipped contract omitted.
  // This runs the reverse direction. The four cookie-authenticated user-history
  // reads are omitted from the table BY DESIGN (they need a REST login step that
  // is not itself an MCP tool), so they are named here rather than inferred;
  // documenting one later means removing it from this set in the same change.
  const DOCUMENTED_BY_DESIGN_OMISSIONS = new Set([
    "reddit_user_gilded",
    "reddit_user_hidden",
    "reddit_user_saved",
    "reddit_user_upvoted",
  ]);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const documented = new Set([...readme.matchAll(/^\|\s*`(reddit_[a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]));
  // Positive control on the parser: a README reformat that matches nothing must
  // read as a failure here, not as "every tool is undocumented".
  assert.ok(documented.size >= README_ROW_FLOOR, `README table parser saw ${documented.size} rows, below the ${README_ROW_FLOOR} floor`);
  const missing = TOOLS.map((t) => t.name).filter((n) => !documented.has(n) && !DOCUMENTED_BY_DESIGN_OMISSIONS.has(n));
  assert.deepStrictEqual(missing, [], `catalog tools with no README table row: ${missing.join(", ")} -- add the row, or name the omission in DOCUMENTED_BY_DESIGN_OMISSIONS with a reason`);
  for (const n of DOCUMENTED_BY_DESIGN_OMISSIONS) {
    assert.ok(!documented.has(n), `${n} is now documented in the README; remove it from DOCUMENTED_BY_DESIGN_OMISSIONS`);
  }
});

const { INSTRUCTIONS: SERVER_INSTRUCTIONS } = await import("../src/server.js");
check("the server instructions tell the model to run a rare-term control before drafting an 'ignored parameter' report", () => {
  // A generic query on a score-ordered sort returns the global listing, which
  // reads exactly like a dropped parameter and is not one. Report f2ad7c34 was
  // sent with that title on 2026-09-11 and needed a correction. The control
  // costs one call, so the instructions ask for it where the model reads them.
  // Checked on the exported value the server sends, not on a source file, so
  // moving the text between files cannot fool it.
  const src = SERVER_INSTRUCTIONS;
  assert.match(src, /re-run the call with a distinctive value that could only match if the parameter was honoured/, "instructions must ask for the distinctive-value control");
  assert.match(src, /title it that way and say what the control showed/, "instructions must say to retitle on the control's result");
});

console.log(`\n==== ${pass} tests passed ====`);

// ── buildHeaders ────────────────────────────────────────────────────────────
//
// NIT from the adversarial review: buildQuery, buildPath and buildBody were all
// covered and buildHeaders was not, so the claim that it is the IDENTITY for
// every pre-existing tool lived only in a comment. It is the load-bearing claim
// of the whole change: get it wrong and 38 shipped tools silently start sending
// a caller's session in a header, or stop sending an argument at all.

check("buildHeaders is the IDENTITY for a tool that does not declare sessionHeaders", () => {
  const args = { subreddit: "x", sort: "top", reddit_session: "S", loid: "L", proxy: "http://h:1" };
  const { headers, rest } = buildHeaders({ name: "reddit_subreddit_posts" }, args);
  assert.deepStrictEqual(headers, {}, "a non-declaring tool must lift NOTHING onto headers");
  assert.deepStrictEqual(rest, args, "and must pass every argument through untouched");
});

check("buildHeaders is the identity for undefined/null tools too", () => {
  for (const tool of [undefined, null, {}, { sessionHeaders: false }]) {
    const { headers, rest } = buildHeaders(tool, { a: 1, reddit_session: "S" });
    assert.deepStrictEqual(headers, {});
    assert.deepStrictEqual(rest, { a: 1, reddit_session: "S" });
  }
});

check("a declaring tool lifts every session arg onto its header and leaves the rest as query", () => {
  const { headers, rest } = buildHeaders(
    { sessionHeaders: true },
    {
      reddit_session: "S", loid: "L", token_v2: "T", csrf_token: "C",
      edgebucket: "E", csv: "V", session_tracker: "K", pc: "P",
      proxy: "http://h:1", sort: "best", limit: 25,
    }
  );
  assert.deepStrictEqual(headers, {
    "x-reddit-session": "S", "x-reddit-loid": "L", "x-reddit-token-v2": "T",
    "x-reddit-csrf-token": "C", "x-reddit-edgebucket": "E", "x-reddit-csv": "V",
    "x-reddit-session-tracker": "K", "x-reddit-pc": "P", "x-reddit-proxy": "http://h:1",
  });
  assert.deepStrictEqual(rest, { sort: "best", limit: 25 },
    "a lifted arg must NOT also remain in the query string");
});

check("a declared session arg that is empty is dropped, never sent as an empty header", () => {
  // An empty x-reddit-session reads as "authenticate me" and earns a 400
  // instead of the anonymous read the caller meant.
  const { headers, rest } = buildHeaders(
    { sessionHeaders: true },
    { reddit_session: "", loid: null, token_v2: undefined, proxy: "", sort: "new" }
  );
  assert.deepStrictEqual(headers, {});
  assert.deepStrictEqual(rest, { sort: "new" },
    "a declared-but-empty session arg belongs in neither the headers nor the query");
});

check("SESSION_ARG_TO_HEADER covers every session field the map claims", () => {
  // LITERAL, not derived from the thing under test.
  assert.deepStrictEqual(SESSION_ARG_TO_HEADER, {
    reddit_session: "x-reddit-session",
    loid: "x-reddit-loid",
    token_v2: "x-reddit-token-v2",
    csrf_token: "x-reddit-csrf-token",
    edgebucket: "x-reddit-edgebucket",
    csv: "x-reddit-csv",
    session_tracker: "x-reddit-session-tracker",
    pc: "x-reddit-pc",
    proxy: "x-reddit-proxy",
  });
});

check("NO shipped tool other than the declared one lifts headers", () => {
  // The identity claim across the whole catalog, asserted rather than commented.
  const declaring = TOOLS.filter((t) => t.sessionHeaders).map((t) => t.name);
  assert.deepStrictEqual(declaring, ["reddit_home_feed"],
    `unexpected tools declare sessionHeaders: ${JSON.stringify(declaring)}`);
  const sessionArgs = Object.fromEntries(Object.keys(SESSION_ARG_TO_HEADER).map((k) => [k, "v"]));
  for (const t of TOOLS) {
    if (t.sessionHeaders) continue;
    const { headers } = buildHeaders(t, sessionArgs);
    assert.deepStrictEqual(headers, {}, `${t.name} lifted headers it never declared`);
  }
});
