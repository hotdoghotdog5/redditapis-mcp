// watch.test.mjs: the reddit_set_watch compiler and orchestrator.
//
// Two halves, tested differently.
//
// THE COMPILER is pure, so every rule gets a case AND a negative twin: a rule
// that fires on everything is not a rule. The cases below are the sentences a
// person actually types, not a grammar.
//
// THE ORCHESTRATOR is tested through a FAKE callEndpoint that returns the
// shapes the real API returns, recorded from the live service 2026-10-02 (the
// `slots` object in particular, which carries capability booleans the older
// written spec did not mention). The assertions that matter are about ORDER and
// FAILURE: the monitor is created before the webhook, a local refusal makes no
// call at all, and a failed webhook leaves the monitor standing.
//
// Run alone: node test/watch.test.mjs
import assert from "node:assert/strict";
import { compileWatch, applyPlan, readSlots, createSetWatchHandler, parseResult, segment } from "../src/watch.js";
import { planStep, buildWatchSummary } from "../src/watch-text.js";

let n = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const check = (name, fn) => { fn(); n++; ok(name); };
const acheck = async (name, fn) => { await fn(); n++; ok(name); };

// ── compiler: subreddits ────────────────────────────────────────────────────

check("r/Name and /r/Name are both read, de-duplicated case-insensitively", () => {
  const { filter } = compileWatch('watch r/SaaS and /r/startups and r/saas for "pricing"');
  assert.deepEqual(filter.subreddit, ["SaaS", "startups"]);
});

check("r/all is dropped as Reddit's site-wide listing, with a note, not sent and not 400'd", () => {
  const { filter, notes } = compileWatch('watch r/all for "launch"');
  assert.equal(filter.subreddit, undefined);
  assert.equal(filter.q, "launch");
  assert.ok(notes.some((x) => /site-wide listing/.test(x)), notes.join(" | "));
});

check("NEGATIVE: a bare word that is not r/-prefixed is not a subreddit", () => {
  const { filter } = compileWatch('watch SaaS and startups for "pricing"');
  assert.equal(filter.subreddit, undefined);
});

check("NEGATIVE: an email or a path does not produce a subreddit", () => {
  assert.equal(compileWatch('for "x" see docs/r/readme').filter.subreddit, undefined);
});

// ── compiler: keywords ──────────────────────────────────────────────────────

check("one quoted phrase becomes q; two or more become an any-of set", () => {
  assert.equal(compileWatch('r/SaaS for "cold email"').filter.q, "cold email");
  const two = compileWatch('r/SaaS for "cold email" or "outbound"').filter;
  assert.equal(two.q, undefined);
  assert.deepEqual(two.include_any, ["cold email", "outbound"]);
});

check("curly quotes are read the same as straight ones", () => {
  assert.equal(compileWatch("r/SaaS for “pricing page”").filter.q, "pricing page");
});

check("NEGATIVE: a straight apostrophe is a contraction, not a quote", () => {
  const { filter } = compileWatch("r/SaaS for anything that doesn't work");
  assert.ok(!filter.q || !/^t work/.test(filter.q), `apostrophe swallowed the clause: ${filter.q}`);
});

check("an unquoted keyword comes from the clause after a lead word, stripped of scaffolding", () => {
  assert.equal(compileWatch("watch r/SaaS for churn posts").filter.q, "churn");
  assert.equal(compileWatch("monitor r/devops mentioning kubernetes").filter.q, "kubernetes");
  assert.equal(compileWatch("watch all of reddit talking about cold outreach").filter.q, "cold outreach");
});

check("the keyword clause stops at the next instruction rather than swallowing it", () => {
  const { filter } = compileWatch("watch r/SaaS for pricing except giveaways");
  assert.equal(filter.q, "pricing");
  assert.deepEqual(filter.exclude_terms, ["giveaways"]);
});

check("NEGATIVE: a sentence with no lead word and no quotes yields no keyword", () => {
  assert.equal(compileWatch("watch r/SaaS").filter.q, undefined);
});

// ── compiler: kind, exclusions, score ───────────────────────────────────────

check("kind: comments alone is comment, naming both is both, neither is posts", () => {
  assert.equal(compileWatch('r/SaaS comments for "pricing"').filter.kind, "comment");
  assert.equal(compileWatch('r/SaaS posts and comments for "pricing"').filter.kind, "both");
  assert.equal(compileWatch('r/SaaS for "pricing"').filter.kind, undefined);
});

