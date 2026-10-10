// =============================================================================
// test/fixtures/live-shapes.mjs — what api.redditapis.com actually returns.
//
// Captured 2026-10-10 by running this package inside the mcpo container on LXC
// 100 (the Open WebUI gateway) and printing the keys of one comment and one post
// from live calls: r/LocalLLaMA top-week listing and the comment tree of its top
// post. Bodies are replaced by filler of the same order of length; the FIELD
// NAMES and the shape of the tree are the real ones.
//
// Why this file exists: the wrapper is not a byte-for-byte Reddit passthrough.
// A post body arrives as `text` (not `selftext`), `comments` on a post is the
// comment COUNT, and comments carry identity/score bookkeeping fields Reddit's
// docs do not list. Fixtures written from Reddit's docs alone under-count what
// has to be dropped. Re-capture with:
//   docker exec mcpo bash /srv/redditapis-mcp/verify2.sh
// =============================================================================

export const LIVE_COMMENT_KEYS = [
  "subreddit", "replies", "id", "gilded", "archived", "author", "created_utc",
  "parent_id", "score", "author_fullname", "body", "edited", "name",
  "is_submitter", "downs", "author_patreon_flair", "stickied", "author_premium",
  "score_hidden", "permalink", "subreddit_type", "locked", "created",
  "subreddit_name_prefixed", "controversiality", "depth", "ups",
];

export const LIVE_POST_KEYS = [
  "id", "name", "title", "author", "author_info", "permalink", "url", "text",
  "subreddit", "comments", "upvote_ratio", "over_18", "stickied", "locked",
  "spoiler", "is_self", "is_crosspost", "created_utc", "created",
];

const filler = (n) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

/** A comment as the live wrapper returns it, with the junk fields still in place. */
export function liveComment({ i, body = filler(700), depth = 0, score = 40 - i, replies = [] }) {
  const id = `c${i}`;
  return {
    subreddit: "LocalLLaMA",
    replies,
    id,
    gilded: 0,
    archived: false,
    author: `user${i}`,
    created_utc: 1760000000 + i,
    parent_id: depth === 0 ? "t3_1wymgu6" : `t1_p${i - 1}`,
    score,
    author_fullname: `t2_${900 + i}`,
    body,
    edited: false,
    name: `t1_${id}`,
    is_submitter: i === 3,
    downs: 0,
    author_patreon_flair: false,
    stickied: i === 1,
    author_premium: false,
    score_hidden: false,
    permalink: `/r/LocalLLaMA/comments/1wymgu6/pewdiepie_getting_banned_twic/_comment/${id}/`,
    subreddit_type: "public",
    locked: false,
    created: 1760000000 + i,
    subreddit_name_prefixed: "r/LocalLLaMA",
    controversiality: 0,
    depth,
    ups: score,
  };
}

/** A post as the live wrapper returns it inside a listing. */
export function livePost(i, { title = `Post ${i}`, selftext = filler(2200) } = {}) {
  return {
    id: `1wymgu${i}`,
    name: `t3_1wymgu${i}`,
    title,
    author: `user${i}`,
    author_info: { icon: "", banner: "", awarder: false, follow: false, subscriber: false },
    permalink: `/r/LocalLLaMA/comments/1wymgu${i}/pewdiepie_getting_banned_twic/`,
    url: `https://www.reddit.com/r/LocalLLaMA/comments/1wymgu${i}/`,
    text: selftext,
    subreddit: "LocalLLaMA",
    comments: 120 + i,
    upvote_ratio: 0.94,
    over_18: false,
    stickied: false,
    locked: false,
    spoiler: false,
    is_self: true,
    is_crosspost: false,
    created_utc: 1760000000 + i,
    created: 1760000000 + i,
  };
}

/** A listing of live-shaped posts, in the wrapper's top-level shape. */
export function liveListing(n = 10, after = "eyJhIjoidDNfMW94bmc1byIsImQiOjEwfQ") {
  return { posts: Array.from({ length: n }, (_, i) => livePost(i)), after };
}

/**
 * A thread shaped like the one measured live: ~60 top-level comments, each with
 * 2-4 replies, bodies of ~500-900 characters. The live permalink call returned
 * 205,234 bytes for a thread of this shape.
 */
export function liveThread(topLevel = 60) {
  const comments = [];
  for (let i = 0; i < topLevel; i++) {
    const replies = Array.from({ length: (i % 4) }, (_, j) =>
      liveComment({ i: i * 10 + j + 1, depth: 1, score: 30 - j, body: filler(520 + j * 90), replies: [] }));
    comments.push(liveComment({ i: i + 1, depth: 0, score: 900 - i * 13, body: filler(560 + (i % 5) * 90), replies }));
  }
  return { post: livePost(0), comments };
}
