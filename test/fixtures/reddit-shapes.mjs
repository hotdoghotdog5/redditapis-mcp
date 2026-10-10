// test/fixtures/reddit-shapes.mjs: Reddit-shaped response bodies, built to the
// field list of Reddit's own listing JSON.
//
// WHY A FIXTURE INSTEAD OF A LIVE CALL: the upstream bodies these mimic come
// from api.redditapis.com, which needs a paid key this repository does not carry,
// and Reddit itself answers an unauthenticated .json request from a datacenter
// IP with a 403. The shapes below are written from Reddit's documented listing
// fields (the endpoint passes Reddit's objects through: docs.redditapis.com/openapi.json
// declares these responses as untyped `array of object` with `additionalProperties:
// true`, which is the spec's way of saying "whatever Reddit sent"). Where a shape
// detail could not be verified, the compaction test does not depend on it: the
// size ceiling is asserted over random unknown fields too, and that is the part
// that has to hold whatever the upstream sends.
//
// The byte counts matter as much as the field names, because the defect under
// test is a byte count: Reddit sends ~40 keys a browser needs and 12 an agent
// reads, and `media_metadata` plus `preview` are 1-15 KB on an image post.

const FLAIR_JUNK = {
  author_flair_background_color: null,
  author_flair_css_class: null,
  author_flair_template_id: "9b59ab10-8f9a-11e1-a10c-12313b05cebb",
  author_flair_text_color: "dark",
  author_flair_type: "text",
  link_flair_background_color: "",
  link_flair_css_class: null,
  link_flair_template_id: "1a7b3f4e-6a9f-11ec-9c9a-0242ac140003",
  link_flair_text_color: "dark",
  link_flair_type: "text",
  user_flair_background_color: null,
  user_flair_css_class: null,
  user_flair_text_color: null,
};

const CLIENT_JUNK = {
  archived: false,
  can_gild: false,
  can_mod_post: false,
  clicked: false,
  content_categories: null,
  hide_border: false,
  ignore_reports: false,
  is_created_from_ads_ui: false,
  is_crosspostable: true,
  is_meta: false,
  is_reddit_media_domain: true,
  is_robot_indexable: true,
  is_whiteout_mode: false,
  likes: null,
  num_reports: null,
  over_18: false,
  pinned_poi_tag: null,
  report_reports: null,
  saved: false,
  saved_fullname: null,
  saved_list_fullname: null,
  sent_replies: true,
  spoiler: false,
  suggested_sort: null,
  total_awards_received: 0,
  user_reports: [],
  mod_reports: [],
  visited: false,
  whitelist_status: null,
  dismissable_vote_status: false,
  quarantine: false,
  is_org: false,
};

function mediaMetadata(seed) {
  // Four images, four renditions each: this is what Reddit sends for a gallery
  // post, and it is the single largest per-post cost in the payload.
  const meta = {};
  for (let i = 0; i < 4; i++) {
    const key = `media-metadata-${seed}-${i}`;
    meta[key] = {
      status: "valid",
      e: "Image",
      m: "image/pjpeg",
      x: 1600, y: 1200,
      id: key,
      s: { y: 1050, x: 1400, u: `https://preview.redd.it/${key}-full.jpg` },
      p: [{ y: 240, x: 320, u: `https://preview.redd.it/${key}-p240.jpg` },
        { y: 480, x: 640, u: `https://preview.redd.it/${key}-p480.jpg` },
        { y: 108, x: 144, u: `https://preview.redd.it/${key}-p108.jpg` }],
      r: { y: 240, x: 320, u: `https://preview.redd.it/${key}-r240.jpg` },
    };
  }
  return meta;
}

function preview(seed) {
  return {
    images: [0, 1, 2, 3].map((i) => ({
      source: { url: `https://external-preview.redd.it/${seed}-${i}.jpg?auto=webp&s=abcdef0123456789`, width: 1600, height: 1200 },
      resolutions: [{ url: `https://external-preview.redd.it/${seed}-${i}-s.jpg`, width: 108, height: 81 },
        { url: `https://external-preview.redd.it/${seed}-${i}-m.jpg`, width: 240, height: 180 }],
      variants: [{ res: "gif", url: `https://external-preview.redd.it/${seed}-${i}.gif`, width: 1600, height: 1200 }],
      id: `pid-${seed}-${i}`,
    })),
    enabled: true,
  };
}

const LOREM = ("Reddit's own listing payload carries the same post twice over, once as markdown and once as the HTML a browser paints, "
  + "plus every rendition of every image it might draw, plus the flair blob of the poster and the flair blob of the moderator team that "
  + "styled it, plus the award ledger, plus the report counters, plus the flags this particular client uses to decide whether to draw a "
  + "border. None of that is an answer to a question, and all of it is put back into the model's context on the next turn. ").repeat(4);

/**
 * A post as the listing endpoints return it. `gallery` adds the media block,
 * which is what makes an r/pics or r/gaming search so large.
 */