check("exclusions split on commas, 'and' and 'or', and cap at 50", () => {
  const { filter } = compileWatch('r/SaaS for "pricing" excluding giveaway, promo and spam');
  assert.deepEqual(filter.exclude_terms, ["giveaway", "promo", "spam"]);
});

// REGRESSION, caught by an end-to-end stdio smoke and not by any unit case
// written before it: the exclusion clause ran past the score clause and
// excluded the literal string "giveaway with at least 5 upvotes". A filter that
// excludes a phrase nothing says is worse than one that fails, because it looks
// like it worked. Both clauses now share one stop list.
check("an exclusion clause stops where the next clause starts, in either order", () => {
  const a = compileWatch('watch r/SaaS comments for "pricing page" except giveaway with at least 5 upvotes').filter;
  assert.deepEqual(a.exclude_terms, ["giveaway"]);
  assert.equal(a.min_score, 5);
  assert.equal(a.q, "pricing page");
  const b = compileWatch('r/SaaS for "pricing" excluding promo and deliver to slack').filter;
  assert.deepEqual(b.exclude_terms, ["promo"]);
  const c = compileWatch('r/SaaS for "pricing" ignoring spam, score above 20').filter;
  assert.deepEqual(c.exclude_terms, ["spam"]);
  assert.equal(c.min_score, 20);
});

check("a score floor is read from either phrasing", () => {
  assert.equal(compileWatch('r/SaaS for "pricing" with at least 25 upvotes').filter.min_score, 25);
  assert.equal(compileWatch('r/SaaS for "pricing" score of at least 10').filter.min_score, 10);
});

check("NEGATIVE: a bare number is not a score floor", () => {
  assert.equal(compileWatch('r/SaaS for "top 10 tools"').filter.min_score, undefined);
});

// ── compiler: the anchor rule ───────────────────────────────────────────────

check("a description anchored by neither a subreddit nor a keyword is refused", () => {
  // The REFUSAL is the contract; which of the two refusal codes applies depends
  // on whether every word could be placed, and both carry an empty filter.
  for (const s of ["just watch everything", "watch everything"]) {
    const r = compileWatch(s);
    assert.ok(["no_anchor", "partial_understanding"].includes(r.error), `${s}: got ${r.error}`);
    assert.deepEqual(r.filter, {}, `${s}: a refusal must carry no filter`);
  }
  assert.equal(compileWatch("").error, "empty_description");
  assert.equal(compileWatch(null).error, "empty_description");
  // and the twins that ARE anchored
  assert.equal(compileWatch("watch r/SaaS").error, null);
  assert.equal(compileWatch('watch for "pricing"').error, null);
});

// ── REVIEW 2026-10-02: the clause-contamination class ───────────────────────
//
// Four HIGH defects, one cause. Every field matched its own regular expression
// over the WHOLE sentence, so two clauses read the same words and one was
// wrong. Three green suites passed over four live defects, because each earlier
// patch taught the tests the shape that had just been fixed and nothing about
// the class.
//
// Each case below is the reviewer's own failing sentence, verbatim, and each
// asserts the SPECIFIC wrong value the old compiler produced, so the test is
// red on the pre-fix head rather than merely green on the new one.

check("RED 1.1: a quoted EXCLUSION never becomes the keyword", () => {
  // Was: {"q":"giveaway","exclude_terms":["giveaway"]}. q === exclude_terms[0]
  // means the monitor can never deliver, while the caller is handed a monitor
  // id, a green test delivery, and then silence forever.
  const a = compileWatch('watch r/SaaS for pricing except "giveaway"').filter;
  assert.equal(a.q, "pricing", "the keyword must come from the keyword clause");
  assert.deepEqual(a.exclude_terms, ["giveaway"]);
  assert.notEqual(a.q, a.exclude_terms[0], "a filter whose keyword IS its exclusion can never match anything");

  const b = compileWatch('watch r/SaaS for churn without "spam"').filter;
  assert.equal(b.q, "churn");
  assert.deepEqual(b.exclude_terms, ["spam"]);
  assert.notEqual(b.q, b.exclude_terms[0]);

  // The invariant behind both, over every exclusion shape.
  for (const sentence of [
    'r/SaaS for pricing ignoring "promo"',
    'r/SaaS for pricing but not "giveaway"',
    'r/SaaS for pricing excluding "spam"',
  ]) {
    const f = compileWatch(sentence).filter;
    for (const t of f.exclude_terms || []) {
      assert.notEqual(f.q, t, `${sentence}: the excluded term became the keyword`);
    }
  }
});

