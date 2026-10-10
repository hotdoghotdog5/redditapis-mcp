// Tool catalog + pure query/path builders for redditapis-mcp.
// Kept separate from the server wiring (index.js) so it can be unit-tested
// without spawning the stdio transport.
//
// Each tool maps 1:1 to a REST endpoint at https://api.redditapis.com/api/reddit.
// Tool arg names map 1:1 to endpoint query params, EXCEPT path params written as
// {name}/{id} in a tool's `path` (e.g. /api/reddit/sub/{name}/top), which are
// interpolated into the URL and removed from the query string.
//
// WRITES: reddit writes (comment/vote/DM -- posting AS the customer to Reddit
// itself) are a separate authenticated surface and remain intentionally out of
// scope here, that boundary is unchanged. Monitor/webhook management (2026-08-11,
// task #43) is a DIFFERENT kind of write: it configures the customer's OWN
// redditapis.com account (an alerting subscription), the same risk class as
// reading their own usage -- it never posts, votes, or DMs anywhere. Those tools
// are marked `write: true` (and `destructive: true` for remove/delete), which
// index.js turns into MCP's `readOnlyHint`/`destructiveHint` annotations so a
// client can surface a confirmation before calling them.
//
// BODY-BEARING TOOLS: a POST tool's args become a JSON request body instead of
// a query string (see buildBody below). `filterSpecFields` on a tool declares
// which of its args nest under `filter_spec` in that body; everything else in
// `shape` stays top-level (id, cadence_s, active, url, kind, ...).
//
// LOCAL TOOLS (2026-09-04): a tool carrying `local: "<handler>"` is dispatched
// by index.js to a handler in this package instead of straight to the API.
// Args flagged in `localArgs` are consumed locally and never sent. Today the
// only such tool is reddit_feedback_send, whose draft queue lives on disk in
// src/feedback.js and whose POST to /feedback happens only on the user's say.
// index.js refuses to boot if a catalog entry names a handler it lacks, so a
// `local` tag can never turn into a silent passthrough with the local args
// attached.
//
// PUBLIC MOUNTS: every tool path is under /api/reddit/ EXCEPT the feedback
// pair, which the API serves un-prefixed (api.redditapis.com/feedback) because
// it is mounted outside the metered /api surface, like /account. The catalog
// test pins the allowed prefixes so a typo cannot invent a third one.
import { z } from "zod";

// Shared Zod input-schema fragments.
//
// WHY THE `limit` SENTENCE NOW MENTIONS A DEFAULT OF 10. The endpoint's own
// default is 25 (pinned in docs.redditapis.com/openapi.json as limit=25 for
// /api/reddit/posts and /api/reddit/search), and an MCP result is put back into
// the model's context on the next turn, so the default a browser wants is the
// wrong default here. src/compact.js therefore sends `limit=10` when the caller
// omitted one, and REDDITAPIS_MCP_DEFAULT_LIMIT changes or disables it. The
// number is stated in the description because a caller reading the schema is the
// only place a caller learns that the page it got was chosen for it.
const LIMIT = {
  limit: z.number().int().min(1).max(100).optional().describe(
    "Maximum items returned, 1 to 100. The API clamps out-of-range values. When this is omitted the server sends 10, not the endpoint's own default of 25: a smaller opening page costs the same credits and fits the model's context, and `after` gets the rest. A larger page is available here, and the server caps the bytes of any one result, so a large `limit` trims rows rather than overflowing the conversation.",
  ),
};
// Shared by every listing and search tool, so the rule about what an EMPTY
// cursor means is stated once rather than pasted into a dozen tool descriptions
// where one of them would eventually be missed.
const AFTER = {
  after: z.string().optional().describe(
    "Opaque pagination cursor: the previous response's `after` value, exactly as it was returned. The format is not stable, and a hand-written Reddit fullname loses the paging depth the cursor carries. Absent on the opening page. " +
      "A null `after` on a response means there is no next page; it does not by itself mean the listing is complete, because Reddit often stops serving a busy listing long before it runs out. That final response carries `listing_status`: `complete`, `truncated` or `unknown`, and only `complete` means nothing is missing.",
  ),
};
// Sort vocabularies differ by endpoint (they map to different Reddit listings):
// posts/listings, search, and user-comments each accept a distinct set.
const SORT_POSTS = {
  sort: z.enum(["new", "hot", "top", "rising", "controversial", "best"]).optional().describe(
    "Sort order for a subreddit listing. 'hot' = trending now, 'new' = most recent (default), 'top' = highest score in the `t` window, 'rising' = gaining fast, 'controversial' = polarizing, 'best' = Reddit's blended rank.",
  ),
};
const SORT_SEARCH = {
  sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional().describe(
    "Sort order for search. 'relevance' = best match (default), 'top' = highest score in the `t` window, 'new' = most recent, 'hot' = trending, 'comments' = most-discussed. Only 'relevance' weights how well a post matches; 'top', 'new' and 'comments' rank every loosely-matching post by that one number, so on a site-wide generic query 'top' returns viral posts that barely mention the terms. A quoted phrase or a `subreddit` scope narrows the matching set itself.",
  ),
};
const SORT_USER = {
  sort: z.enum(["new", "hot", "top", "controversial"]).optional().describe(
    "Sort order for a user's comments. 'new' = most recent (default), 'hot', 'top' (in the `t` window), 'controversial'.",
  ),
};
const TIME = {
  t: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe(
    "Time window, only applied when sort is 'top' or 'controversial'. E.g. 'week' = top of the past week. Ignored for other sorts.",
  ),
};
// Search honours `t` differently from a subreddit listing: it bounds the whole
// result set (including the 'relevance' and 'top' sorts), not just top/controversial.
// Omitting it makes Reddit default to 'all', which lets old high-upvote posts win a
// broad 'relevance' query, so search gets a separate, search-accurate description.
const TIME_SEARCH = {
  t: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe(
    "Time window that bounds which posts the search returns, e.g. 'week' = only posts from the past week. Unlike a subreddit listing, search applies this to the 'relevance' and 'top' sorts too. When omitted, Reddit defaults to 'all', so a broad 'relevance' query surfaces old high-upvote posts that only loosely match; 'week' or 'month' keeps results recent and on topic.",
  ),
};
const NSFW = {
  nsfw: z.enum(["true", "false"]).optional().describe(
    "'true' includes over-18 / NSFW results; 'false' or omitted excludes them (default).",
  ),
};
const QUERY = {
  q: z.string().min(1).describe(
    "Search query text. Supports Reddit search syntax (e.g. `subreddit:webdev`, `author:spez`, `\"exact phrase\"`, `title:...`).",
  ),
};
// Auth-scoped private-listing cookie fragment (upvoted/saved/hidden/gilded).
// These four are READS, but of PRIVATE data Reddit only serves to the account
// that owns it, so -- unlike every other read tool above -- they need the
// caller's own Reddit session cookies, obtained from POST /api/reddit/login
// (a REST call, not an MCP tool here). GET can't carry cookies as a body, so
// they travel as flat query-string args, same convention routes/vote.js uses
// for its flat POST-body cookie fields.
const LISTING_COOKIES = {
  reddit_session: z.string().min(1).describe(
    "The Reddit account's session cookie, as returned by POST /api/reddit/login on the REST API (a REST call, not an MCP tool). Required.",
  ),
  loid: z.string().min(1).describe(
    "Reddit account loid cookie, from the same POST /api/reddit/login response. Required.",
  ),
  csrf_token: z.string().optional().describe(
    "Reddit CSRF cookie, from the same login response. Optional: a read is accepted without it (CSRF only guards state-changing calls).",
  ),
};

// The SESSION-HEADER form of the same thing, for tools that declare
// `sessionHeaders: true`. Identical fields, different transport: buildHeaders
// lifts these onto x-reddit-* headers instead of the query string, because a
// session cookie in a URL ends up in every log along the path. LISTING_COOKIES
// above stays as it is; the four tools using it ship with the query form and
// changing what they put on the wire would be a behaviour change nobody asked
// for. The REST API accepts both.
const SESSION_HEADERS_REQUIRED = {
  reddit_session: z.string().min(1).describe(
    "The caller's Reddit session cookie, from POST /api/reddit/login on the REST API (a REST call, not an MCP tool). Sent as a request header, not in the URL. Required.",
  ),
  loid: z.string().min(1).describe(
    "The caller's Reddit loid cookie, from the same login response. Required, together with the session cookie.",
  ),
  token_v2: z.string().optional().describe(
    "The caller's Reddit token_v2 cookie, from the same login response. Optional.",
  ),
  proxy: z.string().optional().describe(
    "Optional proxy this read egresses through, so the request reaches Reddit from the IP this account normally acts from. http://user:pass@host:port or host:port. Pinned across retries.",
  ),
};

