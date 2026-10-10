// src/compact.js, the response-shaping layer for Reddit reads.
//
// WHY THIS FILE EXISTS, measured rather than assumed. Before this change every
// read tool returned the upstream body verbatim, in server.js:
//
//     return { content: [{ type: "text", text: body }] };
//
// That body is Reddit's own JSON, and Reddit's JSON is a BROWSER payload, not an
// agent payload. A post object carries ~90 keys and a model reads about a dozen
// of them; `media_metadata` alone is 1-15 KB on an image post; a comment tree is
// a few thousand comment objects, each carrying full markdown plus the same
// flair/award/report/bookkeeping payload, with no cap on width or depth because
// GET /api/reddit/comments takes only `permalink` (no `limit`, no `depth` in
// docs.redditapis.com/openapi.json, so there is nothing to pass through).
//
// MEASURED, on the fixture in test/fixtures/reddit-shapes.mjs (a Reddit-shaped
// 25-post search page, a subreddit listing, a 60-comment thread with reply chains,
// and a 140-comment deep search result, built to the field list of Reddit's own
// listing JSON, because no redditapis.com key and no Reddit access exist in this
// environment): the four reads of one ordinary research turn returned 1,785,339
// bytes, about 446,000 tokens at four bytes per token. On its own that overflows a
// 262,144-token context window, which is the reported failure: a client like Open
// WebUI puts every tool result back into the next request, so one batch of four
// calls ended the chat. After this change the same four calls return 38,797 bytes
// (about 9,700 tokens), 46x smaller, with every call at or under the 16,000-byte
// ceiling. Reproduce it with `npm run measure:context`.
//
// WHAT IT DOES, in the order it runs:
//   1. default `limit`    -- a read with no `limit` asks the endpoint for
//                            `defaultLimit` instead of Reddit's 25 (0 disables).
//   2. field drop         -- Reddit's media/preview/flair/award/report internals,
//                            matched by name and by `prefix*` family. Extend with
//                            REDDITAPIS_MCP_DROP_FIELDS / un-drop with
//                            REDDITAPIS_MCP_KEEP_FIELDS.
//   3. empty drop         -- null, "", [] and {} carry no answer.
//   4. text budgets       -- bodies/selftext/descriptions shortened to a bound,
//                            with the number of dropped characters kept IN the
//                            text, so a shortened body says it was shortened.
//   5. comment tree caps  -- the top `commentsPerPost` comments of a tree by
//                            score, `repliesPerComment` replies per comment down
//                            `commentDepth` reply levels, [deleted]/[removed]
//                            pruned. Selection is by score; the surviving order
//                            is the order the endpoint returned, so a `sort` the
//                            caller asked for is never re-ordered by us. The
//                            defaults are self-consistent with the byte budget:
//                            10 top comments, each with its single best reply,
//                            is what fits without tightening anything.
//   6. size ceiling       -- any other field over `maxFieldBytes` becomes a
//                            "[trimmed N bytes]" marker, so an unknown or future
//                            Reddit field cannot blow the budget even if it is not
//                            in the drop list. This is the part that makes the
//                            bound structural rather than a list to keep up with.
//   7. byte budget        -- the result is re-shaped through a ladder of tighter
//                            settings until it fits `maxBytes`. The ladder goes
//                            BODIES FIRST, then the tree, and drops rows only at
//                            the end, so the number of answers is the last thing
//                            sacrificed and a long comment is the first.
//   8. `context` block    -- added only when something was cut: the bytes in and
//                            out, the estimate in tokens, the budget, and counts
//                            of each kind of cut. A caller can then ask for more
//                            knowingly instead of guessing that a short answer
//                            was a short answer.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH:
//   - Writes, monitor/webhook/feedback/account reads and local tools. A webhook
//     creation response carries a signing secret shown once; silently filtering
//     that would break a contract nobody would notice until a customer lost a
//     secret. Only GET reads under /api/reddit/ are shaped, because that is the
//     surface that returns Reddit's own objects.
//   - `callEndpoint` itself. src/watch.js and src/feedback.js consume parsed
//     responses, and the provenance ledger reports the UPSTREAM byte count.
//     Compaction happens once, in the registered tool handler, on the way out.
//   - The bytes of any tool result when `raw` is set: `REDDITAPIS_MCP_RAW=1`
//     restores the verbatim passthrough exactly as it shipped before.
export const COMPACT_DEFAULTS = Object.freeze({
  raw: false,
  // Reddit's own listing default is 25; the OpenAPI document at
  // docs.redditapis.com/openapi.json pins limit=25 for /api/reddit/posts and
  // /api/reddit/search. 10 compact posts is ~2 KB, and `after` pages the rest.
  defaultLimit: 10,
  // Ceiling on one tool result: ~4,000 tokens. Four reads in a batch is then
  // ~16,000 tokens against a 262,144-token window, where the same four reads
  // unshaped measured 1,785,357 bytes (~446,000 tokens) on the fixture.
  maxBytes: 16000,
  commentsPerPost: 10,
  // 10 top comments with their one best reply each is what fits the budget with
  // nothing tightened. Raise this together with maxBytes, not on its own.
  repliesPerComment: 1,
  commentDepth: 1,
  // `selftext` and subreddit descriptions: the text a reader answers with.
  bodyChars: 1200,
  // A comment body: the median Reddit comment is ~400 characters, so this cuts
  // only the outliers, and it is a separate knob because there are many more
  // comments in a payload than posts.
  commentBodyChars: 400,
  textChars: 400,
  maxFieldBytes: 900,
  maxDepth: 12,
  dropExtra: [],
  keepExtra: [],
});