check("RED 1.2: 'for posts about X' watches for X, not for the scaffolding", () => {
  // Was: q = "posts about pricing", which matches essentially nothing. This is
  // the most natural sentence a person types, and the refusal message for an
  // unanchored description advertises this exact form.
  assert.equal(compileWatch("watch r/SaaS for posts about pricing").filter.q, "pricing");
  assert.equal(compileWatch("watch r/SaaS for anything mentioning kubernetes").filter.q, "kubernetes");
  assert.equal(compileWatch("watch r/SaaS for comments discussing churn").filter.q, "churn");
  assert.equal(compileWatch("r/SaaS for people talking about onboarding").filter.q, "onboarding");
  // NEGATIVE TWIN: a real keyword that merely CONTAINS a lead word is not cut
  // at it, because the scaffolding strip fires only after a scaffolding noun.
  assert.equal(compileWatch("watch r/SaaS for a tool for teams").filter.q, "tool for teams");
  assert.equal(compileWatch('r/SaaS for "top 10 tools"').filter.q, "top 10 tools");
});

check("RED 1.3: a keyword written AFTER a score phrase is not discarded", () => {
  // Was: {"subreddit":["SaaS"],"min_score":5} with no keyword at all, so the
  // monitor became a firehose of every post over the score floor.
  const f = compileWatch("watch r/SaaS for posts with at least 5 upvotes about pricing").filter;
  assert.equal(f.q, "pricing", "the keyword after the score clause was dropped");
  assert.equal(f.min_score, 5);
  // A score clause consumes only its own words, so what follows is a fresh span.
  assert.deepEqual(
    segment("watch for posts with at least 5 upvotes about pricing").map((x) => x.kind),
    ["keyword", "score", "keyword"],
  );
});

check("RED 1.4: the match kind is never read out of the keyword", () => {
  // Was: kind "comment" for 'for "comment moderation"', silently switching the
  // watch to comments only and missing every post.
  assert.equal(compileWatch('watch r/SaaS for "comment moderation"').filter.kind, undefined);
  assert.equal(compileWatch("watch r/SaaS for comment moderation").filter.kind, undefined);
  assert.equal(compileWatch('watch r/SaaS for "post scheduling"').filter.kind, undefined);
  assert.equal(compileWatch('r/SaaS for "pricing" excluding "comment spam"').filter.kind, undefined);
  // POSITIVE TWINS: the kind still comes from words the sentence spends on it.
  assert.equal(compileWatch('r/SaaS comments for "pricing"').filter.kind, "comment");
  assert.equal(compileWatch('r/SaaS posts and comments for "pricing"').filter.kind, "both");
});

check("RED 1.6: a pasted reddit.com/r/X link is the subreddit, not a site-wide watch", () => {
  // Was: {"q":"pricing"} with no subreddit and an empty notes array, so the
  // watch went site-wide and consumed the account's one free site-wide slot.
  for (const url of [
    'watch https://reddit.com/r/SaaS for "pricing"',
    'watch https://www.reddit.com/r/SaaS/ for "pricing"',
    'watch old.reddit.com/r/SaaS for "pricing"',
    'watch reddit.com/r/SaaS for "pricing"',
  ]) {
    const f = compileWatch(url).filter;
    assert.deepEqual(f.subreddit, ["SaaS"], `${url}: the link's subreddit was lost`);
    assert.equal(f.q, "pricing", `${url}: the link text leaked into the keyword`);
  }
  // NEGATIVE TWIN: an ordinary path is still not a subreddit.
  assert.equal(compileWatch('for "x" see docs/r/readme').filter.subreddit, undefined);
});

check("a lossy compile is never silent: a dropped second keyword is named", () => {
  const r = compileWatch("watch r/SaaS for pricing with at least 5 upvotes about churn");
  assert.equal(r.filter.q, "pricing");
  assert.ok(r.notes.length >= 1, "dropping a phrase the description carries must be reported");
  assert.match(r.notes.join(" "), /"churn" was not/);
  // NEGATIVE TWIN: a compile that drops nothing says nothing.
  assert.deepEqual(compileWatch('r/SaaS for "pricing"').notes, []);
});

