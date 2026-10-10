// src/watch.js, the local half of reddit_set_watch.
//
// WHAT THIS IS. Standing up a working Reddit watch takes three calls today:
// register a delivery target, create the monitor, test the target. Each one
// needs its own vocabulary (filter_spec nesting, the anchor rule, the webhook
// kind inference), and the first one a caller gets wrong fails late, as a 400
// or a 402 from the API. This module turns a sentence into those calls, in
// order, with the two rules that can be checked WITHOUT a round trip checked
// locally first.
//
// IT IS A COMPILER, NOT A MODEL. Every rule below is a regular expression and a
// documented transformation. There is no language model in this path and no
// network call in the compile step, so the same sentence always compiles to the
// same filter and `understood` can be handed back for a human to check.
//
// THE TWO LOCAL REFUSALS, both of which the API also enforces:
//   1. ANCHOR. A monitor is anchored by a subreddit list, a keyword, or both; a
//      request with neither is refused (apps/api/src/lib/monitor-filter.js).
//      Refusing locally costs nothing and names the missing half.
//   2. RESERVED. subreddit ['all'] is refused with subreddit_reserved (400),
//      because r/all is Reddit's site-wide listing and not a subreddit. The
//      compiler drops it and says so rather than building a request that 400s.
//
// PLAN AWARENESS IS A FIELD READ, NOT A GUESS. GET /api/reddit/monitor/list is
// free and returns a `slots` object that states the account's capabilities
// outright (measured live 2026-10-02):
//   {used, total, tier, is_free, cadence_s, sitewide_slots,
//    distinct_subreddits_used, distinct_subreddits_total,
//    comments_allowed, scoped_allowed, sitewide_allowed}
// `scoped_allowed` is the flag that decides whether a sentence naming r/SaaS can
// be built as written. On a plan without it, a sentence that ALSO carries a
// keyword is compiled to the sitewide equivalent (same keyword, every
// subreddit) and the swap is reported in `notes`; a sentence with no keyword has
// no sitewide equivalent, so the request goes as written and the API's own
// answer is relayed. A `slots` object that is missing or shaped differently
// means the preflight stays silent and the API decides, because the API is the
// authority on its own entitlements.
//
// ORDER OF OPERATIONS, chosen for the failure mode rather than for the happy
// path: the monitor is created FIRST and the delivery target second. A monitor
// with no webhook_ids delivers to every active webhook on the account, so a
// monitor that outlives a failed webhook registration is still a working watch.
// The reverse order would leave a registered webhook pointing at nothing when
// the monitor hits a slot limit.

import { buildWatchSummary } from "./watch-text.js";

// ── the compiler ────────────────────────────────────────────────────────────
//
// THE RULE THIS FILE IS BUILT AROUND: THE COMPILER NEVER RETURNS A FILTER IT
// CANNOT FULLY ACCOUNT FOR.
//
// Three rounds of defects were found here, seventeen in total, and every single
// one had the same observable signature: the compiler consumed part of the
// input, emitted a filter anyway, and said nothing. The worst of them produced
// a monitor whose keyword was a single `"` character. None of them was a
// missing regular expression. They were all the same thing: a compiler that
// always returns something cannot tell you it did not understand you, and on
// this feature not understanding you is INVISIBLE. The caller gets a monitor
// id, a green test delivery, and then either silence forever or a firehose.
//
// Rounds one and two were both fixed by writing better rules, and both fixes
// shipped a suite that pinned the sentences that had just been fixed and could
// not fail on an input nobody had thought of. Round two's rewrite broke nine
// inputs that round one handled. More rules was never going to end.
//
// So the contract is inverted. Every character of the input is CLAIMED by
// exactly one thing: a subreddit, a quoted span, a keyword, an exclusion, a
// score clause, a delivery clause, a word the sentence spends on the match kind,
// or an explicitly contentless word. Anything left over is RESIDUE, and residue
// means the compiler refuses with `partial_understanding`, naming the words it
// could not place and showing what it did understand, instead of guessing.
//
// That turns every failure of this file from "a silently wrong monitor that
// looks fine" into "a refusal that says why". For a feature whose failures are
// invisible that is the only safe direction, and it is the one property that
// holds for inputs nobody has thought of yet.
//
// ORDER MATTERS AND IS FIXED. Quoted spans are found FIRST and masked, so a
// marker word, a subreddit or a kind word inside a user's own quotes is
// invisible to every later step. That is what makes `for "ignore list"`,
// `for "except this"` and `for "send to production"` ordinary keywords rather
// than the wreckage they used to be.