// ── monitoring filter_spec fragments, shared by monitor_add and monitor_update ──
// v1 is SUBREDDIT-SCOPED ONLY (all-Reddit keyword monitoring is not available),
// matching apps/api/src/lib/monitor-filter.js's own validation exactly, so a
// tool call fails fast in the client rather than round-tripping a 400.
//
// THE "POSTS ONLY" HALF OF THIS COMMENT WAS STALE AND COST A REAL GAP. It said
// comment monitoring was "validated but rejected server-side", which stopped
// being true when comment monitoring shipped (migrations 009/010, PRs
// #532/#537/#541). Because `kind` was never added here, the capability was
// unreachable from MCP entirely: verified live 2026-08-13 by setting
// filter_spec.kind="both" over raw REST and watching real comment deliveries
// land within two minutes, on a tier the pricing page sells as "posts and
// comments". A stale comment is a defect report, not documentation.
// SITEWIDE (2026-08-13). `subreddit` is OPTIONAL now: omit it and pass `q` to
// watch ALL of Reddit for that keyword. Leaving it required here would repeat
// the exact failure the comment above describes -- a shipped, sold capability
// that no MCP client can reach because one schema field was never relaxed,
// with nothing anywhere reporting an error.
const MONITOR_SUBREDDIT_DESC =
  "Subreddits to watch, without the r/ prefix (e.g. ['SaaS', 'startups']). 1 to 50. " +
  "Absent, with `q` set, the monitor watches ALL of Reddit for that keyword. A monitor is anchored by a " +
  "subreddit list, a keyword or both; a request with neither is refused. ['all'] is refused with 400 " +
  "subreddit_reserved, because r/all is Reddit's site-wide listing rather than a subreddit. Sitewide " +
  "monitors are capped per plan tier (the `slots` object in the monitor list) and cover POSTS only.";
const MONITOR_SUBREDDIT = {
  subreddit: z.array(z.string().min(1)).min(1).max(50).optional().describe(MONITOR_SUBREDDIT_DESC),
};
const MONITOR_FILTER_FIELDS = {
  // SITEWIDE ONLY BY DESIGN, and the description says so in the first clause
  // because an agent that passes it alongside `subreddit` gets a 400 and needs
  // to know from the schema, not from the error, which of the two to drop.
  exclude_subreddits: z.array(z.string().min(1)).max(50).optional().describe(
    "Subreddits to SUPPRESS, without the r/ prefix (e.g. ['politics', 'AskReddit']). SITEWIDE MONITORS ONLY: accepted when `subreddit` is absent and `q` anchors the monitor; sent together with `subreddit` it is rejected with a field-level 400. Up to 50, matched exactly like `subreddit`, so 'r/Politics', '/r/politics' and 'politics' are one entry. This is the noise control for an all-of-Reddit keyword watch. It filters DELIVERY only: it does not change what is polled, free quota, or affect matching in any other subreddit. Independent of exclude_terms; an item is dropped if either fires.",
  ),
  q: z.string().max(200).optional().describe(
    "Free-text keyword or phrase to match, against the fields in `search_in` (default title+body+url). Absent, every new post in the watched subreddits matches.",
  ),
  author: z.string().max(200).optional().describe("Matches only posts by this Reddit username (without u/)."),
  exclude_terms: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "Posts containing any of these terms are suppressed even when they otherwise match, e.g. 'giveaway' excluded from a brand-mention monitor.",
  ),
  domain: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "Outbound link domains to watch for (e.g. ['example.com']). Matches the post's link URL, any URL inside a self-post/comment body, and a crosspost's original link, including one that only appeared in the original post's body. Exact-or-subdomain match only: 'example.com' matches 'blog.example.com' but not 'notexample.com'. Shortened links (bit.ly, t.co) are not resolved.",
  ),
  include_any: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "A post qualifies when at least ONE of these terms appears (OR match), on top of any `q`."
  ),
  include_all: z.array(z.string().min(1).max(200)).max(50).optional().describe(
    "A post qualifies only when EVERY one of these terms appears (AND match), on top of any `q`."
  ),
  search_in: z.array(z.enum(["title", "body", "url", "permalink"])).min(1).optional().describe(
    "Which fields keyword/term matching is scoped to. Default ['title', 'body', 'url']. A narrower scope avoids false positives, e.g. a term that only appears in a URL slug matching a post that does not mention it in prose. All four resolve on comments as well as posts: on a comment, 'title' matches the title of the THREAD the comment sits under (a comment has no title of its own), which also applies through the default scope and can deliver every comment under a busy matching thread. ['body'] limits comment matches to comments that contain the term themselves.",
  ),
  group: z.string().max(64).optional().describe(
    "Optional label that bundles multiple matches into one delivery in place of one webhook call per match. Absent, each matching item is its own delivery.",
  ),
  kind: z.enum(["post", "comment", "both"]).optional().describe(
    "What to watch in the named subreddits: 'post' (default when omitted), 'comment', or 'both'. Comment monitoring requires a Growth, Pro or Scale plan; on a lower tier this returns `comment_monitoring_requires_higher_tier` (402). Comments run roughly 7x the volume of posts, so deliveries rise proportionally; the daily delivery ceiling per monitor is reported by monitor health.",
  ),
  min_score: z.number().int().optional().describe("Matches only posts with at least this many upvotes."),
  min_relevance: z.number().int().min(0).max(100).optional().describe(
    "AI relevance floor, 0-100. 0 (the default) is off. Above 0, every match is scored by a language model against this monitor's own keywords and anything below the floor is NOT delivered: it is recorded in the delivery history with status 'suppressed' and reason 'low_relevance', carrying its score and a one-line explanation, so what was filtered, and why, stays readable. Nothing is silently discarded. Rough calibration: 80-100 squarely on topic, 50-79 related but peripheral, 20-49 tangential, 0-19 the keyword is used in an unrelated sense. The comparison is inclusive, so a score equal to the floor is delivered. If scoring is unavailable the match is delivered UNSCORED rather than withheld. Requires a Growth, Pro or Scale plan; on a lower tier this returns `ai_relevance_requires_higher_tier` (402). REJECTED with a field-level 400 on a monitor that has no q, include_any or include_all, because there would be no topic to score an item against and the floor could only admit everything.",
  ),
  nsfw: z.boolean().optional().describe("false EXCLUDES NSFW/over-18 posts. Omitted or true both let NSFW through; there is no exclude-by-default, and only an explicit false filters it. POSTS ONLY: nsfw=false is REJECTED with a field-level 400 when kind is 'comment' or 'both', because Reddit flags NSFW on a post and not on an individual comment, so there is no field to filter a comment on. NSFW filtering is available on kind='post' monitors, and exclude_terms filters comment text."),
};
// Per-monitor webhook targeting (task #66, migration 009). NOT a filter_spec
// field -- stays top-level in the request body, same as cadence_s/active, so
// it is deliberately absent from MONITOR_FILTER_FIELDS/filterSpecFields.
const MONITOR_WEBHOOK_IDS = {
  webhook_ids: z.array(z.string().min(1)).max(20).optional().describe(
    "Webhook ids that restrict this monitor's delivery to those webhooks. Omitted or an empty array means the default: delivery to every active webhook on the account. An id that is not a webhook on this account returns `webhook_not_found` (400).",
  ),
};
const MONITOR_ID = {
  id: z.string().min(1).describe("The monitor's id, as returned when the monitor was created or listed."),
};
const WEBHOOK_ID = {
  id: z.string().min(1).describe("The webhook's id, as returned when the webhook was created or listed."),
};