export function post(seed, { gallery = false, comments = 40 + seed * 7 } = {}) {
  return {
    kind: "t3",
    id: `p${seed.toString(36)}`,
    name: `t3_p${seed.toString(36)}`,
    created_utc: 1760000000 + seed * 900,
    author: `author_${seed}`,
    title: `The one thing nobody tells you about scaling a Rust service (part ${seed})`,
    permalink: `/r/rust/comments/p${seed.toString(36)}/the_one_thing_nobody_tells_you_part_${seed}/`,
    url: gallery ? `https://i.redd.it/gallery-${seed}.jpg` : `https://www.reddit.com/r/rust/comments/p${seed}/`,
    subreddit: "rust",
    subreddit_id: "t5_2qh9u",
    subreddit_name_prefixed: "r/rust",
    subreddit_subscribers: 620000 + seed,
    score: 1200 - seed * 13,
    ups: 1240 - seed * 13,
    upvote_ratio: 0.93,
    num_comments: comments,
    is_self: !gallery,
    is_video: false,
    link_flair_text: seed % 2 ? "Performance" : "Discussion",
    stickied: seed === 0,
    distinguished: seed === 0 ? "moderator" : null,
    selftext: `I run a small service and here is what broke.\n\n${LOREM}`,
    selftext_html: null,
    domain: "self.rust",
    gildings: {},
    all_awardings: [],
    ...FLAIR_JUNK,
    ...CLIENT_JUNK,
    ...(gallery ? {
      post_hint: "image",
      media_metadata: mediaMetadata(seed),
      preview: preview(seed),
      thumbnail: `https://b.thumbs.redditmedia.com/${seed}-t.jpg`,
      thumbnail_height: 140,
      thumbnail_width: 140,
      media: null,
      secure_media: null,
      media_embed: { content: "", width: 640, scrolling: false },
      secure_media_embed: { content: "", width: 640, scrolling: false },
      gallery_data: { items: [0, 1, 2, 3].map((id) => ({ id })) },
    } : {}),
  };
}

/**
 * A comment tree: `top` top-level comments, each with a chain of replies down to
 * `depth`, in Reddit's order (which is its own rank, not score order). About one
 * comment in seven is [deleted] or [removed].
 */
export function comment(seed, { depth = 0, deleted = false, score = 10 + seed * 3, body = null } = {}) {
  const text = deleted
    ? (seed % 2 ? "[deleted]" : "[removed]")
    : (body || `Comment ${seed}, at depth ${depth}. ${LOREM.slice(0, 700)}`);
  return {
    kind: "t1",
    id: `c${seed.toString(36)}`,
    name: `t1_c${seed.toString(36)}`,
    parent_id: depth === 0 ? "t3_p1" : `t1_c${(seed - 1).toString(36)}`,
    link_id: "t3_p1",
    permalink: `/r/rust/comments/p1/_/c${seed.toString(36)}/`,
    author: `commenter_${seed}`,
    body: text,
    body_html: null,
    created_utc: 1760000500 + seed * 30,
    depth,
    score,
    ups: score + 4,
    edited: seed % 5 === 0,
    stickied: false,
    is_submitter: seed % 17 === 0,
    distinguished: null,
    removed_by: null,
    banned_by: null,
    banned_at: null,
    approved_at: null,
    approved_by: null,
    mod_reason_by: null,
    mod_reason_title: null,
    removal_reason: null,
    num_reports: null,
    report_replies: [],
    user_reports: [],
    mod_reports: [],
    total_awards_received: 0,
    ...FLAIR_JUNK,
    ...CLIENT_JUNK,
    author_caked_day: false,
    collapsed: seed % 3 === 0,
    collapsed_reason: seed % 3 === 0 ? "low" : null,
    collapsed_because_crowd_control: null,
    comment_type: null,
    can_receive_reply: true,
    controversy: null,
    initial_version: null,
    post_author: "author_1",
    subreddit: "rust",
    subreddit_id: "t5_2qh9u",
    link_title: "The one thing nobody tells you about scaling a Rust service",
    replies: [],
  };
}

/** A post with `top` top-level comments, each carrying a reply chain. */
export function commentTree({ top = 60, chain = 6 } = {}) {
  const roots = [];
  let seed = 1000;
  for (let i = 0; i < top; i++) {
    seed += 1;
    const root = comment(seed, {
      depth: 0,
      deleted: i % 7 === 3,
      score: 400 - i * 6,
      body: i % 9 === 0 ? `Top-level answer ${i}. ${LOREM.slice(0, 900)}` : null,
    });
    let node = root;
    for (let d = 1; d <= chain; d++) {
      seed += 1;
      const child = comment(seed, { depth: d, deleted: (i + d) % 11 === 0, score: 90 - d * 9 - i });
      node.replies = [child];
      node = child;
    }
    roots.push(root);
  }
  return {
    post: post(1, { gallery: false }),
    comments: roots,
    after: null,
    exhausted_reason: null,
    listing_status: "complete",
    items_returned: roots.length,
    final_page_items: roots.length,
    hint: null,
  };
}

/** A search page: `n` posts, half of them galleries, plus the listing envelope. */
export function searchPage({ n = 25 } = {}) {
  return {
    posts: Array.from({ length: n }, (_, i) => post(i + 1, { gallery: i % 2 === 0 })),
    after: n >= 25 ? "t3_lastcursor" : null,
    exhausted_reason: null,
    listing_status: n >= 25 ? "unknown" : "complete",
    meta: { matched: 4210, page_returned: n, page_completeness: "unknown" },
  };
}

/** The same listing in Reddit's raw `{kind, data}` wrapper form. */
export function wrappedSearchPage({ n = 3 } = {}) {
  return {
    posts: searchPage({ n }).posts.map((p) => ({ kind: "t3", data: p })),
    after: null,
    listing_status: "complete",
  };
}