// Subreddits, in two forms. The bare form's leading character class deliberately
// excludes "/", so a path such as docs/r/readme is not a subreddit; only the
// name itself is claimed, never the quote or bracket in front of it.
const SUBREDDIT_URL_RE =
  /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)*reddit\.com\/r\/([A-Za-z0-9][A-Za-z0-9_]{1,20})(?![A-Za-z0-9_])\/?/gi;
const SUBREDDIT_RE = /(^|[\s,.;:("'[])(\/?r\/([A-Za-z0-9][A-Za-z0-9_]{1,20}))(?![A-Za-z0-9_])/g;

// Quoted phrases. Straight double quotes, curly double quotes and curly single
// quotes only: a straight apostrophe is far more often a contraction than a
// quote, and treating it as one turns half a sentence into a keyword.
const QUOTED_RE = /"([^"]{1,200})"|“([^”]{1,200})”|‘([^’]{1,200})’/g;

const KEYWORD_LEAD_SRC =
  "(?:mentions? of|mentioning|that mentions?|who mentions?|talking about|talks about|keyword|about|for)";
const KEYWORD_LEAD_RE = new RegExp(`\\b${KEYWORD_LEAD_SRC}\\s+`, "i");

const LEADING_FILLER_RE = /^(?:the|a|an|any|all|new|every)\s+/i;
const SCAFFOLD_RE =
  /^(?:(?:new|all|any|the)\s+)*(?:posts?|comments?|threads?|submissions?|mentions?|anything|anyone|everything|everyone|people|someone|somebody|users?|redditors?)(?:\s+and\s+(?:posts?|comments?|threads?|submissions?))?\s+(?:that\s+|which\s+)?(?:about|mentioning|mentions?|discussing|discuss(?:es)?|talking about|talks about|referencing|references?|regarding|on|of)\s+/i;
// `(^|\s+)` so a tail that is ENTIRELY scaffolding ("for posts") reduces to
// nothing instead of becoming the keyword "posts".
const TRAILING_NOISE_RE =
  /(?:^|\s+)\b(?:posts?|comments?|threads?|submissions?|mentions?|in|on|from|to|anywhere|site[- ]?wide|sitewide|please)\b[\s.]*$/i;

const MIN_SCORE_RE =
  /\b(?:at least|minimum of|min(?:imum)?|over|above)\s+(\d{1,7})\s*\+?\s*(?:upvotes?|points?|score|karma)\b/i;
const MIN_SCORE_ALT_RE = /\bscore\s+(?:of\s+)?(?:at least|over|above|>=?)\s*(\d{1,7})\b/i;

const KIND_WORD_RE = /\b(posts?|submissions?|threads?|comments?)\b/gi;

const RESERVED_SUBREDDITS = new Set(["all", "popular"]);

// Words that carry no filter content. A word here is CLAIMED and therefore
// never residue, so this list is the one place where "the compiler ignored
// this on purpose" is written down and can be reviewed. It is deliberately a
// list of contentless English, not a dumping ground for whatever made a test
// go green: a word added here can never again cause a refusal, so adding a
// CONTENT word here would re-open exactly the silent-loss hole this design
// closes.
export const IGNORABLE = new Set([
  // the ask itself
  "watch", "watching", "watches", "monitor", "monitoring", "track", "tracking",
  "alert", "alerts", "notify", "ping", "tell", "show", "find", "get", "keep",
  "look", "looking", "see", "catch", "follow", "following", "let", "know",
  "set", "up", "setup", "create", "add", "make", "start", "please", "want",
  "need", "would", "like",
  // determiners, pronouns, prepositions, conjunctions
  "a", "an", "the", "any", "all", "every", "each", "some", "new", "this",
  "that", "these", "those", "there", "here", "it", "its", "them", "they",
  "me", "my", "us", "our", "we", "i", "you", "your",
  "in", "on", "of", "at", "to", "from", "and", "or", "with", "by", "as",
  "into", "across", "over", "under", "about", "for", "is", "are", "be",
  "when", "whenever", "if", "anytime", "while", "whose", "which", "who",
  // what is being watched, in words that add nothing to a filter
  "reddit", "subreddit", "subreddits", "sub", "subs", "community", "communities",
  "everything", "anything", "someone", "anyone", "somebody", "anybody",
  "people", "person", "folks", "users", "user", "redditors", "redditor",
  "mention", "mentions", "mentioned", "mentioning", "talking", "talks", "talk",
  "discussing", "discusses", "discuss", "says", "say", "said", "posting",
  "keyword", "keywords", "phrase", "phrases", "term", "terms", "word", "words",
  "eye", "out",
  // pure adverbial filler
  "just", "only", "also", "really", "simply", "basically", "actually", "ever",
  "still", "again", "too", "very", "quite",
]);

/** Strip contentless words from both ends of a derived term. */
function trimIgnorable(term) {
  const parts = String(term).split(/\s+/).filter(Boolean);
  while (parts.length && IGNORABLE.has(parts[0].toLowerCase().replace(/[^a-z0-9'’-]/g, ""))) parts.shift();
  while (parts.length && IGNORABLE.has(parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9'’-]/g, ""))) parts.pop();
  return parts.join(" ");
}

function cleanTerm(s) {
  return String(s || "").replace(/\s+/g, " ").replace(/^[,:;.\s]+|[,:;.\s]+$/g, "").trim();
}

/** A character-level record of what claimed each part of the input. */
class Claims {
  constructor(len) { this.by = new Array(len).fill(null); }
  claim(start, end, by) {
    for (let i = Math.max(0, start); i < Math.min(this.by.length, end); i++) {
      if (this.by[i] === null) this.by[i] = by;
    }
  }
  /** Owners, other than `by`, that already hold any character in the range. */
  conflicts(start, end, by) {
    const out = new Set();
    for (let i = Math.max(0, start); i < Math.min(this.by.length, end); i++) {
      const o = this.by[i];
      if (o !== null && o !== by) out.add(o);
    }
    return [...out];
  }
  /** Claim the first occurrence of `needle` at or after `from`, if present. */
  claimText(text, needle, from, by) {
    if (!needle) return -1;
    const i = text.indexOf(needle, from);
    if (i >= 0) this.claim(i, i + needle.length, by);
    return i;
  }
}

// The markers that start a clause, and how much each consumes. "rest" runs to
// the next marker OR to a keyword lead, so an exclusion written before the main
// clause ("except spam watch r/SaaS for pricing") does not swallow it.
const CLAUSE_MARKERS = [
  { kind: "exclude", consumes: "rest", re: /\b(?:except|excluding|but not|ignoring|ignore|without)\b/gi },
  {
    kind: "score",
    consumes: "self",
    re: /\b(?:with\s+)?(?:a\s+)?(?:at least|minimum of|min(?:imum)?|over|above)\s+\d{1,7}\s*\+?\s*(?:upvotes?|points?|score|karma)\b|\bscore\s+(?:of\s+)?(?:at least|over|above|>=?)\s*\d{1,7}\b/gi,
  },
  { kind: "deliver", consumes: "rest", re: /\b(?:and\s+(?:deliver|send|post|notify|alert)\b|deliver(?:ed)?\s+to\b|send\s+to\b)/gi },
];

/**
 * Cut a masked sentence into clauses. Exported so a test can assert the cut
 * itself: when a field comes out wrong, the first question is always whether
 * the cut or the field rule was at fault.
 */
export function segmentMasked(masked) {
  const hits = [];
  for (const m of CLAUSE_MARKERS) {
    for (const hit of masked.matchAll(new RegExp(m.re.source, m.re.flags))) {
      hits.push({ kind: m.kind, consumes: m.consumes, start: hit.index, end: hit.index + hit[0].length });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const taken = [];
  for (const h of hits) if (!taken.length || h.start >= taken[taken.length - 1].end) taken.push(h);

  const out = [];
  let pos = 0;
  for (let i = 0; i < taken.length; i++) {
    const h = taken[i];
    if (h.start < pos) continue;
    if (h.start > pos) out.push({ kind: "keyword", start: pos, end: h.start });
    if (h.consumes === "self") {
      out.push({ kind: h.kind, start: h.start, end: h.end, markerEnd: h.end });
      pos = h.end;
    } else {
      const next = taken.slice(i + 1).find((n) => n.start >= h.end);
      // An exclusion or delivery clause also ends where the main clause starts
      // again, so a marker written first cannot eat the rest of the sentence.
      const after = masked.slice(h.end, next ? next.start : masked.length);
      const lead = after.match(new RegExp(`\\b${KEYWORD_LEAD_SRC}\\s+`, "i"));
      const stop = lead ? h.end + lead.index : (next ? next.start : masked.length);
      out.push({ kind: h.kind, start: h.start, end: stop, markerEnd: h.end });
      pos = stop;
    }
  }
  if (pos < masked.length) out.push({ kind: "keyword", start: pos, end: masked.length });
  return out;
}

/** Back-compat shape for callers that only want the clause kinds and text. */
export function segment(text) {
  const t = String(text || "");
  return segmentMasked(t).map((s) => ({ kind: s.kind, text: cleanTerm(t.slice(s.start, s.end)) }));
}

/**
 * Compile a plain-words watch description into a monitor filter.
 *
 * Pure: no I/O, no clock, no randomness. Returns the filter the API takes, a
 * plain-English `understood` record, `notes` naming anything dropped or
 * rewritten, an `accounting` record, and `error` when the input could not be
 * fully accounted for.
 *
 * @param {string} text
 * @returns {{filter: object, understood: object, notes: string[], accounting: object, error: string|null}}
 */
export function compileWatch(text) {
  const notes = [];
  const raw = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const empty = { filter: {}, understood: {}, notes, accounting: { residue: [], claimed: {} }, error: "empty_description" };
  if (!raw) return empty;

  const claims = new Claims(raw.length);

  // 1. QUOTED SPANS FIRST, then mask them. Everything after this step reads a
  //    string in which the user's own quoted words cannot be mistaken for a
  //    marker, a subreddit or a kind word.
  const quotedSpans = [];
  for (const m of raw.matchAll(QUOTED_RE)) {
    const value = cleanTerm(m[1] ?? m[2] ?? m[3]);
    quotedSpans.push({ start: m.index, end: m.index + m[0].length, value });
    claims.claim(m.index, m.index + m[0].length, "quoted");
  }
  const maskChars = raw.split("");
  for (const sp of quotedSpans) for (let i = sp.start; i < sp.end; i++) maskChars[i] = "\u0000";
  const masked = maskChars.join("");

  // 2. Subreddits, link form first so a link's own text is never read as words.
  const subs = [];
  const dropped = [];
  const addSub = (name) => {
    if (RESERVED_SUBREDDITS.has(name.toLowerCase())) {
      if (!dropped.includes(name)) dropped.push(name);
      return;
    }
    if (!subs.some((x) => x.toLowerCase() === name.toLowerCase())) subs.push(name);
  };
  for (const m of masked.matchAll(SUBREDDIT_URL_RE)) {
    addSub(m[1]);
    claims.claim(m.index, m.index + m[0].length, "subreddit");
  }
  for (const m of masked.matchAll(SUBREDDIT_RE)) {
    if (claims.by[m.index + m[1].length] !== null) continue; // already a link
    addSub(m[3]);
    // Only the r/Name itself, never the quote or bracket in front of it.
    claims.claim(m.index + m[1].length, m.index + m[1].length + m[2].length, "subreddit");
  }
  if (dropped.length) {
    notes.push(
      `r/${dropped.join(", r/")} names Reddit's site-wide listing rather than a subreddit, so it was dropped from the subreddit list; a watch with no subreddit list already covers every subreddit.`,
    );
  }

  // 3. Cut into clauses over the MASKED text, then claim each marker.
  const spans = segmentMasked(masked);
  for (const sp of spans) {
    if (sp.kind !== "keyword") claims.claim(sp.start, sp.markerEnd ?? sp.start, `${sp.kind}-marker`);
    if (sp.kind === "score" || sp.kind === "deliver") claims.claim(sp.start, sp.end, sp.kind);
  }

  const quotedIn = (sp) => quotedSpans.filter((qs) => qs.start >= sp.start && qs.end <= sp.end);

  // A SUBREDDIT INSIDE A CLAUSE ENDS THAT CLAUSE, for keywords and exclusions
  // alike. "about new posts in r/SaaS mentioning churn" is one clause to a
  // regular expression and two to a reader, and without this the keyword became
  // the literal string "posts in r/SaaS mentioning churn", double-counting the
  // subreddit the filter had already taken. "except spam watch r/SaaS for
  // pricing" did the same to an exclusion.
  const subSegments = (from, to) => {
    const cuts = [];
    let i = from;
    while (i < to) {
      if (claims.by[i] === "subreddit") {
        let j = i;
        while (j < to && claims.by[j] === "subreddit") j++;
        cuts.push([i, j]);
        i = j;
      } else i++;
    }
    const out = [];
    let start = from;
    for (const [a, b] of cuts) { if (a > start) out.push([start, a]); start = b; }
    if (start < to) out.push([start, to]);
    return out.length ? out : [[from, to]];
  };
  const keywordSpans = spans.filter((sp) => sp.kind === "keyword");
  const excludeSpans = spans.filter((sp) => sp.kind === "exclude");

  // 4. Keywords, from the keyword spans and nowhere else.
  const quotedKeywords = [];
  for (const sp of keywordSpans) {
    for (const qs of quotedIn(sp)) {
      if (qs.value && !quotedKeywords.some((x) => x.toLowerCase() === qs.value.toLowerCase())) quotedKeywords.push(qs.value);
    }
  }

  let q;
  let includeAny;
  const bareCandidates = [];
  const conflicts = [];
  if (quotedKeywords.length === 1) {
    q = quotedKeywords[0];
  } else if (quotedKeywords.length > 1) {
    includeAny = quotedKeywords.slice(0, 50);
  } else {
    for (const sp of keywordSpans) {
      for (const [segStart, segEnd] of subSegments(sp.start, sp.end)) {
        const spanText = raw.slice(segStart, segEnd);
        const lead = spanText.match(KEYWORD_LEAD_RE);
        if (!lead) continue;
        let off = lead.index + lead[0].length;
        let tail = spanText.slice(off);
        claims.claim(segStart + lead.index, segStart + off, "keyword-lead");
        for (const re of [LEADING_FILLER_RE, SCAFFOLD_RE, SCAFFOLD_RE, SCAFFOLD_RE]) {
          const strip = tail.match(re);
          if (strip) { claims.claim(segStart + off, segStart + off + strip[0].length, "scaffolding"); off += strip[0].length; tail = tail.slice(strip[0].length); }
        }
        // Repeatedly, so a tail of nothing but scaffolding reduces to nothing.
        for (let n = 0; n < 4; n++) {
          const trail = tail.match(TRAILING_NOISE_RE);
          if (!trail) break;
          claims.claim(segStart + off + trail.index, segStart + off + tail.length, "scaffolding");
          tail = tail.slice(0, trail.index);
        }
        const value = trimIgnorable(cleanTerm(tail));
        if (value && value.length <= 200) {
          const at = raw.indexOf(value, segStart + off);
          // EXACTLY ONE CLAIM PER CHARACTER. A keyword that overlaps something
          // already taken means the compiler counted the same words twice, so
          // it did not understand the sentence and must say so.
          if (at >= 0) {
            const clash = claims.conflicts(at, at + value.length, "keyword");
            if (clash.length) conflicts.push({ value, overlaps: clash });
            claims.claim(at, at + value.length, "keyword");
          }
          if (!bareCandidates.some((x) => x.toLowerCase() === value.toLowerCase())) bareCandidates.push(value);
        }
      }
    }
    if (bareCandidates.length) q = bareCandidates[0];
    if (bareCandidates.length > 1) {
      notes.push(
        `The description carries more than one phrase to watch for; ${JSON.stringify(bareCandidates[0])} was used and ${bareCandidates.slice(1).map((c) => JSON.stringify(c)).join(", ")} was not. Quoting each phrase matches any of them.`,
      );
    }
  }

  // 5. Exclusions, from the exclusion spans and nowhere else.
  const exTerms = [];
  for (const sp of excludeSpans) {
    const qs = quotedIn(sp);
    let parts;
    if (qs.length) {
      parts = qs.map((x) => x.value);
    } else {
      parts = [];
      for (const [a, b] of subSegments(sp.markerEnd ?? sp.start, sp.end)) {
        for (const piece of raw.slice(a, b).split(/\s*(?:,|\bor\b|\band\b)\s*/i)) {
          const t = trimIgnorable(cleanTerm(piece));
          if (t) parts.push(t);
        }
      }
    }
    for (const t of parts) {
      if (t.length <= 200 && !exTerms.some((x) => x.toLowerCase() === t.toLowerCase())) exTerms.push(t);
    }
    claims.claim(sp.start, sp.end, "exclude");
  }
  const excludeTerms = exTerms.length ? exTerms.slice(0, 50) : undefined;

  // 6. Score floor, from the score spans the cut already isolated.
  let minScore;
  for (const sp of spans.filter((x) => x.kind === "score")) {
    const t = raw.slice(sp.start, sp.end);
    const ms = t.match(MIN_SCORE_RE) || t.match(MIN_SCORE_ALT_RE);
    if (ms) { minScore = Number(ms[1]); break; }
  }

  // 7. Match kind, from the ORIGINAL positions of the words the sentence spends
  //    on it. Never from a string with substrings deleted: deleting the keyword
  //    "post" out of "posts and comments" left "s and comments" and flipped a
  //    posts-and-comments watch to comments only.
  let saysComments = false;
  let saysPosts = false;
  for (const m of masked.matchAll(KIND_WORD_RE)) {
    const owner = claims.by[m.index];
    if (owner === "keyword" || owner === "exclude" || owner === "quoted") continue;
    if (/^comments?$/i.test(m[0])) saysComments = true; else saysPosts = true;
    claims.claim(m.index, m.index + m[0].length, "kind");
  }
  let kind;
  if (saysComments && saysPosts) kind = "both";
  else if (saysComments) kind = "comment";

  // 8. Contentless words are claimed, so they are never residue.
  for (const m of raw.matchAll(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g)) {
    if (IGNORABLE.has(m[0].toLowerCase())) claims.claim(m.index, m.index + m[0].length, "ignorable");
  }

  // 9. THE ADMISSION GATE. Any word with an unclaimed character is residue, and
  //    residue means the compiler did not understand the whole input, so it
  //    returns nothing to act on.
  const residue = [];
  for (const m of raw.matchAll(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g)) {
    let covered = true;
    for (let i = m.index; i < m.index + m[0].length; i++) if (claims.by[i] === null) { covered = false; break; }
    if (!covered) residue.push(m[0]);
  }

  const filter = {};
  if (subs.length) filter.subreddit = subs.slice(0, 50);
  if (q) filter.q = q;
  if (includeAny) filter.include_any = includeAny;
  if (excludeTerms) filter.exclude_terms = excludeTerms;
  if (kind) filter.kind = kind;
  if (minScore !== undefined) filter.min_score = minScore;

  const understood = {
    subreddits: filter.subreddit || null,
    keyword: filter.q || null,
    any_of: filter.include_any || null,
    excluded_terms: filter.exclude_terms || null,
    match_kind: filter.kind || "post",
    min_score: filter.min_score ?? null,
    scope: filter.subreddit ? "named subreddits" : "every subreddit",
  };

  const byClaim = {};
  for (const c of claims.by) if (c) byClaim[c] = (byClaim[c] || 0) + 1;
  // A FILTER THAT CANNOT EVER MATCH IS NOT A FILTER. Found by the generated
  // corpus, not by anyone's list: "watch for X ignoring X" compiles perfectly,
  // every word accounted for, and produces a monitor whose keyword is also its
  // exclusion. It can never deliver, and the caller gets a monitor id, a green
  // test delivery and silence, which is the exact failure this whole file is
  // built to make impossible. The compiler understood every word here, so this
  // is not partial understanding: the request contradicts itself, and the two
  // halves are named rather than one of them being guessed away.
  // AN UNQUOTED KEYWORD IS A FREE-TEXT RUN, so it absorbs whatever follows the
  // lead word: "for pricing every tuesday at noon" becomes a keyword nothing
  // says. The compiler cannot know which half was meant and will not guess, but
  // it will not be silent either: the phrase it took is named, and the result
  // text repeats it, so a wrong reading is visible before the monitor is built
  // rather than after a week of no deliveries.
  if (q && !quotedKeywords.length && q.split(/\s+/).length > 3) {
    notes.push(
      `The keyword was read from unquoted words as the whole phrase ${JSON.stringify(q)}, which is matched literally. Quoting the exact phrase pins it.`,
    );
  }

  const wanted = [q, ...(includeAny || [])].filter(Boolean);
  const contradictions = [];
  for (const w of wanted) {
    for (const t of excludeTerms || []) {
      if (w.toLowerCase() === t.toLowerCase()) contradictions.push(w);
    }
  }

  const accounting = { residue, conflicts, contradictions, claimed: byClaim, input: raw };

  if (residue.length || conflicts.length) {
    return { filter: {}, understood, notes, accounting, error: "partial_understanding" };
  }
  if (contradictions.length) {
    return { filter: {}, understood, notes, accounting, error: "contradictory_filter" };
  }
  const anchored = Boolean(filter.subreddit || filter.q || filter.include_any);
  return { filter, understood, notes, accounting, error: anchored ? null : "no_anchor" };
}

// ── plan preflight ──────────────────────────────────────────────────────────

/**
 * Read the account's capability flags from a monitor list response.
 * Returns null when the response is missing or shaped differently, which means
 * the preflight stays silent and the API decides.
 */
export function readSlots(listBody) {
  const s = listBody && typeof listBody === "object" ? listBody.slots : null;
  if (!s || typeof s !== "object") return null;
  return s;
}

/**
 * Apply the account's capabilities to a compiled filter.
 *
 * The only rewrite made here is the one with a genuine equivalent: a plan
 * without subreddit-scoped watches cannot run `subreddit: [...]`, but the same
 * keyword over every subreddit finds the same conversations in a wider net. A
 * filter with no keyword has no such equivalent, so it is left exactly as
 * compiled and the API answers for itself.
 */
export function applyPlan(filter, slots, notes) {
  const out = { ...filter };
  if (!slots) return out;
  const hasKeyword = Boolean(out.q || out.include_any);

  if (out.subreddit && slots.scoped_allowed === false) {
    if (hasKeyword) {
      delete out.subreddit;
      notes.push(
        `This account's plan carries no subreddit-scoped watches, so the watch was built over every subreddit with the same keyword instead of being limited to the subreddits named. A plan with scoped watches would narrow it back to those subreddits.`,
      );
    } else {
      notes.push(
        `This account's plan carries no subreddit-scoped watches and the description carries no keyword to widen it with, so the request went as written.`,
      );
    }
  }
  if (out.kind && out.kind !== "post" && slots.comments_allowed === false) {
    notes.push(
      `This account's plan carries no comment matching, so the request went as written and the API's own answer stands.`,
    );
  }
  return out;
}

// ── the handler ─────────────────────────────────────────────────────────────

// Each leg carries the composite tool's own name, so the provenance ledger
// attributes a monitor read made by reddit_set_watch to reddit_set_watch rather
// than to nothing.
const AS_SET_WATCH = { name: "reddit_set_watch" };

const MONITOR_FILTER_SPEC_FIELDS = [
  "subreddit", "exclude_subreddits", "kind", "q", "author", "exclude_terms",
  "domain", "include_any", "include_all", "search_in", "group", "min_score",
  "min_relevance", "nsfw",
];

/** Parse a callEndpoint success result's JSON body; null when it is not JSON. */
export function parseResult(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fail(message, extra = {}) {
  const payload = { status: "not_created", message, ...extra };
  return {
    isError: true,
    content: [{ type: "text", text: `${message}\n\n${JSON.stringify(payload)}` }],
    structuredContent: payload,
  };
}

/**
 * Build the reddit_set_watch handler.
 *
 * @param {object} deps
 * @param {Function} deps.callEndpoint the server's REST caller, already bound to
 *        this caller's credentials.
 */
export function createSetWatchHandler({ callEndpoint }) {
  return async function setWatch(args = {}) {
    const { watch, deliver_to: deliverTo, cadence_s: cadenceS, test_delivery: testDelivery } = args;

    // 1. Compile. No network call has happened yet, so a sentence that cannot
    //    be compiled costs nothing and the refusal names the missing half.
    const { filter, understood, notes, accounting, error } = compileWatch(watch);
    if (error === "empty_description") {
      return fail("No watch description was given. A watch is built from a sentence naming a subreddit, a keyword, or both.", { understood });
    }
    // THE ADMISSION GATE, surfaced. The compiler returns no filter it cannot
    // fully account for, so the caller is told which words could not be placed
    // and what was understood, and can rephrase or build the monitor directly
    // with reddit_monitor_add. Nothing was created and no request was sent.
    if (error === "partial_understanding") {
      const r = accounting?.residue || [];
      const c = accounting?.conflicts || [];
      return fail(
        `Part of the description could not be placed, so nothing was created and no request was sent. ` +
          (r.length ? `Unplaced: ${r.map((w) => JSON.stringify(w)).join(", ")}. ` : "") +
          (c.length ? `Counted twice: ${c.map((x) => JSON.stringify(x.value)).join(", ")}. ` : "") +
          `What was understood is below. Quoting the exact phrase to watch for, and writing subreddits as r/Name, usually resolves it; reddit_monitor_add takes a filter directly.`,
        { understood, accounting },
      );
    }
    if (error === "contradictory_filter") {
      return fail(
        `The description both watches for and excludes ${(accounting?.contradictions || []).map((w) => JSON.stringify(w)).join(", ")}, so the monitor could never deliver anything. Nothing was created and no request was sent.`,
        { understood, accounting },
      );
    }
    if (error === "no_anchor") {
      return fail(
        "The description named neither a subreddit (written as r/Name) nor a keyword (a quoted phrase, or a phrase after 'for' or 'mentioning'). A monitor is anchored by one or the other, so nothing was created and no request was sent.",
        { understood },
      );
    }

    // 2. Plan preflight. Free, unmetered, and a stated field rather than an
    //    inference. A failure here is not fatal: the API is the authority.
    let slots = null;
    const listRes = await callEndpoint("/api/reddit/monitor/list", {}, "GET", AS_SET_WATCH);
    if (!listRes?.isError) slots = readSlots(parseResult(listRes));

    const finalFilter = applyPlan(filter, slots, notes);

    // 3. Create the monitor first: a monitor without a webhook still delivers
    //    to every active webhook on the account, so it survives step 4 failing.
    const addArgs = { ...finalFilter };
    if (cadenceS !== undefined) addArgs.cadence_s = cadenceS;
    const addRes = await callEndpoint(
      "/api/reddit/monitor/add",
      addArgs,
      "POST",
      { ...AS_SET_WATCH, filterSpecFields: MONITOR_FILTER_SPEC_FIELDS },
    );
    if (addRes?.isError) {
      const text = addRes.content?.[0]?.text || "";
      const payload = {
        status: "not_created",
        message: "The monitor was not created. The compiled filter and the API's own answer are below; nothing else was registered.",
        understood,
        compiled_filter: finalFilter,
        notes,
        api_response: text.slice(0, 1200),
        plan: slots,
      };
      return {
        isError: true,
        content: [{ type: "text", text: `${payload.message}\n\n${text}\n\n${JSON.stringify(payload)}` }],
        structuredContent: payload,
      };
    }
    const monitor = parseResult(addRes);
    const monitorId = monitor?.monitor?.id || monitor?.id || null;

    // 4. Delivery target, when one was given.
    let delivery = null;
    if (deliverTo) {
      const whRes = await callEndpoint("/api/reddit/monitor/webhook/create", { url: deliverTo }, "POST", AS_SET_WATCH);
      if (whRes?.isError) {
        delivery = {
          registered: false,
          detail: (whRes.content?.[0]?.text || "").slice(0, 600),
        };
        notes.push(
          "The delivery target was not registered. The monitor exists and delivers to every active webhook already on the account.",
        );
      } else {
        const wh = parseResult(whRes);
        const webhook = wh?.webhook || wh || {};
        // THE SIGNING SECRET IS RETURNED, NOT COUNTED. It used to be read only
        // to set a boolean and then dropped, while the summary said it was in
        // the result. The API returns it exactly once and the webhook list
        // never returns it again, so a watch set up this way left its owner
        // permanently unable to verify a delivery signature, and told them
        // otherwise. Passing it through is what the single-purpose webhook tool
        // already does; anything less makes this path strictly worse than the
        // three calls it replaces.
        delivery = {
          registered: true,
          webhook_id: webhook.id ?? null,
          kind: webhook.kind ?? null,
          secret: typeof webhook.secret === "string" ? webhook.secret : null,
          secret_shown_once: typeof webhook.secret === "string",
          test: null,
        };
        if (!webhook.id) {
          notes.push(
            "The delivery target was registered but came back without an id, so this monitor could not be pointed at it and no test delivery was sent. Its matches go to every active webhook on the account.",
          );
        }

        // Point this monitor at the new target, so its matches do not fan out
        // to every webhook the account happens to hold.
        if (monitorId && webhook.id) {
          const upd = await callEndpoint(
            "/api/reddit/monitor/update",
            { id: monitorId, webhook_ids: [webhook.id] },
            "POST",
            { ...AS_SET_WATCH, filterSpecFields: MONITOR_FILTER_SPEC_FIELDS },
          );
          delivery.targeted = !upd?.isError;
          if (upd?.isError) {
            notes.push(
              "This monitor could not be pointed at the new delivery target, so its matches go to every active webhook on the account.",
            );
          }
        } else if (webhook.id) {
          // A SKIPPED STEP THAT SAYS NOTHING READS AS A COMPLETED ONE. The
          // monitor id is missing here, so the re-point never ran, and without
          // this the summary would still report a registered target as though
          // its matches were routed to it.
          delivery.targeted = false;
          notes.push(
            "The created monitor did not come back with an id, so it could not be pointed at the new delivery target. Its matches go to every active webhook on the account.",
          );
        }

        const wantsTest = testDelivery !== false;
        if (wantsTest && webhook.id) {
          const testRes = await callEndpoint("/api/reddit/monitor/webhook/test", { id: webhook.id }, "POST", AS_SET_WATCH);
          const body = parseResult(testRes);
          // TRI-STATE, because this product's own instructions tell a caller
          // that unknown is not healthy. `ok !== false` read a missing or
          // unparseable body as a SUCCESSFUL test delivery, which is the one
          // answer the caller must not be given on no evidence.
          delivery.test = testRes?.isError
            ? { ok: false, reason: null, hint: null, status: null, detail: (testRes.content?.[0]?.text || "").slice(0, 600) }
            : {
                ok: body?.ok === true ? true : body?.ok === false ? false : null,
                reason: body?.reason ?? null,
                hint: body?.hint ?? null,
                status: body?.status ?? null,
                detail: body?.detail ?? null,
              };
        }
      }
    }

    const payload = {
      status: "watching",
      monitor: monitor?.monitor ?? monitor ?? null,
      understood,
      compiled_filter: finalFilter,
      delivery,
      notes,
      plan: slots,
    };
    return {
      content: [{ type: "text", text: `${buildWatchSummary(payload)}\n\n${JSON.stringify(payload)}` }],
      structuredContent: payload,
    };
  };
}