check("segment cuts a sentence once, and each field then reads its own span", () => {
  // Each clause carries its own marker, so the cut is readable on its own: the
  // first question when a field comes out wrong is whether the CUT or the field
  // rule was at fault, and that is only answerable if the cut is inspectable.
  assert.deepEqual(
    segment('for pricing except "giveaway" and deliver to slack').map((x) => [x.kind, x.text]),
    [["keyword", "for pricing"], ["exclude", 'except "giveaway"'], ["deliver", "and deliver to slack"]],
  );
  assert.deepEqual(segment("for pricing").map((x) => x.kind), ["keyword"]);
  assert.deepEqual(segment("").map((x) => x.kind), []);
  // An exclusion written FIRST stops where the main clause starts again, which
  // is what keeps "except spam watch r/SaaS for pricing" from eating all of it.
  assert.deepEqual(
    segment("except spam watch for pricing").map((x) => x.kind),
    ["exclude", "keyword"],
  );
});

// ── plan preflight ──────────────────────────────────────────────────────────

const PAID_SLOTS = {
  used: 3, total: 50, tier: "growth", is_free: false, cadence_s: 30, sitewide_slots: 3,
  distinct_subreddits_used: 0, distinct_subreddits_total: 25,
  comments_allowed: true, scoped_allowed: true, sitewide_allowed: true,
};
const FREE_SLOTS = {
  used: 0, total: 1, tier: "free", is_free: true, cadence_s: 60, sitewide_slots: 1,
  distinct_subreddits_used: 0, distinct_subreddits_total: 0,
  comments_allowed: false, scoped_allowed: false, sitewide_allowed: true,
};

check("readSlots returns the object, or null when the shape is not what we expect", () => {
  assert.deepEqual(readSlots({ slots: PAID_SLOTS }), PAID_SLOTS);
  assert.equal(readSlots({}), null);
  assert.equal(readSlots(null), null);
  assert.equal(readSlots({ slots: "growth" }), null);
});

check("a plan with no scoped watches widens a keyword watch instead of 402-ing, and says so", () => {
  const notes = [];
  const out = applyPlan({ subreddit: ["SaaS"], q: "pricing" }, FREE_SLOTS, notes);
  assert.equal(out.subreddit, undefined);
  assert.equal(out.q, "pricing");
  assert.ok(notes.some((x) => /no subreddit-scoped watches/.test(x)));
});

check("with no keyword there is no equivalent, so the filter is left exactly as compiled", () => {
  const notes = [];
  const out = applyPlan({ subreddit: ["SaaS"] }, FREE_SLOTS, notes);
  assert.deepEqual(out.subreddit, ["SaaS"], "the request must go as written for the API to answer");
  assert.ok(notes.some((x) => /no keyword to widen it with/.test(x)));
});

check("NEGATIVE: a plan that allows scoped watches rewrites nothing", () => {
  const notes = [];
  const out = applyPlan({ subreddit: ["SaaS"], q: "pricing" }, PAID_SLOTS, notes);
  assert.deepEqual(out, { subreddit: ["SaaS"], q: "pricing" });
  assert.deepEqual(notes, []);
});

check("NEGATIVE: an unreadable slots object rewrites nothing (the API is the authority)", () => {
  const notes = [];
  assert.deepEqual(applyPlan({ subreddit: ["SaaS"], q: "p" }, null, notes), { subreddit: ["SaaS"], q: "p" });
  assert.deepEqual(notes, []);
});

// ── orchestrator ────────────────────────────────────────────────────────────

function fakeApi({ slots = PAID_SLOTS, fail = {} } = {}) {
  const calls = [];
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const err = (t) => ({ isError: true, content: [{ type: "text", text: t }] });
  return {
    calls,
    callEndpoint: async (path, args, method = "GET") => {
      calls.push({ path, args, method });
      if (fail[path]) return err(fail[path]);
      if (path === "/api/reddit/monitor/list") return json({ monitors: [], slots });
      if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1", filter_spec: args.filter_spec } });
      if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { id: "wh_1", kind: "slack", secret: "s3cr3t" } });
      if (path === "/api/reddit/monitor/update") return json({ monitor: { id: "mon_1", webhook_ids: args.webhook_ids } });
      if (path === "/api/reddit/monitor/webhook/test") return json({ ok: true });
      return err(`unexpected path ${path}`);
    },
  };
}