// The tool catalog. Path params are {name}/{id} placeholders. Monitor/webhook
// tools additionally carry `write`/`destructive` and, for POST tools whose
// body nests a filter_spec, `filterSpecFields` (see buildBody below).
export const TOOLS = [
  {
    name: "reddit_subreddit_posts",
    path: "/api/reddit/posts",
    description:
      "Lists posts from a subreddit by sort order: newest, hot, top of a time window, rising, controversial or best. Returns post title, author, score, comment count, and permalink, plus an `after` cursor for paging. When `after` comes back null the response carries `listing_status`: `complete` means no older posts and is only claimed when the whole run came back in under one page, `truncated` means Reddit's cap cut the listing off, and `unknown` means completeness could not be established. A busy feed that Reddit stops serving reports `unknown`, not `complete`. Example: subreddit='programming' sort='top' t='week'.",
    shape: {
      subreddit: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'programming', 'AskReddit'). Required.",
      ),
      ...SORT_POSTS,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_verify_comments",
    path: "/api/reddit/comments/verify",
    method: "POST",
    description:
      "Checks whether specific Reddit comments still EXIST and are publicly visible, in one batch of up to 100 ids. A READ despite being a POST (ids travel in the body because a hundred of them exceed a URL's length); it costs the same as any other read and changes nothing on Reddit. It distinguishes 'deleted by the author', 'removed by a moderator' and 'still there', which a normal comment fetch cannot. Accepts bare ids and t1_-prefixed fullnames interchangeably. Returns one row per id, in request order, each with a status. Example: ids=['n5abcde','t1_n5fghij'].",
    shape: {
      ids: z.array(z.string().min(1)).min(1).max(100).describe(
        "Comment ids to check, 1 to 100 per call. Bare id ('n5abcde') or fullname ('t1_n5abcde'), mixed freely. Reddit's own batch lookup caps at 100 per call. Required.",
      ),
    },
  },
  {
    name: "reddit_home_feed",
    path: "/api/reddit/feed",
    sessionHeaders: true,
    description:
      "Reads the caller's own Reddit home feed, the front page their subscriptions produce. The other read tools are served from a shared pool of accounts and so cannot return a personal feed; this one sends the caller's session. Requires the caller's Reddit session cookies (session and loid) from POST /api/reddit/login on the REST API, which is not an MCP tool. Without them it returns 400, because Reddit's logged-out front page is a different feed belonging to nobody rather than a thinner version of the caller's. Same post shape and `after` cursor as the subreddit listing. Example: sort='best' limit=25.",
    shape: {
      ...SESSION_HEADERS_REQUIRED,
      sort: z.enum(["best", "hot", "new", "top", "rising", "controversial"]).optional().describe(
        "Feed sort. 'best' (default) is Reddit's own logged-in home sort. 'top'/'controversial' also take `t`.",
      ),
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_search",
    path: "/api/reddit/search",
    description:
      "Searches Reddit posts across all of Reddit or within one subreddit. Returns matching posts with author, score, comments, permalink, and an `after` cursor. `subreddit` scopes the search to one community. Optional advanced filters narrow the results by minimum/maximum score, comment count, media type, and post flags, with an optional re-sort of the page. Filters apply to the returned page, so a filtered response carries a `meta` object with page-completeness counts, and the next page comes from `after`. SORT BEHAVIOUR, measured 2026-09-11: `top`, `new` and `comments` order the MATCHING set by score, date or comment count alone, and Reddit matches loosely (image OCR, comments, and the word 'reddit' is in almost every big post), so a generic multi-word query with sort='top' and no subreddit returns the site-wide viral listing, not the topic. Even a distinctive term is ranked by score alone (q='pgvector' sort='top': 1 of 5 results was about pgvector, the rest were large posts that mention it once). Best match then highest score comes from sort='relevance' with a large `limit`, where sort_type='score' re-orders that returned page (it does not reach past the page); a quoted phrase (q='\"rust vs go\"') or a `subreddit` scope also narrows the matching set. Example: q='rust vs go' sort='relevance' t='year' limit=100 sort_type='score'.",
    shape: {
      ...QUERY,
      subreddit: z.string().optional().describe(
        "Optional subreddit name (without r/) that restricts the search to one community. Absent, the search covers all of Reddit.",
      ),
      ...SORT_SEARCH,
      ...TIME_SEARCH,
      ...AFTER,
      ...NSFW,
      ...LIMIT,
      min_score: z.number().int().optional().describe("Keeps only posts with score >= this (applied to the returned page)."),
      max_score: z.number().int().optional().describe("Keeps only posts with score <= this."),
      min_comments: z.number().int().optional().describe("Keeps only posts with comment count >= this."),
      max_comments: z.number().int().optional().describe("Keeps only posts with comment count <= this."),
      is_video: z.boolean().optional().describe("true = only video posts, false = only non-video."),
      is_self: z.boolean().optional().describe("true = only self/text posts, false = only link posts."),
      over_18: z.boolean().optional().describe("Filters the page by NSFW flag (distinct from nsfw, which controls inclusion in the search)."),
      locked: z.boolean().optional().describe("Filters by the locked flag."),
      stickied: z.boolean().optional().describe("Filters by the stickied flag."),
      spoiler: z.boolean().optional().describe("Filters by the spoiler flag."),
      contest_mode: z.boolean().optional().describe("Filters by the contest_mode flag."),
      sort_type: z.enum(["score", "num_comments", "created"]).optional().describe("Re-sorts the filtered page (descending) by this field. Page-local: it re-orders only the posts this call returned, not the whole result set, so its reach is bounded by `limit`."),
    },
  },
  {
    name: "reddit_post_visibility",
    path: "/api/reddit/post/{id}/visibility",
    description:
      "Is a post still publicly visible, or did it quietly stop being so? A removed Reddit post still returns when fetched by id, so the post alone does not answer this. This fetches the post and then one page of its author's submitted listing and compares them. Returns a verdict of live, not_visible or undecidable, a plain-language reason, and a confident flag. By design it does not say WHY a post is not visible: a moderator removal, an admin removal, a spam filter and an author who has hidden their history are indistinguishable from outside. undecidable is a real answer, not a failure. Two upstream calls, billed as one $0.004 dual read.",
    shape: {
      id: z.string().min(1).describe("Reddit post id, base36, with or without the t3_ prefix"),
    },
  },
  {
    name: "reddit_post_comments",
    path: "/api/reddit/comments",
    description:
      "Fetches a single post and its comment tree by permalink. Returns the post plus threaded comments (author, body, score, replies) and an `after` cursor. The `permalink` is the one carried by any post result.",
    shape: {
      permalink: z.string().min(1).describe(
        "The post permalink path from a prior post result, e.g. '/r/programming/comments/abc123/some_title/'. Required.",
      ),
    },
  },
  {
    name: "reddit_search_communities",
    path: "/api/reddit/search/communities",
    description:
      "Searches for subreddits (communities) by name or topic. Returns matching subreddits with title, subscriber count, description, and NSFW flag. Example: q='machine learning'.",
    shape: { ...QUERY, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_search_comments",
    path: "/api/reddit/search/comments",
    description:
      "Searches Reddit by COMMENT text. Reddit's comment search matches the keyword against comment bodies but returns the PARENT POSTS, not the individual comments, so each result is a post whose discussion mentions the query, carrying that post's title, selftext, score, and comment count. It surfaces threads where a topic comes up in the replies, which a post-title search misses. Reddit does not expose which specific comment matched or its text, so the results are posts, not comment bodies. Example: q='best mechanical keyboard' sort='relevance' t='year'.",
    shape: { ...QUERY, ...SORT_SEARCH, ...TIME_SEARCH, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_deep_comment_search",
    path: "/api/reddit/search/comments/deep",
    // Pinned to the endpoint's own default on purpose: this is the one read that
    // bills for fan-out ($0.02 because each parent post is a separate upstream
    // read), so a context default must never RAISE it. See src/compact.js.
    defaultLimit: 5,
    description:
      "Comment search that returns the ACTUAL comments whose body matches the keyword, sorted by score (highest first), with body, score, author, a comment-deep permalink, and the parent post. It fetches each matching post's comment tree and filters the comment bodies, so the results are first-hand opinions and answers rather than parent posts. Premium call (it fans out into several reads): `limit` sets how many parent POSTS to expand, 1-25 (default 5), not how many comments come back. The response's `after` cursor expands the NEXT batch of parent posts. `max_comments` optionally caps how many comments come back (the top-scored are kept). Matching is on the visible comment text at word boundaries (link URLs are ignored), so every result mentions the query where a reader can see it. Best-effort: a deleted or deeply-nested comment may be missed (meta.truncated flags when a tree was too deep). group_by='author' switches to a research mode that returns WHO is talking about the query (distinct people ranked by matching-comment count) in place of a flat comment list, capped by max_authors. Example: q='best mechanical keyboard' sort='relevance' t='year'.",
    shape: {
      ...QUERY,
      ...SORT_SEARCH,
      ...TIME_SEARCH,
      ...NSFW,
      ...AFTER,
      limit: z.number().int().min(1).max(25).optional().describe(
        "Number of parent POSTS to expand into their comment trees (1-25, default 5). Each is one upstream read, so higher = deeper coverage but slower and more expensive. Beyond 25, the `after` cursor pages to the next batch.",
      ),
      max_comments: z.number().int().min(1).optional().describe(
        "Optional cap on how many comments are returned; the highest-scored are kept. Absent, every match is returned. meta.capped is true when this trimmed the result.",
      ),
      group_by: z.enum(["author"]).optional().describe(
        "'author' selects the RESEARCH mode: the distinct PEOPLE who mentioned the query, ranked by how many of their comments matched (then total score), in place of a flat comment list. Each author has comment_count, total_score, the subreddits they matched in, and their top comment. Absent, the normal comment list is returned.",
      ),
      max_authors: z.number().int().min(1).optional().describe(
        "Applies only with group_by='author'. Optional cap on how many people are returned (the most prolific first). Absent, every author is returned. meta.authors_capped is true when this trimmed the list.",
      ),
    },
  },
  {
    name: "reddit_search_media",
    path: "/api/reddit/search/media",
    description:
      "Searches Reddit posts filtered to media (images, video, gifs). Returns media posts with the media URL/type, author, score, and the post url. `kind` narrows the results to one media type. Example: q='aurora borealis' kind='image'.",
    shape: {
      ...QUERY,
      kind: z.enum(["image", "video", "gif", "all"]).optional().describe(
        "Media type filter. 'image', 'video', 'gif', or 'all' (default). Filters the raw Reddit results to that media kind.",
      ),
      ...SORT_SEARCH,
      ...TIME_SEARCH,
      ...AFTER,
      ...NSFW,
      ...LIMIT,
    },
  },
  {
    name: "reddit_search_users",
    path: "/api/reddit/search/users",
    description:
      "Searches for Reddit users (redditors) by name or keyword. Returns matching accounts with username, karma, and account age. Example: q='spez'.",
    shape: { ...QUERY, ...AFTER, ...NSFW, ...LIMIT },
  },
  {
    name: "reddit_subreddit_top",
    path: "/api/reddit/sub/{name}/top",
    description:
      "Gets the TOP posts of a subreddit for a time window, the highest-scoring posts of a community. Returns posts with score, author, comments, and permalink plus an `after` cursor. Example: name='science' t='month'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'science'). Required (path parameter).",
      ),
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_post",
    path: "/api/reddit/post/{id}",
    description:
      "Fetches a single Reddit post by its id. Returns the full post object (title, author, score, text, permalink, subreddit, url). Example: id='abc123' (the base-36 id, no t3_ prefix).",
    shape: {
      id: z.string().min(1).describe(
        "The post's base-36 id (e.g. 'abc123'), without the 't3_' fullname prefix. Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_user_profile",
    path: "/api/reddit/user/{name}",
    description:
      "Fetches a Reddit user's public profile by username. Returns account info: username, id, karma (post + comment), account age, verified/employee flags, and avatar. Example: name='spez'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_user_achievements",
    path: "/api/reddit/user/{name}/achievements",
    description:
      "Lists a Reddit user's public achievements, the trophies shown on their reddit.com/user/<name>/achievements page. Returns each achievement's name, description, granted timestamp and icons, plus a count. An account with none returns an empty list rather than an error, so a zero count is a real answer. Achievements such as One-Year Club and Verified Email reflect account age and standing. Example: name='spez'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_user_comments",
    path: "/api/reddit/user/{name}/comments",
    description:
      "Lists a Reddit user's recent comments. Returns comments with body, score, subreddit, parent link, and timestamp plus an `after` cursor. Example: name='spez' sort='top'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
      ...SORT_USER,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_submitted",
    path: "/api/reddit/user/{name}/submitted",
    description:
      "Lists a Reddit user's submitted POSTS (their post history, as distinct from their comments). Returns posts with title, author, score, comment count, and permalink, plus an `after` cursor. Example: name='spez' sort='top'.",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix (e.g. 'spez'). Required (path parameter).",
      ),
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_upvoted",
    path: "/api/reddit/user/{name}/upvoted",
    description:
      "Lists the posts and comments a Reddit account has UPVOTED. PRIVATE data: Reddit serves it only to the account that owns it, so the request carries that account's Reddit session cookies (the session and loid arguments, from POST /api/reddit/login on the REST API, which is not an MCP tool) and returns 403 when `name` is a different account. Mixed listing: each item is a post or a comment, tagged `kind`. Example: name='spez' (the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix: the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_saved",
    path: "/api/reddit/user/{name}/saved",
    description:
      "Lists the posts and comments a Reddit account has SAVED. PRIVATE data: Reddit serves it only to the account that owns it, so the request carries that account's Reddit session cookies (the session and loid arguments, from POST /api/reddit/login on the REST API, which is not an MCP tool) and returns 403 when `name` is a different account. Mixed listing: each item is a post or a comment, tagged `kind`. Example: name='spez' (the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix: the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_hidden",
    path: "/api/reddit/user/{name}/hidden",
    description:
      "Lists the posts and comments a Reddit account has HIDDEN. PRIVATE data: Reddit serves it only to the account that owns it, so the request carries that account's Reddit session cookies (the session and loid arguments, from POST /api/reddit/login on the REST API, which is not an MCP tool) and returns 403 when `name` is a different account. Mixed listing: each item is a post or a comment, tagged `kind`. Example: name='spez' (the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix: the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_user_gilded",
    path: "/api/reddit/user/{name}/gilded",
    description:
      "Lists the posts and comments a Reddit account has received an award (gold) on. PRIVATE data: Reddit serves it only to the account that owns it, so the request carries that account's Reddit session cookies (the session and loid arguments, from POST /api/reddit/login on the REST API, which is not an MCP tool) and returns 403 when `name` is a different account. Mixed listing: each item is a post or a comment, tagged `kind`. Example: name='spez' (the logged-in account).",
    shape: {
      name: z.string().min(1).describe(
        "Reddit username WITHOUT the u/ prefix: the SAME account the supplied cookies belong to, or Reddit returns 403. Required (path parameter).",
      ),
      ...LISTING_COOKIES,
      ...SORT_USER,
      ...TIME,
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_subreddit_comments",
    path: "/api/reddit/sub/{name}/comments",
    description:
      "Streams the NEWEST comments across an entire subreddit (Reddit's /r/<name>/comments feed), not one post's thread. Returns comments with body, author, score, subreddit, the parent post link, and timestamp, plus an `after` cursor. Repeated calls surface new comments in a community as they are posted. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
      ...AFTER,
      ...LIMIT,
    },
  },
  {
    name: "reddit_subreddit_about",
    path: "/api/reddit/sub/{name}/about",
    description:
      "Fetches a subreddit's public metadata by name (Reddit's /r/<name>/about data). Returns the subreddit's title, public description, subscriber count, active-user count, creation timestamp, type, and NSFW flag. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddit_rules",
    path: "/api/reddit/sub/{name}/rules",
    description:
      "Fetches a subreddit's posting rules by name (Reddit's /r/<name>/about/rules data). Returns a `rules` list, each with name, description, what it applies to (posts, comments, or all), violation reason, priority, and creation date, plus a `site_rules` list of Reddit's site-wide rules. Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddit_moderators",
    path: "/api/reddit/sub/{name}/moderators",
    description:
      "Fetches a subreddit's moderator team by name (Reddit's /r/<name>/about/moderators data). Returns a `moderators` list, each with `name`, `id`, `mod_permissions`, `flair_text`, and `added` (when they joined the mod team). Example: name='python'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddit_wiki",
    path: "/api/reddit/sub/{name}/wiki/{page}",
    description:
      "Fetches a subreddit's wiki page by name and page (Reddit's /r/<name>/wiki/<page> data). Returns a single object with `content_md` and `content_html`, a `may_revise` flag, and the last revision (`revision_id`, `revision_date`, `revised_by`, `reason`). A wiki commonly holds a community's rules or FAQ. The page may be multi-segment, for example index, rules, or config/sidebar. Example: name='python', page='index'.",
    shape: {
      name: z.string().min(1).describe(
        "Subreddit name WITHOUT the r/ prefix (e.g. 'python'). Required (path parameter).",
      ),
      page: z.string().min(1).describe(
        "Wiki page name (e.g. 'index'). Required (path parameter). May be multi-segment like 'config/sidebar'.",
      ),
    },
  },
  {
    name: "reddit_by_id",
    path: "/api/reddit/by_id/{fullnames}",
    description:
      "Bulk-fetches posts by their t3_ fullnames in ONE call (up to 100), in place of a request per post. Takes a comma-separated list of fullnames from a search or listing. Returns posts with title, author, score, comment count, and permalink, the same post shape as the listing endpoints. The result is not necessarily one-to-one with the request, and `meta` reports which: `listing_status` is `complete` only when every fullname came back, `truncated` is a boolean, and `missing_fullnames` names exactly which ids did not come back. Example: fullnames='t3_abc123,t3_def456'.",
    shape: {
      fullnames: z.string().min(1).describe(
        "Comma-separated post fullnames, each a t3_ prefix followed by the base-36 id (e.g. 't3_abc123,t3_def456'). Up to 100. Required (path parameter).",
      ),
    },
  },
  {
    name: "reddit_subreddits_popular",
    path: "/api/reddit/subreddits/popular",
    description:
      "Browses the most-subscribed, trending subreddits right now, with no keyword. Returns a `subreddits` list (each with name, title, subscriber count, description, type, and NSFW flag) plus an `after` cursor for paging.",
    shape: { ...AFTER, ...LIMIT },
  },
  {
    name: "reddit_subreddits_new",
    path: "/api/reddit/subreddits/new",
    description:
      "Browses the newest subreddits, the communities most recently created, with no keyword. Returns a `subreddits` list (each with name, title, subscriber count, description, type, and NSFW flag) plus an `after` cursor for paging.",
    shape: { ...AFTER, ...LIMIT },
  },
  {
    name: "reddit_subreddits_default",
    path: "/api/reddit/subreddits/default",
    description:
      "Browses Reddit's default front-page set of subreddits, with no keyword. Returns a `subreddits` list (each with name, title, subscriber count, description, type, and NSFW flag) plus an `after` cursor for paging.",
    shape: { ...AFTER, ...LIMIT },
  },

  // ── monitoring: manage the caller's own account, never posts/votes/DMs Reddit itself ──
  {
    name: "reddit_monitor_add",
    path: "/api/reddit/monitor/add",
    method: "POST",
    write: true,
    filterSpecFields: ["subreddit", "exclude_subreddits", "kind", "q", "author", "exclude_terms", "domain", "include_any", "include_all", "search_in", "group", "min_score", "min_relevance", "nsfw"],
    description:
      "Creates a Reddit monitor: watches one or more subreddits, or ALL of Reddit, for new posts (or comments, via `kind`) matching a filter, and delivers every match to the account's registered webhooks. With `subreddit` absent and `q` set, it is a sitewide keyword monitor covering every subreddit at once (posts only). By default matches go to EVERY active webhook on the account; `webhook_ids` routes this monitor's matches to specific webhooks. Every redditapis.com account holds a free entitlement of ONE all-of-Reddit post watch at a 60s cadence (up to 10,000 deliveries a day), so that monitor needs no subscription. Naming a `subreddit`, matching comments, a faster cadence and any additional watch require a paid plan. Needs at least one free monitor slot (the `slots` object in the monitor list). Forward-looking only, from the moment of creation or from `baseline_item_id` if given; posts that already existed are not backfilled. Returns the created monitor (with its `id`) on success, or `subscription_required` (402) if the account holds no recognised entitlement at all, `subreddit_scope_requires_paid_plan` (402) if a free account named a `subreddit`, `monitor_slots_exhausted` (402) if the plan's slot limit is reached, `sitewide_slots_exhausted` (402) if the plan's separate sitewide cap is reached, `distinct_subreddit_limit_reached` (402) if the account already watches as many DIFFERENT subreddits as the plan covers (the limit counts distinct subreddits across all the account's monitors, not monitors, and the same subreddit in two monitors counts once; `slots.distinct_subreddits_total` in the monitor list), `sitewide_comment_monitoring_not_available` (501) if a sitewide monitor asks for comments, `subreddit_reserved` (400) if `subreddit` names 'all', `subreddit_not_found` (400) if a named subreddit does not exist, or `webhook_not_found` (400) if a `webhook_ids` entry is not on this account.",
    shape: {
      ...MONITOR_SUBREDDIT,
      ...MONITOR_FILTER_FIELDS,
      cadence_s: z.number().int().positive().optional().describe(
        "Requested poll interval in seconds. A value at or above the plan tier's floor is honoured; a lower value is silently clamped up to the tier's minimum. Absent, the tier's default applies.",
      ),
      baseline_item_id: z.string().optional().describe(
        "A Reddit post fullname (e.g. 't3_abc123') used as the starting point in place of 'now': matching starts strictly after this item. Absent, matching starts from the moment of creation.",
      ),
      ...MONITOR_WEBHOOK_IDS,
    },
  },
  {
    name: "reddit_monitor_list",
    path: "/api/reddit/monitor/list",
    description:
      "Lists every monitor on the caller's account, with each one's filter, active state, and cadence, plus a `slots` object ({used, total, tier}) showing how many monitor slots are purchased vs in use. Reading the list requires no active plan (a lapsed subscription shows an empty or paused list, not an error). A null `webhook_ids` is the default and means matches go to EVERY active webhook on the account, the normal healthy state, not a monitor without a destination; a non-empty array narrows delivery to those webhook ids. Where a monitor's matches actually went is recorded per delivery, as the resolved `webhook_id` on each delivery row.",
    shape: {},
  },
  {
    name: "reddit_monitor_update",
    path: "/api/reddit/monitor/update",
    method: "POST",
    write: true,
    filterSpecFields: ["subreddit", "exclude_subreddits", "kind", "q", "author", "exclude_terms", "domain", "include_any", "include_all", "search_in", "group", "min_score", "min_relevance", "nsfw"],
    description:
      "Updates an existing monitor: pauses or resumes it (`active`), changes its poll interval (`cadence_s`), switches between posts and comments (`kind`), replaces its filter entirely, or re-targets which webhooks it delivers to (`webhook_ids`). Any filter field (subreddit, q, kind, domain, etc.) REPLACES the whole filter: it does not merge with the existing one, so a field absent from the request is cleared, and a request without `kind` reverts the monitor to posts-only. `webhook_ids` likewise REPLACES the monitor's targeting outright (an empty array clears back to every active webhook); a request without it leaves the existing targeting untouched. A request with only `active` and/or `cadence_s` changes only those. Returns 404 `monitor_not_found` if the id does not exist or is not on this account, or 400 `webhook_not_found` if a `webhook_ids` entry is not on this account.",
    shape: {
      ...MONITOR_ID,
      ...{
        subreddit: z.array(z.string().min(1)).min(1).max(50).optional().describe(
          MONITOR_SUBREDDIT_DESC +
            " On an update, a request that carries another filter field without this one makes the monitor SITEWIDE (the filter is replaced wholesale, not merged).",
        ),
      },
      ...MONITOR_FILTER_FIELDS,
      active: z.boolean().optional().describe("false pauses the monitor (stops matching and delivering); true resumes it."),
      cadence_s: z.number().int().positive().optional().describe("New poll interval in seconds, clamped to the tier floor the same way as at creation."),
      ...MONITOR_WEBHOOK_IDS,
    },
  },
  {
    name: "reddit_monitor_remove",
    path: "/api/reddit/monitor/remove",
    method: "POST",
    write: true,
    destructive: true,
    description:
      "Deletes a monitor. There is no undo endpoint: it stops matching immediately, its slot is freed for a new monitor, and it disappears from the monitor list. Its past deliveries are NOT erased; they remain queryable in the delivery history (both by monitor id and in the aggregate, no-id view) indefinitely. Returns 404 `monitor_not_found` if the id does not exist or is not on this account.",
    shape: { ...MONITOR_ID },
  },
  {
    name: "reddit_monitor_health",
    path: "/api/reddit/monitor/health",
    description:
      "Per-monitor health: active state, poll cadence, when it last matched something, and delivery counts for the last 24h (`delivered_24h`, `failed_24h`, `suppressed_24h`), plus whether its delivery ceiling has been hit (`ceiling_reached`) and what that ceiling is (`daily_delivery_ceiling`). `suppressed_24h` COUNTS TWO DIFFERENT THINGS AND `suppressed_breakdown` SPLITS THEM: `ceiling` (the monitor's daily cap was reached) and `stale` (the item was already older than the freshness window when first seen, so it was withheld rather than delivered as if it were new). A stale withhold is the usual reason a monitor's delivered count sits far below its matched count with no error anywhere; it is the freshness gate working as intended, not a failure or a plan limit, and retrying cannot recover the items. `ceiling_reached` is the field that indicates the daily cap was hit, and a stale withhold does not set it. When `suppressed_breakdown.resolved` is false the split does not add up to the total and `unresolved_reason` says why; `ceiling_reached` stays conservative in that case rather than being cleared. THOSE COUNTS COVER ONLY POSTS THAT WERE FETCHED. A post that was not fetched was not matched and leaves no row behind, so it is absent from all three counters; zeros there mean no matches were recorded, not that nothing was missed. `coverage_24h` is the separate field that speaks to fetching. Its `status` is `complete` (every poll reached the point where the previous poll finished), `degraded` (at least one poll was truncated and posts were lost unrecoverably; detail in `gaps[]`, `posts_in_window_at_least` and the estimated `posts_missed_estimate`), `partial` (nothing found, but not every kind of loss was checked; detail in `unobserved_events`), or `unknown` (the check could not be run at all; detail in `reason`). `unknown`, `partial` and a null count each mean the question went unanswered. `coverage_24h` is fed by the poll log and covers BOTH ways a poll loses posts unrecoverably (`listing_exhausted`, where Reddit stopped serving older posts, and `poll_overflow`, where the feed outran one poll's page budget); `observed_events` names what was actually checked, and a status of `complete` is awarded only when both were. WHAT `complete` ESTABLISHES: every poll that RAN got back to where the previous poll finished, AND every feed was actually polled. The second half comes from `stream_liveness`. A feed that is not polled writes nothing to the poll log, so on the poll log alone it looks identical to a healthy monitor; `stream_liveness` reads a different source (the polling registry plus the per-feed last-successful-poll stamp), neither of which a poll that did not run can produce. Its `status` is `live` (every feed checked within three times its own interval), `degraded` (at least one is not: `streams[]` marks each feed `never_polled`, `stalled` or `unregistered`), or `unknown` (could not be established, including `streams_awaiting_first_poll` on a monitor created moments ago, which clears itself). `coverage_24h` reads `complete` only while `stream_liveness` is `live`. A zero delivery count on a `never_polled` feed means nothing was checked, not a quiet subreddit. `gaps[]` IS A SAMPLE, NOT THE WHOLE LIST: it carries the most recent gaps only, `gaps_returned` says how many are in it, `gaps_truncated` says whether more exist, and `gap_events_24h` is the true total. `cadence` reports whether the monitor is served the interval its plan sells, which none of the fields above can. `promised_cadence_s` is the floor the account's CURRENT plan includes and `requested_cadence_s` is what this monitor is actually set to; `meets_entitlement` false means the monitor is set slower than the plan allows, which happens because a plan upgrade does not re-cadence monitors that already exist (setting `cadence_s` on the monitor changes it, and a deliberately slower cadence is also a legitimate choice). `last_checked_s_ago`, `freshness_ratio` and `within_margin` describe the slowest feed feeding this monitor, named in `slowest_stream`; `freshness_reading` marks them as ONE INSTANTANEOUS SAMPLE, not an average and not a sustained verdict, so a single reading past the margin is not by itself proof of under-service. These fields are TRI-STATE: a null `within_margin` or `meets_entitlement` means the question could not be answered, and `unknown_reason` says why.",
    shape: { ...MONITOR_ID },
  },
  {
    name: "reddit_monitor_deliveries",
    path: "/api/reddit/monitor/deliveries",
    // The endpoint's own default is 50 rows and each row carries a whole webhook
    // envelope; 20 keeps the newest matches and roughly a third of the bytes.
    defaultLimit: 20,
    description:
      "Delivery history: the actual Reddit posts a monitor's webhook has received (or attempted), newest first, including the real post content (title, subreddit, permalink, author). It records what was sent, not only how many (the counts are in monitor health). Every delivered item also carries `payload.items[].enrichment`: a `relevance.score` (0-1, how much of THIS monitor's own keyword criteria the item matched; not a model's confidence), a `sentiment` (`polarity` -1 to 1 plus a positive/negative/mixed/neutral `label`), and an `intent.tag` (question, recommendation_request, complaint, promotion, praise, or discussion). All three are deterministic keyword, lexicon and rule heuristics computed at no extra cost; each carries its own `method` field and none of them is a machine-learning or LLM call. Without `id`, the history aggregates across every monitor on the account.",
    shape: {
      id: z.string().optional().describe("Narrows to one monitor's history. Absent, the history aggregates across every monitor on the account."),
      status: z.enum(["pending", "delivered", "failed", "dead", "suppressed"]).optional().describe(
        "Filters to one delivery status. 'dead' = retries exhausted, gave up. 'suppressed' = matched but deliberately not sent, and `payload.suppressed.reason` says which of the two reasons applied: 'delivery_ceiling' (the monitor's daily cap) or 'stale_item' (the item was already older than the freshness window when first seen, so it was withheld rather than delivered as if it were new). A 'stale_item' row is NOT a fault and was NOT rejected by any plan limit, and retrying cannot recover it; `payload.suppressed` carries the age and the threshold. Absent, every status is returned.",
      ),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum rows returned, 1 to 200. The endpoint's own default is 50; when this is omitted the server sends 20, because each row carries a whole webhook delivery envelope."),
      before: z.string().optional().describe("ISO 8601 timestamp cursor for pagination: the `created_at` of the oldest row from the previous page returns older deliveries."),
    },
  },
  {
    name: "reddit_monitor_webhook_create",
    path: "/api/reddit/monitor/webhook/create",
    method: "POST",
    write: true,
    description:
      "Registers a delivery target for monitors to send matches to. Requires an active monitoring plan (a webhook with no plan could not receive anything). Returns the webhook with its signing `secret` SHOWN ONCE: the webhook list does not return it again. HTTPS only; the URL is re-validated (including a fresh DNS check) at every delivery, not just at creation.",
    shape: {
      url: z.string().url().describe("HTTPS URL that receives matches. Accepted: a publicly reachable HTTPS URL with no embedded credentials and no loopback, private or link-local address."),
      kind: z.enum(["webhook", "slack", "discord", "email"]).optional().describe(
        "Payload shape. Absent, the kind is inferred from the host for a hooks.slack.com or discord.com/api/webhooks URL, and the response reports the inference in `kind_inferred_from`. 'slack'/'discord' format as native incoming-webhook messages; 'webhook' sends the generic signed JSON envelope and is the fallback for an unrecognised host; 'email' is not yet a real delivery transport. 'webhook' with a Slack or Discord URL does NOT force the generic envelope (that combination cannot deliver: Slack answers 400 invalid_payload); the host wins and `kind_corrected_from` says so. A SPECIFIC kind for a different platform's host (e.g. 'discord' with a hooks.slack.com URL) is refused with `webhook_kind_mismatch` (400) rather than stored.",
      ),
    },
  },
  {
    name: "reddit_monitor_webhook_list",
    path: "/api/reddit/monitor/webhook/list",
    description: "Lists every webhook registered on the caller's account. The signing secret is not included; it is shown once, at creation.",
    shape: {},
  },
  {
    name: "reddit_monitor_webhook_test",
    path: "/api/reddit/monitor/webhook/test",
    method: "POST",
    write: true,
    description:
      "Sends a one-off test delivery to a registered webhook (rate-limited to 10/min), confirming it is wired up correctly before a real match arrives. The test payload is formatted by the webhook's `kind`, the same way a real delivery would be. On failure the response carries `reason` and `status`, plus `hint`, a sentence naming the fix (most often that the target's `kind` does not match its host, which no test can succeed through), and `detail`, a bounded, sanitised copy of what the destination itself replied. `hint` carries the remedy; a bare `reason` such as `http_error` with a 400 names no field, no value and no remedy. Returns 404 `webhook_not_found` if the id does not exist or is not on this account, or `webhook_url_rejected` if the URL fails re-validation (e.g. now resolves to a private address).",
    shape: { ...WEBHOOK_ID },
  },
  {
    name: "reddit_monitor_webhook_delete",
    path: "/api/reddit/monitor/webhook/delete",
    method: "POST",
    write: true,
    destructive: true,
    description:
      "Permanently deletes a webhook. A monitor still pointing at it fails to deliver until it is repointed at a different webhook: deletion does NOT cascade-delete or pause the monitors using it. Cannot be undone. Returns 404 `webhook_not_found` if the id does not exist or is not on this account.",
    shape: { ...WEBHOOK_ID },
  },

  // ── feedback: report a defect or a gap to the redditapis.com team, with the
  //    user's review between the draft and the send ─────────────────────────
  {
    name: "reddit_feedback_send",
    path: "/feedback",
    method: "POST",
    write: true,
    local: "feedback",
    localArgs: ["action", "ids"],
    description:
      "Reports a product problem or gap in redditapis.com to its team, through a local draft queue. action \"draft\" (the default) writes a report to a queue on this machine and sends nothing; it makes no network call. action \"list\" returns the pending drafts with their ids. action \"send\" posts the named draft ids to POST /feedback (free, not metered) and returns a server id per report. action \"discard\" drops the named drafts. The queue holds at most 10 drafts; a draft past that is refused. A draft takes `type`, a one-line `title` (at most 120 characters), `details` (at most 8000 characters) and optional `area` and `evidence`; evidence keys left out (tool, endpoint, HTTP status, request id) are filled from the last failing call in this session, and the MCP version and client name are attached to every report.",
    shape: {
      action: z.enum(["draft", "list", "send", "discard"]).optional().describe(
        "\"draft\" (default) queues a new report locally and sends nothing. \"list\" returns the pending drafts with their ids. \"send\" posts the drafts named in `ids` to redditapis.com. \"discard\" drops the drafts named in `ids`.",
      ),
      type: z.enum(["bug", "idea", "missing_capability"]).optional().describe(
        "Required for a draft. \"bug\": a tool or endpoint misbehaved. \"idea\": a change that would have made the task easier. \"missing_capability\": a needed capability that no tool provides.",
      ),
      title: z.string().max(120).optional().describe(
        "Required for a draft. One line, at most 120 characters, naming the tool or endpoint and the defect, e.g. \"GET /api/reddit/comments returns 502 when the post is deleted\".",
      ),
      details: z.string().max(8000).optional().describe(
        "Required for a draft. At most 8000 characters: three labelled bullets, What happened, Repro, Evidence, optionally preceded by a one-line summary of the goal. No quotes of the conversation.",
      ),
      area: z.string().max(80).optional().describe(
        "Optional. The endpoint or feature the report is about, e.g. \"posts/comments\" or \"monitoring\". At most 80 characters.",
      ),
      evidence: z.record(z.string(), z.unknown()).optional().describe(
        "Optional identifiers, {tool, endpoint, status, request_id}, at most 4096 bytes serialized. Keys left out are filled from the last failing call in this session; mcp_version and client are attached to every report.",
      ),
      ids: z.array(z.string()).optional().describe(
        "For action \"send\" or \"discard\": the draft ids to act on, as returned by action \"list\".",
      ),
    },
  },
  {
    name: "reddit_feedback_list",
    path: "/feedback",
    description:
      "Lists the feedback reports this account has sent, newest first, with each one's current status. The server id is returned only once, when a report is sent, so this listing is how a report whose id was not kept is found again; it also shows whether a report landed and whether the team has acted on it. Optional filters by status or type; paging uses the cursor from a previous response. Free per call, not metered. Returns {feedback: [...], count, limit, next_cursor}; pages continue while next_cursor is non-null, and an account that has filed nothing gets an empty list and a 200, not an error. It lists SENT reports on the server, which differ from the unsent local drafts on this machine.",
    shape: {
      status: z.enum(["new", "triaged", "shipped", "declined"]).optional().describe(
        "Optional. Restricts the list to reports in this state; absent, every state.",
      ),
      type: z.enum(["bug", "idea", "missing_capability"]).optional().describe(
        "Optional. Restricts the list to reports of this kind; absent, every kind.",
      ),
      cursor: z.string().optional().describe(
        "Optional. The next_cursor from a previous response, for the page after it. Keyset paging on (created_at, id), so a report filed during paging cannot make a row repeat or be skipped. A cursor this endpoint did not issue is a 400, not an empty page.",
      ),
      limit: z.number().int().min(1).max(100).optional().describe(
        "Optional. How many are returned, 1 to 100 (default 25). Newest first.",
      ),
    },
  },
  {
    // CHECK BEFORE YOU SPEND. An agent planning a costed run has no way to ask
    // how much credit is left, so it either runs blind and hits a 402 partway
    // through, or it asks the user to go and look. Both are avoidable: the
    // endpoint already exists and is already free.
    //
    // GET /account/me is mounted OUTSIDE /api (server.js), ahead of bearerAuth,
    // under a comment reading "Free account endpoints live in apps/backend". So
    // this tool bills nothing and is safe to call before every plan.
    //
    // Path verified against the live origin rather than read off the route
    // tree: /account/me returns 401 unauthenticated while /account/<nonsense>
    // returns 404, which is how we know the route exists. (/api/<anything>
    // returns 401 for everything, so that path could not have told us.)
    name: "reddit_account_me",
    path: "/account/me",
    description:
      "Returns the remaining credit balance and usage totals of the account behind this API key. Free: not metered, and costs no credit. A 402 from a metered call means the balance is exhausted; that response carries a top-up URL.",
    shape: {},
  },
  {
    // ONE CALL INSTEAD OF THREE. Standing up a watch today means composing a
    // webhook registration, a monitor creation and a test delivery, each with
    // its own vocabulary, and the first one a caller gets wrong fails late as a
    // 400 or a 402. This compiles a sentence into those calls and checks the
    // two rules that need no round trip (the anchor rule and the reserved
    // 'all' sentinel) before any request is sent. The compiler itself is in
    // src/watch.js and is a set of regular expressions, not a model, so the
    // same sentence always compiles to the same filter.
    //
    // The PATH is monitor/add, the call that makes the watch exist, so the
    // catalog's public-mount check still covers this tool. The local handler
    // makes the other calls itself; `watch`, `deliver_to` and `test_delivery`
    // are consumed locally and never sent as fields of a monitor request.
    name: "reddit_set_watch",
    path: "/api/reddit/monitor/add",
    method: "POST",
    write: true,
    local: "set_watch",
    localArgs: ["watch", "deliver_to", "test_delivery"],
    description:
      "Creates a Reddit watch from a plain-words description in one call: the description is compiled into a monitor filter, the account's own plan capabilities are read, the monitor is created, and an HTTPS delivery target given in `deliver_to` is registered, pointed at this monitor and test-fired. The compiler reads subreddit names written as r/Name, quoted phrases as keyword terms (two or more become an any-of set), 'comments' or 'posts and comments' as the match kind, terms after 'except' or 'ignoring' as exclusions, and 'at least N upvotes' as a score floor; everything it derived comes back in `understood` and `compiled_filter`. A description naming neither a subreddit nor a keyword is refused before any request is sent, because a monitor is anchored by one or the other. On an account whose plan carries no subreddit-scoped watches, a description that names subreddits and also carries a keyword is built over every subreddit instead, and the swap is reported in `notes`. Monitor and webhook calls are not metered. The result carries the created monitor, the delivery target and its test outcome, and the account's current slot and capability figures.",
    shape: {
      watch: z.string().min(1).max(600).describe(
        "The watch, in plain words, e.g. 'watch r/SaaS and r/startups for \"pricing page\" except giveaways' or 'every comment mentioning \"cold email\" with at least 5 upvotes'. Subreddits are written as r/Name, keyword terms are quoted, 'comments' or 'posts and comments' sets the match kind. Required.",
      ),
      deliver_to: z.string().url().optional().describe(
        "Optional HTTPS URL that receives matches. A hooks.slack.com or discord.com/api/webhooks URL has its payload shape inferred from the host; any other HTTPS URL receives the generic signed JSON envelope. Absent, matches go to every active webhook already on the account.",
      ),
      cadence_s: z.number().int().positive().optional().describe(
        "Optional poll interval in seconds. A value below the plan tier's floor is clamped up to that floor. Absent, the tier default applies.",
      ),
      test_delivery: z.boolean().optional().describe(
        "false skips the one-off test delivery that otherwise follows a successful `deliver_to` registration. Default true. Ignored when no `deliver_to` is given.",
      ),
    },
  },
  {
    // NO ENDPOINT AND NO NETWORK CALL. Provenance is something this process
    // observed: which tool reached which endpoint, when the response arrived,
    // the upstream request id and the size. There is no provenance endpoint to
    // call and no cache to read an age out of (src/provenance.js records why in
    // full), so this tool reads an in-memory ledger and nothing else. `path` is
    // null for that reason, and the catalog test refuses a null path on any
    // tool that is not local.
    name: "reddit_explain",
    path: null,
    local: "explain",
    localArgs: ["tool", "limit"],
    description:
      "Returns the provenance of the rows this server has already fetched in this session: per completed call, the tool that made it, the endpoint it reached, the timestamp the response arrived, how many seconds old that copy now is, the upstream request id and the response size. Provenance is recorded per call, so every row in one response shares it. The redditapis.com read path holds no response cache for customer reads, so each call is served live at the moment it runs and the age reported here is the age of this session's copy of the rows rather than the age of a stored row; `response_cache` says so in the result. The ledger holds the 20 most recent completed calls, lives in memory, starts empty, is scoped to this server and carries no other caller's calls. How long each category of data is kept is published at https://www.redditapis.com/privacy-and-data-handling.",
    shape: {
      tool: z.string().min(1).max(80).optional().describe(
        "Optional tool name that restricts the result to calls made by that tool. Absent, the most recent calls by any tool are returned.",
      ),
      limit: z.number().int().min(1).max(20).optional().describe(
        "Optional count of calls returned, 1 to 20, newest first. Default 5.",
      ),
    },
  },
  {
    name: "reddit_feedback_get",
    path: "/feedback/{id}",
    description:
      "Returns the status of a feedback report this account sent earlier, by its server id: status new, triaged, shipped or declined, the team's response text if any, and updated_at, which moves only when the team acts on it. Free per call. 404 if the id is not on this account.",
    shape: {
      id: z.string().min(1).describe(
        "The server id of a sent report (a UUID), as returned when the report was sent. Not a local draft id.",
      ),
    },
  },
];

// Turn tool args into a URL query string. Skips undefined/null/empty values.
// ── the session HEADER transport ────────────────────────────────────────────
//
// A GET tool's args normally become the query string. A Reddit session cookie
// must not: it grants full control of that account and a query string is
// written into every access log, proxy log and browser history along the path.
// So a tool that declares `sessionHeaders: true` has these arg names lifted OUT
// of the query and sent as headers instead.
//
// The four legacy private listings (upvoted/saved/hidden/gilded) deliberately
// do NOT declare it: they have always sent cookies as query fields, the REST
// API still honours that form, and changing what a shipped tool puts on the
// wire is a behaviour change nobody asked for. New tools use headers.
export const SESSION_ARG_TO_HEADER = {
  reddit_session: "x-reddit-session",
  loid: "x-reddit-loid",
  token_v2: "x-reddit-token-v2",
  csrf_token: "x-reddit-csrf-token",
  edgebucket: "x-reddit-edgebucket",
  csv: "x-reddit-csv",
  session_tracker: "x-reddit-session-tracker",
  pc: "x-reddit-pc",
  proxy: "x-reddit-proxy",
};

// ── inline credentials ──────────────────────────────────────────────────────
//
// A tool takes INLINE CREDENTIALS when its input schema has an argument that
// carries the caller's own Reddit session: a cookie, a token, or the proxy the
// session egresses through (proxy URLs embed user:pass). createServer leaves
// such tools unregistered when built with inlineCredentials:false, the mode a
// remote host uses so a connected app never pipes a Reddit session through it.
//
// Two tests, either one hides a tool, so the check fails CLOSED: the exact arg
// names the header transport knows, and a name pattern that catches a future
// credential-shaped argument added without updating that map.
export const CREDENTIAL_ARGS = Object.freeze(Object.keys(SESSION_ARG_TO_HEADER));
// Matched on whole underscore-separated words, so `author` or `max_authors` is not
// mistaken for `auth`.
const CREDENTIAL_NAME = /(^|_)(cookies?|session|token|password|passwd|secret|credentials?|csrf|loid|proxy|auth|authorization|bearer|api_key|apikey)(_|$)/i;

export function takesInlineCredentials(tool) {
  return Object.keys(tool?.shape || {}).some((k) => CREDENTIAL_ARGS.includes(k) || CREDENTIAL_NAME.test(k));
}

/**
 * Split a tool's args into headers and everything else.
 *
 * Returns { headers, rest }. When the tool does not declare `sessionHeaders`
 * this is the identity: `headers` is empty and `rest` is the args unchanged, so
 * every existing tool builds exactly the request it built before.
 */
export function buildHeaders(tool, args) {
  const headers = {};
  const rest = {};
  const lift = tool && tool.sessionHeaders;
  for (const [k, v] of Object.entries(args || {})) {
    const header = lift ? SESSION_ARG_TO_HEADER[k] : null;
    if (header && v !== undefined && v !== null && String(v).length > 0) {
      headers[header] = String(v);
    } else if (!header) {
      rest[k] = v;
    }
    // A declared session field that is empty is dropped rather than sent as an
    // empty header: an empty x-reddit-session would read as "authenticate me"
    // and earn a 400 instead of the anonymous read the caller meant.
  }
  return { headers, rest };
}

export function buildQuery(args) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args || {})) {
    if (v !== undefined && v !== null && String(v).length > 0) qs.set(k, String(v));
  }
  return qs.toString();
}