// Reddit families that carry no answer for a model: rendered media variants,
// flair colour/blob objects, award and report bookkeeping, moderation internals,
// and the per-user flags a browser uses to draw a post. Entries ending in `*`
// are prefixes; every other entry is an exact key name. `keep` names are exempt
// from the family, which is how link_flair_text survives link_flair*.
export const DROP_FIELDS = Object.freeze([
  // media and previews: the largest per-post cost in Reddit's JSON
  "media_metadata", "media", "media_embed", "secure_media", "secure_media_embed",
  "preview", "gallery_data", "thumbnail*", "featured*", "post_hint",
  // flair blobs; only the text is ever read
  "author_flair*", "user_flair*", "link_flair*",
  // awards
  "all_awardings", "gildings", "award_*", "awarding*",
  // moderation and report internals
  "mod_reports", "user_reports", "num_reports", "reports", "mod_reason*",
  "removal_reason*", "banned_by", "ban_by", "ban_at", "approved_by", "approved_at",
  "distinguished_by", "ignore_reports", "can_*", "quarantine", "is_org",
  // Reddit's own client bookkeeping
  "saved_list_fullname", "saved_fullname", "parent_whole_link_id",
  "dismissable_vote_status", "hide_border", "send_replies", "no_follow",
  "top_awarded_type", "saved", "visited", "lazy", "likes", "upvotes", "downvotes",
  "is_created_from_ads_ui", "is_reddit_media_domain", "is_whiteout_mode",
  "is_external_url", "is_meta", "pinned*", "sticky*", "suggested*",
  "crosspost_parent_list", "url_overridden_by_dest", "secure_url",
  "body_html", "selftext_html", "description_html", "author_caked_day",
  "author_is_blocked", "collapsed*", "subreddit_id", "link_id",
  "total_awards_received", "sent_replies", "is_crosspostable",
  "is_robot_indexable", "post_author",
  // Captured live from api.redditapis.com, not from Reddit's docs. Verified
  // 2026-10-10 by running this package inside the mcpo container on CT 100 and
  // printing the keys a comment object comes back with: the wrapper is NOT a
  // byte-for-byte Reddit passthrough (`text` for the post body, `comments` for
  // the comment COUNT on a post, and these identity/score bookkeeping fields), so
  // the Reddit-name-only list above leaves them behind. See
  // test/fixtures/live-shapes.mjs.
  "gilded", "archived", "downs", "controversiality", "score_hidden",
  "author_fullname", "author_premium", "author_patreon_flair",
  "subreddit_type", "created", "subreddit_name_prefixed",
  "link_flair_background_color",
]);