await acheck("a refused description makes ZERO network calls", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: "just watch everything" });
  assert.equal(r.isError, true);
  assert.equal(api.calls.length, 0, `expected no calls, made ${JSON.stringify(api.calls)}`);
  assert.match(r.content[0].text, /anchored by one or the other/);
});

await acheck("the happy path: list, add, webhook create, update, test, in that order", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'watch r/SaaS for "pricing page"', deliver_to: "https://hooks.slack.com/services/T/B/x" });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(api.calls.map((c) => c.path), [
    "/api/reddit/monitor/list",
    "/api/reddit/monitor/add",
    "/api/reddit/monitor/webhook/create",
    "/api/reddit/monitor/update",
    "/api/reddit/monitor/webhook/test",
  ]);
  const sc = r.structuredContent;
  assert.equal(sc.status, "watching");
  assert.equal(sc.monitor.id, "mon_1");
  assert.equal(sc.delivery.registered, true);
  assert.equal(sc.delivery.webhook_id, "wh_1");
  assert.equal(sc.delivery.targeted, true);
  assert.equal(sc.delivery.test.ok, true);
  assert.deepEqual(sc.compiled_filter, { subreddit: ["SaaS"], q: "pricing page" });
});

await acheck("the filter nests under filter_spec exactly as the monitor endpoint takes it", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  await h({ watch: 'watch r/SaaS comments for "pricing" excluding spam', cadence_s: 120 });
  const add = api.calls.find((c) => c.path === "/api/reddit/monitor/add");
  // callEndpoint receives the flat args; buildBody does the nesting, and the
  // catalog test pins which fields nest. What matters here is that cadence_s is
  // present and that no local-only arg was handed over.
  assert.equal(add.args.cadence_s, 120);
  assert.equal(add.args.watch, undefined, "the raw description must never be sent");
  assert.equal(add.args.deliver_to, undefined);
  assert.equal(add.args.test_delivery, undefined);
  assert.deepEqual(add.args.subreddit, ["SaaS"]);
  assert.equal(add.args.kind, "comment");
});

await acheck("a failed monitor create registers NO webhook and relays the API's own answer", async () => {
  const api = fakeApi({ fail: { "/api/reddit/monitor/add": "HTTP 402: {\"error\":\"monitor_slots_exhausted\"}" } });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/hook" });
  assert.equal(r.isError, true);
  assert.ok(!api.calls.some((c) => c.path.includes("webhook")), "a webhook must not be left pointing at nothing");
  assert.match(r.content[0].text, /monitor_slots_exhausted/);
  assert.equal(r.structuredContent.status, "not_created");
});

await acheck("a failed webhook leaves the monitor standing, and says where matches go instead", async () => {
  const api = fakeApi({ fail: { "/api/reddit/monitor/webhook/create": "HTTP 400: bad url" } });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/hook" });
  assert.ok(!r.isError, "the watch exists, so this is not an error result");
  assert.equal(r.structuredContent.status, "watching");
  assert.equal(r.structuredContent.delivery.registered, false);
  assert.match(r.content[0].text, /every active webhook already on the account/);
});

await acheck("a webhook response is read whether the body wraps it or not", async () => {
  // MEASURED 2026-10-02: monitor/add returns {"monitor": {...}} (confirmed live
  // on a growth account, with the control pair in the feedback report of the
  // same date). The webhook CREATE body was not confirmed live, because
  // confirming it means creating a real signing secret on a real account, so
  // both shapes are handled in code and both are pinned here rather than one
  // being guessed at. If the shape is ever confirmed, the other case stays as a
  // cheap guard, it does not become dead.
  for (const body of [{ webhook: { id: "wh_1", kind: "slack" } }, { id: "wh_1", kind: "slack" }]) {
    const calls = [];
    const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
    const callEndpoint = async (path, args, method = "GET") => {
      calls.push(path);
      if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
      if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1" } });
      if (path === "/api/reddit/monitor/webhook/create") return json(body);
      return json({ ok: true });
    };
    const r = await createSetWatchHandler({ callEndpoint })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" });
    assert.equal(r.structuredContent.delivery.webhook_id, "wh_1", `shape not read: ${JSON.stringify(body)}`);
    assert.equal(r.structuredContent.delivery.kind, "slack");
    assert.ok(calls.includes("/api/reddit/monitor/webhook/test"));
  }
});

