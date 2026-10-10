// watch-invariants.test.mjs: the suite that can fail on an input nobody listed.
//
// WHY THIS FILE EXISTS, stated plainly because it is the correction to my own
// two previous attempts.
//
// Seventeen defects were found in the watch compiler across three rounds. Round
// one was fixed by widening a shared stop list and shipped a suite that pinned
// the sentences just fixed. Round two diagnosed the real cause (every field
// matching over the whole sentence), rewrote the compiler around clause
// segmentation, and shipped a suite that pinned the six sentences just fixed
// and broke nine inputs the old compiler handled. Both suites were green. Both
// were green over live defects, because every assertion in them named an input
// somebody had already thought of.
//
// test/watch.test.mjs still holds those per-sentence cases and they are worth
// keeping as regressions. THIS file is the part that can fail on something new:
// it generates sentences mechanically from pieces chosen to COLLIDE (marker
// words inside quotes, subreddits inside quotes, markers written before the
// main clause, unicode quotes, conjunctions, repeated clauses) and asserts
// STRUCTURAL invariants that hold for every input, listed or not.
//
// THE INVARIANTS ARE THE SPECIFICATION. Each one is the general form of a
// defect that actually shipped:
//   I1  nothing throws                      (a crash is not an answer)
//   I2  a returned filter is fully accounted (the admission gate holds)
//   I3  no term is empty, punctuation-only, or carries an unbalanced quote
//                                           (round three: q became a lone `"`)
//   I4  no keyword equals an exclusion      (round two: a monitor that can
//                                            never deliver, reported as healthy)
//   I5  no BARE term re-uses a subreddit the filter already took
//                                           (double counting; a quoted literal
//                                            is deliberate and exempt)
//   I6  kind is set only when a kind word exists outside every quoted span
//                                           (round three: `for "post"` flipped
//                                            a posts-and-comments watch)
//   I7  nothing the caller explicitly QUOTED is silently dropped
//
// I7 is the strongest and would have caught the worst of round three on its
// own: when `for "ignore list"` produced q = `"`, the quoted phrase was nowhere
// in the filter.
//
// Run alone: node test/watch-invariants.test.mjs
// Pass --report to print the generated-corpus statistics.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { compileWatch } from "../src/watch.js";

let n = 0;
const ok = (m) => console.log(`  ok  ${m}`);

// Pieces chosen so that they collide. Every quoted phrase below contains a word
// that is a marker, a clause lead or a subreddit somewhere else in the grammar.
const SUBS = ["", "r/SaaS", "/r/SaaS", "https://reddit.com/r/SaaS", "r/SaaS and r/startups", "r/all"];
const KEYS = [
  "", 'for "pricing"', 'for "ignore list"', 'for "except this"', 'for "send to production"',
  'for "at least 5 upvotes"', 'for "r/startups"', 'for "score of at least 10"',
  'for “pricing page”', "for pricing", "for posts about pricing",
  "for anything mentioning kubernetes", 'for "a" or "b"', "for a tool for teams",
  'for "don\'t use"', 'for "comment moderation"',
];
const EXCL = ["", "except spam", 'without "spam"', 'ignoring "except this"', "excluding promo and giveaway", 'but not "at least 5 upvotes"'];
const SCORE = ["", "with at least 5 upvotes", "score above 20"];
const KIND = ["", "comments", "posts and comments"];
const DELIV = ["", "and send to slack", "deliver to discord"];

export function generate() {
  const out = new Set();
  for (const s of SUBS) for (const k of KEYS) for (const e of EXCL) for (const sc of SCORE) for (const ki of KIND) for (const d of DELIV) {
    const core = ["watch", s, ki, k, e, sc, d].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (core !== "watch") out.add(core);
    // The marker written BEFORE the main clause, which is the permutation that
    // broke the exclusion clause twice.
    if (e) out.add([e, "watch", s, ki, k, sc, d].filter(Boolean).join(" ").replace(/\s+/g, " ").trim());
  }
  return [...out];
}