// Never dropped, whatever the family rules above say: these are the readable
// parts of the flair families, which the `*` entries would otherwise take.
export const KEEP_FIELDS = Object.freeze([
  "link_flair_text", "author_flair_text", "user_flair_text",
]);

// Long prose fields: bounded by `bodyChars`, except a comment's `body`, which is
// bounded by the separate and smaller `commentBodyChars` because a payload carries
// thirty of them for every one post body.
export const TEXT_FIELDS = Object.freeze([
  "body", "selftext", "excerpt", "description", "public_description",
  "short_description", "content_md", "content_txt", "text", "snippet",
  "summary", "sidebar", "title", "link_title",
]);
export const COMMENT_TEXT_FIELDS = Object.freeze(["body"]);

// Arrays whose rows ARE the answer: never placeholdered for size, and only
// trimmed by the byte ladder, which drops whole rows rather than mangling one.
export const ROW_FIELDS = Object.freeze([
  "posts", "comments", "subreddits", "users", "authors", "results", "items",
  "rows", "deliveries", "feedback", "rules", "moderators", "achievements",
  "listings", "threads", "messages", "candidates",
]);

// Comment-tree arrays. `comments` at the root of a TREE tool is the tree itself;
// in a listing tool (reddit_user_comments, reddit_subreddit_comments) it is a
// listing the caller sized with `limit`, so it is not capped there.
export const COMMENT_LIST_FIELDS = Object.freeze(["comments", "replies", "children"]);

// The tools whose payload is a comment tree (or a scored comment list), where
// "the top N by score" is the right shape for an agent context.
export const TREE_TOOLS = Object.freeze(["reddit_post_comments", "reddit_post", "reddit_deep_comment_search"]);

const TEXT_SET = new Set(TEXT_FIELDS);
const COMMENT_TEXT_SET = new Set(COMMENT_TEXT_FIELDS);
const ROW_ONLY_SET = new Set(ROW_FIELDS);
const ROW_SET = new Set([...ROW_FIELDS, ...COMMENT_LIST_FIELDS]);
const COMMENT_LIST_SET = new Set(COMMENT_LIST_FIELDS);
const TREE_SET = new Set(TREE_TOOLS);

// The byte ladder, in the order things are given up: comment bodies, then post
// bodies, then the tree, and whole rows only at the end.
const BUDGET_LADDER = [
  {},
  { commentBodyChars: 220, bodyChars: 600, textChars: 240 },
  { commentBodyChars: 110, bodyChars: 300, textChars: 150 },
  { commentsPerPost: 5, repliesPerComment: 0 },
  { rowCap: 8 },
  { rowCap: 3 },
  { rowCap: 1 },
];

function toRegExpList(names) {
  const out = [];
  for (const raw of names || []) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (name.endsWith("*")) {
      out.push(new RegExp(`^${escapeRe(name.slice(0, -1))}`, "i"));
    } else {
      out.push(new RegExp(`^${escapeRe(name)}$`, "i"));
    }
  }
  return out;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSettings(overrides = {}) {
  const s = { ...COMPACT_DEFAULTS, ...overrides };
  s.raw = Boolean(s.raw);
  for (const k of ["defaultLimit", "maxBytes", "commentsPerPost", "repliesPerComment", "commentDepth", "bodyChars", "commentBodyChars", "textChars", "maxFieldBytes", "maxDepth"]) {
    const n = Number(s[k]);
    if (!Number.isFinite(n) || n < 0) {
      throw new TypeError(`compact.${k} must be a non-negative number, got ${JSON.stringify(s[k])}`);
    }
    s[k] = Math.floor(n);
  }
  if (s.maxBytes < 512) s.maxBytes = 512; // a budget below this cannot hold one row plus the context block
  s.dropExtra = Array.isArray(s.dropExtra) ? s.dropExtra : String(s.dropExtra || "").split(",");
  s.keepExtra = Array.isArray(s.keepExtra) ? s.keepExtra : String(s.keepExtra || "").split(",");
  const drop = toRegExpList([...DROP_FIELDS, ...s.dropExtra]);
  const keep = toRegExpList([...KEEP_FIELDS, ...s.keepExtra]);
  s.isDropped = (key) => keep.some((re) => re.test(key)) ? false : drop.some((re) => re.test(key));
  return s;
}