await acheck("a monitor body returned FLAT (no wrapper) still yields its id", async () => {
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const callEndpoint = async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ id: "mon_flat", filter_spec: {} });
    return json({ ok: true });
  };
  const r = await createSetWatchHandler({ callEndpoint })({ watch: 'r/SaaS for "x"' });
  assert.equal(r.structuredContent.monitor.id, "mon_flat");
  assert.match(r.content[0].text, /Monitor id mon_flat/);
});

await acheck("test_delivery false skips the test and nothing else", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  await h({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/hook", test_delivery: false });
  assert.ok(!api.calls.some((c) => c.path.endsWith("/webhook/test")));
  assert.ok(api.calls.some((c) => c.path.endsWith("/webhook/create")));
});

await acheck("on a free plan a scoped description is widened before the monitor is created", async () => {
  const api = fakeApi({ slots: FREE_SLOTS });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'watch r/SaaS for "pricing"' });
  const add = api.calls.find((c) => c.path === "/api/reddit/monitor/add");
  assert.equal(add.args.subreddit, undefined, "the scoped request must not be sent on a plan that refuses it");
  assert.equal(add.args.q, "pricing");
  assert.ok(r.content[0].text.includes("no subreddit-scoped watches"));
});

await acheck("a failed plan preflight is not fatal: the request goes as compiled", async () => {
  const api = fakeApi({ fail: { "/api/reddit/monitor/list": "HTTP 500" } });
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: 'watch r/SaaS for "pricing"' });
  assert.ok(!r.isError, r.content[0].text);
  const add = api.calls.find((c) => c.path === "/api/reddit/monitor/add");
  assert.deepEqual(add.args.subreddit, ["SaaS"]);
  assert.equal(r.structuredContent.plan, null);
});

// ── REVIEW 2026-10-02: the handler's "unknown reported as fine" class ───────

await acheck("RED 3.1: the signing secret is IN the result, because the result says it is", async () => {
  // Was: the secret was read only to set a boolean and then dropped, while the
  // summary asserted "Its signing secret is in this result and is not returned
  // again". The API returns it once and the webhook list never returns it
  // again, so a watch set up this way left its owner permanently unable to
  // verify a delivery signature, and told them otherwise.
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const callEndpoint = async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1" } });
    if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { id: "wh_1", kind: "slack", secret: "whsec_live_value" } });
    return json({ ok: true });
  };
  const r = await createSetWatchHandler({ callEndpoint })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" });
  assert.equal(r.structuredContent.delivery.secret, "whsec_live_value", "the secret the API returned once must be in the result");
  assert.match(r.content[0].text, /signing secret is in this result/);

  // NEGATIVE TWIN: no secret returned means the sentence is not said at all.
  const noSecret = async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1" } });
    if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { id: "wh_1", kind: "slack" } });
    return json({ ok: true });
  };
  const r2 = await createSetWatchHandler({ callEndpoint: noSecret })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" });
  assert.equal(r2.structuredContent.delivery.secret, null);
  assert.doesNotMatch(r2.content[0].text, /signing secret/, "a secret that was never returned must not be claimed");
});