// Interpolate {param} path placeholders from args; return the resolved path and
// the remaining args (which become the query string). A missing path param is
// left empty (the endpoint then 404s, surfaced to the caller) rather than
// throwing, so one bad call never crashes the server.
export function buildPath(template, args) {
  const used = new Set();
  const path = String(template).replace(/\{(\w+)\}/g, (_, k) => {
    used.add(k);
    const v = args?.[k];
    return encodeURIComponent(v == null ? "" : String(v));
  });
  const rest = {};
  for (const [k, v] of Object.entries(args || {})) if (!used.has(k)) rest[k] = v;
  return { path, rest };
}

// Turn a POST tool's args into the JSON body the REST endpoint expects. A field
// named in `tool.filterSpecFields` nests under `filter_spec`; everything else
// stays top-level (id, cadence_s, active, url, kind, ...). Skips undefined so
// an omitted optional arg is genuinely absent from the body, never sent as
// `null` -- monitor-handlers.js tells "field not provided" apart from "field
// explicitly cleared" (e.g. updateMonitor only replaces filter_spec when at
// least one filter field is present at all).
export function buildBody(tool, args) {
  const filterFields = new Set(tool.filterSpecFields || []);
  const body = {};
  let filterSpec = null;
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined) continue;
    if (filterFields.has(k)) {
      filterSpec = filterSpec || {};
      filterSpec[k] = v;
    } else {
      body[k] = v;
    }
  }
  if (filterSpec) body.filter_spec = filterSpec;
  return body;
}