/**
 * Read the compaction settings from an env-shaped object, in the same style as
 * index.js reads REDDITAPIS_KEY: explicit names, and a bad value falls back to
 * the default rather than turning into `NaN` on the wire.
 */
export function compactionFromEnv(env = {}) {
  const num = (name, def) => {
    const v = env[name];
    if (v === undefined || v === null || String(v).trim() === "") return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : def;
  };
  const list = (name) => (env[name] ? String(env[name]).split(",").map((x) => x.trim()).filter(Boolean) : []);
  const out = {
    raw: /^(1|true|yes|on)$/i.test(String(env.REDDITAPIS_MCP_RAW ?? "")),
    defaultLimit: num("REDDITAPIS_MCP_DEFAULT_LIMIT", COMPACT_DEFAULTS.defaultLimit),
    maxBytes: num("REDDITAPIS_MCP_MAX_BYTES", COMPACT_DEFAULTS.maxBytes),
    commentsPerPost: num("REDDITAPIS_MCP_MAX_COMMENTS", COMPACT_DEFAULTS.commentsPerPost),
    repliesPerComment: num("REDDITAPIS_MCP_MAX_REPLIES", COMPACT_DEFAULTS.repliesPerComment),
    commentDepth: num("REDDITAPIS_MCP_COMMENT_DEPTH", COMPACT_DEFAULTS.commentDepth),
    commentBodyChars: num("REDDITAPIS_MCP_COMMENT_BODY_CHARS", COMPACT_DEFAULTS.commentBodyChars),
    bodyChars: num("REDDITAPIS_MCP_BODY_CHARS", COMPACT_DEFAULTS.bodyChars),
    textChars: num("REDDITAPIS_MCP_TEXT_CHARS", COMPACT_DEFAULTS.textChars),
    maxFieldBytes: num("REDDITAPIS_MCP_MAX_FIELD_BYTES", COMPACT_DEFAULTS.maxFieldBytes),
    dropExtra: list("REDDITAPIS_MCP_DROP_FIELDS"),
    keepExtra: list("REDDITAPIS_MCP_KEEP_FIELDS"),
  };
  if (out.defaultLimit < 0) out.defaultLimit = 0;
  return out;
}

/** A compacted read is only ever a plain GET read of Reddit's own objects. */
export function isCompactedRead(tool) {
  if (!tool || tool.write || tool.local) return false;
  if ((tool.method || "GET") !== "GET") return false;
  return typeof tool.path === "string" && tool.path.startsWith("/api/reddit/");
}

// The declared ceiling of a tool's `limit` argument, read off its own zod schema,
// so a defaulted limit can never exceed what the endpoint accepts. zod 3 keeps
// checks under `def.checks` with `kind`, zod 4 under `_zod.def.checks` with
// `type`, so both shapes are read and an unrecognised one yields no ceiling
// rather than a wrong number.
function limitCeiling(tool) {
  const checks = tool?.shape?.limit?.def?.checks
    || tool?.shape?.limit?._zod?.def?.checks
    || [];
  for (const c of checks) {
    if ((c?.kind === "max" || c?.type === "max") && Number.isFinite(c.value)) return c.value;
  }
  return null;
}