await acheck("RED 3.2: a test delivery whose answer cannot be read is UNKNOWN, not a success", async () => {
  // Was: `ok: body?.ok !== false`, so a missing or unparseable body read as a
  // SUCCESSFUL test delivery. This product's own instructions tell a caller
  // that unknown, partial or null is unanswered rather than healthy.
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const base = (testBody) => async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1" } });
    if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { id: "wh_1", kind: "slack" } });
    if (path === "/api/reddit/monitor/webhook/test") return testBody;
    return json({ ok: true });
  };
  const run = async (testBody) =>
    (await createSetWatchHandler({ callEndpoint: base(testBody) })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" }));

  // Three shapes that are NOT a stated success.
  for (const body of [json({}), json({ reason: "queued" }), { content: [{ type: "text", text: "<html>502</html>" }] }]) {
    const r = await run(body);
    assert.equal(r.structuredContent.delivery.test.ok, null, `a body without ok:true must not read as a success: ${JSON.stringify(body)}`);
    assert.match(r.content[0].text, /did not say whether it landed/);
    assert.doesNotMatch(r.content[0].text, /A test delivery reached the target/);
  }
  // POSITIVE AND NEGATIVE TWINS: a stated answer is still reported as stated.
  assert.equal((await run(json({ ok: true }))).structuredContent.delivery.test.ok, true);
  assert.match((await run(json({ ok: true }))).content[0].text, /A test delivery reached the target/);
  const failed = await run(json({ ok: false, hint: "the kind does not match the host" }));
  assert.equal(failed.structuredContent.delivery.test.ok, false);
  assert.match(failed.content[0].text, /did not land: the kind does not match the host/);
});

await acheck("RED 3.3: a skipped re-point is reported, never left to read as a completed one", async () => {
  // Was: when the monitor came back without an id the re-point was skipped with
  // NO note, while the summary still said the target was registered, so the
  // caller believed matches were routed to it.
  const json = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
  const callEndpoint = async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ monitor: { filter_spec: {} } }); // no id
    if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { id: "wh_1", kind: "slack" } });
    return json({ ok: true });
  };
  const r = await createSetWatchHandler({ callEndpoint })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" });
  assert.equal(r.structuredContent.delivery.targeted, false);
  assert.ok(
    r.structuredContent.notes.some((x) => /could not be pointed at the new delivery target/.test(x)),
    `a skipped re-point must be named; notes were ${JSON.stringify(r.structuredContent.notes)}`,
  );
  assert.match(r.content[0].text, /could not be pointed at/);

  // And the sibling: a webhook that comes back with no id at all.
  const noId = async (path) => {
    if (path === "/api/reddit/monitor/list") return json({ slots: PAID_SLOTS });
    if (path === "/api/reddit/monitor/add") return json({ monitor: { id: "mon_1" } });
    if (path === "/api/reddit/monitor/webhook/create") return json({ webhook: { kind: "slack" } });
    return json({ ok: true });
  };
  const r2 = await createSetWatchHandler({ callEndpoint: noId })({ watch: 'r/SaaS for "x"', deliver_to: "https://example.com/h" });
  assert.ok(r2.structuredContent.notes.some((x) => /without an id/.test(x)), "a target with no id must be named");
});

await acheck("the compiler's own notes reach the caller's result, not just the compile step", async () => {
  const api = fakeApi();
  const h = createSetWatchHandler({ callEndpoint: api.callEndpoint });
  const r = await h({ watch: "watch r/SaaS for pricing with at least 5 upvotes about churn" });
  assert.match(r.content[0].text, /"churn" was not/);
  assert.ok(r.structuredContent.notes.some((x) => /churn/.test(x)));
});

// ── the result text ─────────────────────────────────────────────────────────

check("the result offers Slack as the next call and states the plan step from the slots object", () => {
  const text = buildWatchSummary({
    understood: { subreddits: ["SaaS"], keyword: "pricing", any_of: null, excluded_terms: null, match_kind: "post", min_score: null },
    monitor: { id: "mon_1" },
    delivery: null,
    notes: [],
    plan: PAID_SLOTS,
  });
  assert.match(text, /Slack/);
  assert.match(text, /deliver_to/);
  assert.match(text, /3 of 50 monitor slots/);
  assert.match(text, /30s cadence floor/);
});

check("the plan step names what the plan does NOT carry, and says nothing when it carries everything", () => {
  assert.match(planStep(FREE_SLOTS), /Not on this plan yet: watches limited to named subreddits, comment matching/);
  assert.doesNotMatch(planStep(PAID_SLOTS), /Not on this plan yet/);
  assert.equal(planStep(null), null, "no slots object means no claim about the plan");
  assert.equal(planStep({}), null);
});

check("parseResult returns null on a non-JSON body rather than throwing", () => {
  assert.equal(parseResult({ content: [{ type: "text", text: "<html>502</html>" }] }), null);
  assert.equal(parseResult(undefined), null);
  assert.deepEqual(parseResult({ content: [{ type: "text", text: '{"a":1}' }] }), { a: 1 });
});

console.log(`\nwatch: ${n} passed, 0 failed`);