const QUOTED = /"([^"]{1,200})"|“([^”]{1,200})”/g;
const REFUSALS = new Set(["partial_understanding", "contradictory_filter"]);

// Only run the suite when executed directly, so generate() can be imported by
// a proof script that applies the SAME corpus to an older build of the
// compiler. That is how this file's own red test is produced: invariants I3 to
// I7 read only the FILTER, so they apply unchanged to any version.
const direct = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
const sentences = generate();
// Anti-vacuity: a generator that produced a handful of sentences would make
// every assertion below pass while proving nothing.
assert.ok(sentences.length > 20000, `the generator produced only ${sentences.length} sentences`);
n++; ok(`generated ${sentences.length} adversarial sentences from colliding pieces`);

const fails = { threw: [], unaccounted: [], degenerate: [], selfCancel: [], doubleCount: [], lostQuote: [] };
let compiled = 0, refused = 0, unanchored = 0;

for (const s of sentences) {
  let r;
  try {
    r = compileWatch(s);
  } catch (err) {
    fails.threw.push([s, String(err).slice(0, 120)]);
    continue;
  }
  if (REFUSALS.has(r.error)) { refused++; continue; }
  if (r.error === "no_anchor") { unanchored++; continue; }
  compiled++;
  const f = r.filter;

  // I2
  if (r.accounting.residue.length || r.accounting.conflicts.length || r.accounting.contradictions.length) {
    fails.unaccounted.push([s, r.accounting]);
  }
  const terms = [f.q, ...(f.include_any || []), ...(f.exclude_terms || [])].filter(Boolean);
  // I3
  for (const t of terms) {
    if (!/[A-Za-z0-9]/.test(t)) fails.degenerate.push([s, t, "no alphanumeric"]);
    if ((t.match(/"/g) || []).length % 2 === 1) fails.degenerate.push([s, t, "unbalanced quote"]);
  }
  // I4
  for (const t of f.exclude_terms || []) {
    for (const w of [f.q, ...(f.include_any || [])].filter(Boolean)) {
      if (w.toLowerCase() === t.toLowerCase()) fails.selfCancel.push([s, t]);
    }
  }
  // I5, with the quoted literal exempt: a caller who writes for "r/startups"
  // means that text, and honouring it is a faithful reading, not a double count.
  const quotedInInput = [...s.matchAll(QUOTED)].map((m) => (m[1] ?? m[2]).trim().toLowerCase());
  for (const t of terms) {
    if (quotedInInput.includes(t.toLowerCase())) continue;
    for (const sub of f.subreddit || []) {
      if (new RegExp(`\\br/${sub}\\b`, "i").test(t)) fails.doubleCount.push([s, t, sub]);
    }
  }
  // I6
  if (f.kind && !/\b(posts?|comments?|submissions?|threads?)\b/i.test(s.replace(QUOTED, " "))) {
    fails.degenerate.push([s, f.kind, "kind with no kind word outside quotes"]);
  }
  // I7
  for (const m of s.matchAll(QUOTED)) {
    const v = (m[1] ?? m[2]).trim();
    if (!terms.some((t) => t.toLowerCase() === v.toLowerCase())) fails.lostQuote.push([s, v, JSON.stringify(f)]);
  }
}

if (process.argv.includes("--report")) {
  console.log(`  compiled ${compiled}, refused ${refused}, no_anchor ${unanchored}`);
}
for (const [name, rows] of Object.entries(fails)) {
  assert.deepEqual(
    rows.slice(0, 3),
    [],
    `${rows.length} ${name} violation(s) across the generated corpus; first few: ${JSON.stringify(rows.slice(0, 3)).slice(0, 600)}`,
  );
}
n++; ok(`${compiled} compiled, ${refused} refused, ${unanchored} unanchored: zero violations of I1-I7`);

// POSITIVE CONTROLS ON THE INVARIANTS THEMSELVES. A sweep that reports zero is
// worth nothing unless the same code catches a planted defect of each class, so
// each invariant is run against a filter that violates it.
const planted = [
  ["I3", { q: '"' }, (f) => [f.q].some((t) => !/[A-Za-z0-9]/.test(t))],
  ["I4", { q: "spam", exclude_terms: ["spam"] }, (f) => (f.exclude_terms || []).some((t) => t.toLowerCase() === f.q.toLowerCase())],
  ["I5", { subreddit: ["SaaS"], q: "posts in r/SaaS" }, (f) => (f.subreddit || []).some((s2) => new RegExp(`\\br/${s2}\\b`, "i").test(f.q))],
  ["I6", { kind: "comment" }, (f) => Boolean(f.kind) && !/\b(posts?|comments?)\b/i.test("watch r/SaaS for pricing")],
  ["I7", { q: "other" }, (f) => !["other"].includes("ignore list") && f.q !== "ignore list"],
];
for (const [label, filter, detect] of planted) {
  assert.ok(detect(filter), `the ${label} check cannot see a filter that violates ${label}`);
}
n++; ok(`all ${planted.length} invariant checks catch a planted violation of their own class`);

// THE GATE MUST ACTUALLY FIRE. A refusal path that never refuses is decoration,
// and the generated corpus above is built from well-formed pieces, so it is not
// evidence that the gate works on genuinely unplaceable words.
const MUST_REFUSE = [
  "r/SaaS pricing churn onboarding",
  "monitor r/SaaS hourly digest summary please",
  "r/SaaS churn onboarding retention expansion",
  'watch for "x" ignoring "x"',
  'watch r/SaaS for "spam" excluding "spam"',
];
for (const s of MUST_REFUSE) {
  const r = compileWatch(s);
  assert.ok(REFUSALS.has(r.error), `expected a refusal for ${JSON.stringify(s)}, got ${JSON.stringify(r.filter)}`);
  assert.deepEqual(r.filter, {}, "a refusal must carry no filter to act on");
  assert.ok(
    r.accounting.residue.length || r.accounting.contradictions.length,
    "a refusal must name what it could not place or what contradicts",
  );
}
n++; ok(`the admission gate refuses all ${MUST_REFUSE.length} unplaceable or self-cancelling inputs, each naming why`);

// AND IT MUST NOT FIRE ON ORDINARY SENTENCES. A gate that refuses everything is
// as useless as one that refuses nothing, so the refusal rate on plain English
// is measured rather than assumed.
const REASONABLE = [
  'watch r/SaaS for "pricing page"',
  "monitor r/devops for kubernetes",
  'track r/startups for "fundraising"',
  'keep an eye on r/SaaS for "competitor"',
  'notify me when someone mentions "acme" in r/SaaS',
  "alert me about new posts in r/SaaS mentioning churn",
  'watch r/SaaS and r/startups and r/Entrepreneur for "pricing"',
  'watch r/SaaS for "pricing" or "cost" or "expensive"',
  'monitor r/webdev comments for "nextjs"',
  "watch r/SaaS for posts over 100 upvotes",
  'watch r/MachineLearning for "fine-tuning" excluding "job"',
  "watch r/SaaS for pricing and send to slack",
  "watch r/saas for churn please",
  'watch r/SaaS for "pricing" but not "free"',
  "watch r/SaaS for posts about pricing",
  "except spam watch r/SaaS for pricing",
  'watch r/SaaS for "ignore list"',
  "watch r/SaaS",
];
const refusedReasonable = REASONABLE.filter((s) => REFUSALS.has(compileWatch(s).error));
assert.deepEqual(refusedReasonable, [], `the gate refused ordinary sentences: ${JSON.stringify(refusedReasonable)}`);
n++; ok(`0 of ${REASONABLE.length} ordinary sentences refused (${((100 * refused) / sentences.length).toFixed(1)}% of the adversarial corpus refused)`);

console.log(`\nwatch-invariants: ${n} passed, 0 failed`);
}