function unwrapListing(value) {
  // Reddit's `{kind, data}` envelope, and its `{kind: "Listing", children: []}`
  // wrapper. Unwrapping both means the shaper works whether the endpoint hands
  // back Reddit's raw objects or objects it has already flattened, without
  // guessing which, and the test suite covers both forms.
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 2 && "kind" in value && "data" in value && value.data && typeof value.data === "object") {
    return unwrapListing(value.data);
  }
  if (keys.length <= 3 && "children" in value && Array.isArray(value.children)) return value.children;
  return value;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function scoreOf(o) {
  const s = o?.score ?? o?.ups;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function commentish(o) {
  return isPlainObject(o) && ("body" in o || ("parent_id" in o && "id" in o));
}

function prunedComment(o) {
  if (!commentish(o)) return false;
  const b = typeof o.body === "string" ? o.body.trim() : "";
  return o.deleted === true || o.body_removed === true
    || b === "[deleted]" || b === "[removed]"
    || (o.replaced_by_id !== undefined && b === "");
}

// Keep the n highest-scored items, then put them back in the order the endpoint
// returned them. Sorting the survivors by score would quietly override a `sort`
// the caller asked for.
function keepTopByScore(list, n) {
  if (!(n >= 0) || list.length <= n) return list;
  const order = list
    .map((o, i) => [scoreOf(o), i])
    .sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]))
    .slice(0, n)
    .map((x) => x[1])
    .sort((a, b) => a - b);
  return order.map((i) => list[i]);
}

function serializedSize(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

/**
 * Shape one parsed response body.
 *
 * @param {any} root          the parsed JSON body
 * @param {object} opts       the tightened settings for this pass
 * @param {string} toolName   the tool that made the call, for the tree policy
 * @returns {{ value: any, counts: object }}
 */
export function shapeBody(root, opts, toolName) {
  const s = normalizeSettings(opts);
  const counts = {};
  const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  const treeTool = TREE_SET.has(toolName || "");

  // Which budget a string gets: a comment body has its own (smaller) ceiling,
  // other prose fields share `bodyChars`, everything else gets `textChars`.
  const budgetFor = (key) => {
    if (COMMENT_TEXT_SET.has(key)) return s.commentBodyChars;
    if (TEXT_SET.has(key)) return s.bodyChars;
    return s.textChars;
  };

  const str = (value, key) => {
    const budget = budgetFor(key);
    if (value.length <= budget) return value;
    bump(TEXT_SET.has(key) ? "bodies" : "strings");
    // The elision marker carries how much was dropped, in the text itself, so a
    // model reading a truncated body knows it is reading a truncated body.
    return `${value.slice(0, budget)} […${value.length - budget} chars]`;
  };

  const obj = (value, key, depth, commentLevel) => {
    const src = unwrapListing(value);
    if (Array.isArray(src)) return arr(src, key, depth, commentLevel);
    if (depth > s.maxDepth) {
      bump("depth");
      return `[trimmed: nested past depth ${s.maxDepth}]`;
    }
    const out = {};
    for (const [k, v] of Object.entries(src)) {
      if (s.isDropped(k)) { bump("fields"); continue; }
      if (v === null || v === "" || (Array.isArray(v) && v.length === 0)
        || (isPlainObject(v) && Object.keys(v).length === 0)) { bump("empty"); continue; }
      let nv;
      if (typeof v === "string") nv = str(v, k);
      else if (Array.isArray(v) || isPlainObject(v)) nv = walk(v, k, depth + 1, commentLevel);
      else nv = v;
      // The size ceiling is a STRUCTURAL guard: every string has already been
      // bounded by str(), so replacing a string here would trade a truncated
      // answer for "[trimmed]" and lose the answer entirely. Only values with
      // structure -- an object or an array this package has never seen -- get
      // replaced, and the marker names the field and its size. Fields of the
      // response envelope itself (depth 0: `post`, `comments`, `after`) are the
      // answer and are never replaced; the byte ladder governs those, and it
      // gives up whole rows rather than hollowing out the one thing asked for.
      if (depth >= 1 && !ROW_SET.has(k) && (Array.isArray(nv) || isPlainObject(nv))) {
        const size = serializedSize(nv);
        if (size > s.maxFieldBytes) { bump("fields"); nv = `[trimmed ${size} bytes: ${k}]`; }
      }
      if (!ROW_ONLY_SET.has(k) && Array.isArray(nv) && nv.length === 0 && Array.isArray(v) && v.length > 0) {
        // A list this package emptied (replies past the depth ceiling). Carrying
        // an empty array would say "there were none" less honestly than the count
        // in `context` does, and costs 13 bytes on every comment that had them.
        bump("empty");
        continue;
      }
      out[k] = nv;
    }
    return out;
  };

  const arr = (value, key, depth, commentLevel) => {
    let list = value;
    const comments = list.map(unwrapListing).filter(commentish);
    const isCommentList = key !== undefined && COMMENT_LIST_SET.has(key) && comments.length > 0
      && comments.length >= Math.ceil(list.length / 2);
    if (isCommentList) {
      // [deleted] and [removed] carry no answer, and on a moderated thread they
      // are a large share of the bytes. Non-comment entries stay where they are.
      const mapped = list.map(unwrapListing);
      const kept = mapped.filter((o) => !(commentish(o) && prunedComment(o)));
      bump("pruned", mapped.length - kept.length);
      list = kept;
      const isTreeRoot = key === "comments" && treeTool;
      const cap = isTreeRoot ? s.commentsPerPost : s.repliesPerComment;
      if (cap >= 0 && list.length > cap) {
        bump("comments", list.length - cap);
        list = keepTopByScore(list, cap);
      }
      const nextLevel = key === "comments" ? commentLevel : commentLevel + 1;
      if (s.commentDepth >= 0 && nextLevel > s.commentDepth) {
        // `commentDepth` is the number of REPLY levels kept under each kept
        // comment, so a reply at a deeper level is dropped outright. Its parent
        // still shows the reply was there: Reddit's own `reply_count`/`replies`
        // presence is not fabricated here, but the count lands in the context
        // block, so a caller can see the thread was cut and not merely short.
        bump("comments", list.length);
        return [];
      }
      return list.map((o) => obj(o, key, depth + 1, nextLevel));
    }
    let mapped = list.map((o) => walk(o, key, depth + 1, commentLevel));
    if (s.rowCap >= 0 && ROW_SET.has(key) && mapped.length > s.rowCap) {
      bump("rows", mapped.length - s.rowCap);
      mapped = mapped.slice(0, s.rowCap);
    }
    return mapped;
  };

  function walk(value, key, depth, commentLevel) {
    if (Array.isArray(value)) return arr(value, key, depth, commentLevel);
    if (isPlainObject(value)) return obj(value, key, depth, commentLevel);
    if (typeof value === "string") return str(value, key ?? "");
    return value;
  }

  return { value: walk(root, undefined, 0, 0), counts };
}

/**
 * Build the compactor one server uses.
 *
 * @param {object} settings  COMPACT_DEFAULTS-shaped overrides (already parsed
 *                           out of the environment by the entry point, or handed
 *                           in directly by a host embedding createServer)
 */
export function createCompactor(settings = {}) {
  const s = normalizeSettings(settings);
  // A zod schema drives the shape of the response the model asked for, so a
  // defaulted `limit` must also stay inside what the endpoint accepts.
  const clampLimit = (tool, n) => {
    const ceiling = limitCeiling(tool);
    return ceiling ? Math.min(n, ceiling) : n;
  };

  return {
    settings: s,

    /**
     * Supply `limit` for a read that did not ask for one. Returns the args to
     * send and what was defaulted, so the response can say so.
     */
    applyDefaultLimit(tool, args) {
      if (s.raw || s.defaultLimit <= 0 || !isCompactedRead(tool)) return { args, defaulted: null };
      if (!tool.shape || !("limit" in tool.shape)) return { args, defaulted: null };
      if (args && args.limit !== undefined && args.limit !== null) return { args, defaulted: null };
      // The tool's own default, when the catalog declares one (it is a fact about
      // that endpoint, not a global number), else the server-wide number.
      const wanted = clampLimit(tool, Number(tool.defaultLimit ?? s.defaultLimit));
      if (!(wanted > 0)) return { args, defaulted: null };
      return { args: { ...(args || {}), limit: wanted }, defaulted: wanted };
    },

    /**
     * Shape an MCP result on its way out. Returns the result unchanged when the
     * tool is not a compacted read, when `raw` is set, or when the body was
     * already inside the budget with nothing to cut.
     */
    compactResult(tool, result, extras = {}) {
      if (s.raw || !isCompactedRead(tool) || !result || result.isError) return result;
      const text = result?.content?.[0]?.text;
      if (typeof text !== "string" || text.length === 0) return result;

      const sourceBytes = Buffer.byteLength(text);
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON (an upstream proxy page on a 200, most often). The only safe
        // action is a hard character ceiling, said out loud.
        if (text.length <= s.maxBytes) return result;
        return {
          content: [{ type: "text", text: `${text.slice(0, s.maxBytes)}\n[…${text.length - s.maxBytes} chars dropped by the REDDITAPIS_MCP_MAX_BYTES ceiling]` }],
        };
      }

      // The `context` block is part of what the client pays for, so the ladder
      // aims below the budget by its size rather than fitting the rows and then
      // overflowing with the block that explains the fitting.
      const CONTEXT_RESERVE = 420;
      const target = Math.max(96, s.maxBytes - CONTEXT_RESERVE);
      let best = null;
      for (let i = 0; i < BUDGET_LADDER.length; i++) {
        const opts = Object.assign({}, s, ...BUDGET_LADDER.slice(0, i + 1));
        const shaped = shapeBody(parsed, opts, tool.name);
        const body = shaped.value && typeof shaped.value === "object" && !Array.isArray(shaped.value)
          ? shaped.value
          : { result: shaped.value };
        best = {
          value: { ...body },
          counts: shaped.counts,
          trimmed: Object.fromEntries(Object.entries(shaped.counts).filter(([, c]) => c > 0)),
          opts,
          ladderStep: i,
        };
        // Tighten only while still over target, and never past the last rung.
        if (serializedSize(best.value) <= target || i === BUDGET_LADDER.length - 1) break;
      }

      const trimmedKeys = Object.keys(best.trimmed);
      const added = trimmedKeys.length > 0 || best.opts.rowCap !== undefined || Number.isFinite(extras.defaultedLimit);
      if (!added && sourceBytes <= s.maxBytes) return result;

      const context = {};
      context.source_bytes = sourceBytes;
      if (Number.isFinite(extras.defaultedLimit)) context.limit_defaulted = extras.defaultedLimit;
      if (trimmedKeys.length) context.trimmed = best.trimmed;
      if (best.ladderStep > 0) context.tightened_to = best.ladderStep;
      context.budget_bytes = s.maxBytes;
      if (trimmedKeys.length) context.how_to_widen = "raise `limit`, page with `after`, or set REDDITAPIS_MCP_RAW=1 for the untrimmed body";

      // `context` is this package's block. If an endpoint ever answers with a
      // field of its own called `context`, ours goes beside it under `_context`
      // rather than over it -- an upstream field is never silently replaced.
      const ctxKey = isPlainObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "context") ? "_context" : "context";
      const envelope = { ...best.value, [ctxKey]: context };
      let outText = JSON.stringify(envelope);

      // Belt and braces: a body where every rung of the ladder still overflows
      // (a tiny budget, or one enormous row). Rows go from the END until the text
      // fits, and at least one row is kept: an empty answer that says why is a
      // worse answer than one row that says it is one row.
      const ceiling = () => s.maxBytes;
      if (outText.length > ceiling()) {
        const fits = () => JSON.stringify(envelope).length <= ceiling();
        while (!fits()) {
          const arrays = Object.entries(envelope).filter(([k, v]) => Array.isArray(v) && v.length > 1);
          if (!arrays.length) break;
          arrays.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
          arrays[0][1].pop();
          context.rows_dropped_to_fit = (context.rows_dropped_to_fit || 0) + 1;
        }
        if (!fits()) {
          context.over_budget = true;
          context.note = `one row is larger than the ${s.maxBytes}-byte budget; it is returned in its tightest form`;
        }
        outText = JSON.stringify(envelope);
      }

      // Then stamp the sizes. `bytes` and `est_tokens` change the length of the
      // text they describe, so this is iterated to a fixed point rather than
      // reported from a serialization that no longer matches what is returned.
      for (let i = 0; i < 4; i++) {
        const len = Buffer.byteLength(outText);
        if (context.bytes === len) break;
        context.bytes = len;
        context.est_tokens = Math.ceil(len / 4);
        outText = JSON.stringify(envelope);
      }

      return { ...result, content: [{ type: "text", text: outText }] };
    },
  };
}

