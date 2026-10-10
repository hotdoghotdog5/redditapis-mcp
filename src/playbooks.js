// src/playbooks.js, three reusable recipes served as MCP RESOURCES.
//
// WHY RESOURCES AND NOT TOOLS. The MCP specification says resources are
// "application-driven, with host applications determining how to incorporate
// context": a host shows them in a picker, a search box, or includes them at
// its own discretion. That is exactly the right primitive for a recipe. A
// recipe turned into a tool would be a tool whose job is to tell the model what
// to do, which is both the wrong shape and the thing the connector directory's
// compliance requirement asks tool descriptions not to be.
//
// WHERE THE COMPLIANCE LINE SITS, stated plainly because the two halves of this
// file are governed by different rules:
//
//   RESOURCE METADATA (name, title, description, mimeType) is catalog metadata,
//   the same class as a tool description, and it is audited by
//   test/description-compliance.test.mjs under the same matcher. It states what
//   the recipe is about and nothing more.
//
//   RESOURCE CONTENTS are the document itself, fetched only when a host or a
//   person asks for that exact URI by name. A recipe that could not name the
//   calls it is a recipe for would be useless, so the contents do name tools.
//   They carry no hidden or encoded text and no link off our own hosts, and the
//   compliance test checks both of those over the contents too.
//
// NOTHING HERE IS PREFETCHED. A resource is read only on an explicit
// resources/read for its URI.
//
// EVERY RECIPE USES CALLS THAT ALREADY SHIP. No playbook depends on a capability
// this package does not already expose, so a recipe cannot go stale by pointing
// at something unbuilt.

export const PLAYBOOK_SCHEME = "playbook";

/**
 * The three playbooks. `description` is catalog metadata and is held to the
 * same standard as a tool description; `body` is the document.
 */
export const PLAYBOOKS = [
  {
    slug: "competitor-mention-watch",
    name: "competitor_mention_watch",
    title: "Competitor mention watch",
    description:
      "A recipe for standing up a continuous watch on competitor names across Reddit and routing every match to a channel, written against the monitor and webhook calls this server already exposes.",
    body: `# Competitor mention watch

Continuous coverage of what Reddit says about a set of competitor names, delivered to a channel instead of read by hand.

## What this produces

One monitor per competitor name, each delivering to one webhook, so a match arrives with the post, the subreddit, the author and the permalink already attached.

## Steps

1. **Fix the name list.** One monitor per name beats one monitor with every name in it: deliveries stay attributable, and a noisy name can be paused on its own with \`reddit_monitor_update\` and \`active: false\`.
2. **Register the destination once.** \`reddit_monitor_webhook_create\` with the channel's incoming-webhook URL. A \`hooks.slack.com\` or \`discord.com/api/webhooks\` URL has its payload shape inferred from the host. The signing secret is returned once and never again, so store it with the webhook id.
3. **Create each watch.** \`reddit_set_watch\` with a sentence naming the competitor in quotes, and \`deliver_to\` set to the same URL. It compiles the sentence, reads the plan's capabilities, creates the monitor, registers and points the delivery target, and test-fires it in one call.
4. **Cut the false positives.** A brand name that is also an ordinary word produces noise. Two controls, both on \`reddit_monitor_update\`: \`exclude_terms\` drops matches containing a term, and \`search_in: ["title", "body"]\` stops a term matching only inside a URL slug. On a plan that carries it, \`min_relevance\` scores each match against the monitor's own keywords and records what it withheld rather than discarding it silently.
5. **Confirm it is actually watching.** \`reddit_monitor_health\` for each monitor. Read \`stream_liveness\` first: a feed that is never polled writes nothing to the poll log and looks identical to a quiet subreddit. Then \`coverage_24h\`. A status of \`unknown\` or \`partial\` means the question went unanswered, not that nothing was missed.
6. **See what landed.** \`reddit_monitor_deliveries\` returns the actual items sent, each with a relevance score, a sentiment reading and an intent tag.

## Reading a quiet monitor

A delivered count far below a matched count is usually the freshness gate, not a fault: \`suppressed_breakdown\` in monitor health splits \`ceiling\` (the daily cap) from \`stale\` (the item was already old when first seen). A \`stale\` withhold cannot be recovered by retrying.

## Backfill

A monitor is forward-looking from the moment it is created. For what was said before that, \`reddit_search\` with \`sort: "relevance"\` and a \`t\` window, and \`reddit_deep_comment_search\` for the comment bodies rather than their parent posts.
`,
  },
  {
    slug: "subreddit-audit",
    name: "subreddit_audit",
    title: "Subreddit audit",
    description:
      "A recipe for profiling one subreddit before posting in it: size and activity, the rules as written, the moderator team, what the top posts look like and how fast the comment feed moves.",
    body: `# Subreddit audit

A profile of one community, built before anything is posted into it, from the calls this server already exposes.

## Steps

1. **Size and shape.** \`reddit_subreddit_about\` returns subscribers, active users, creation date, type and the NSFW flag. Subscriber count alone says little: a community of 800,000 with a slow comment feed behaves nothing like one of 40,000 with a fast one.
2. **The rules as written.** \`reddit_subreddit_rules\` returns each rule with what it applies to (posts, comments or all) plus Reddit's site-wide rules. Most self-promotion bans live here in the subreddit's own words.
3. **The rules as enforced.** \`reddit_subreddit_wiki\` with \`page: "index"\`, and where it exists \`page: "rules"\`. A wiki commonly carries the longer version and the exceptions the short rule list leaves out.
4. **Who enforces them.** \`reddit_subreddit_moderators\` returns the team with each moderator's permissions and when they joined. A team of one, or a team whose newest member joined years ago, is a different moderation posture from an active rota.
5. **What does well.** \`reddit_subreddit_top\` with \`t: "month"\` and again with \`t: "year"\`. The month view is the current format; the year view is what endures.
6. **What is being posted now.** \`reddit_subreddit_posts\` with \`sort: "new"\` for the unfiltered intake, and \`sort: "rising"\` for what the community is picking up this hour.
7. **How fast the room moves.** \`reddit_subreddit_comments\` streams the newest comments across the whole subreddit. Two calls a few minutes apart give the real comment rate, which decides whether a post has hours of visibility or minutes.
8. **Whether posts survive.** \`reddit_post_visibility\` on a handful of the newest posts. A removed post still returns when fetched by id, so the post alone does not answer this. A verdict of \`undecidable\` is a real answer.

## Reading the result

A high subscriber count with a slow comment feed and a strict rule list is a read-only community. A moderate count with a fast feed and a short rule list is where a question gets answered.

## Related communities

\`reddit_search_communities\` on the same topic finds the smaller rooms where the same conversation happens with less competition.
`,
  },
  {
    slug: "pain-point-mining",
    name: "pain_point_mining",
    title: "Pain-point mining",
    description:
      "A recipe for finding the problems people describe in their own words on Reddit, ranking them by how often they recur, and identifying who keeps raising them.",
    body: `# Pain-point mining

The problems a market describes in its own words, taken from comment bodies rather than post titles.

## Why comments

A post title is written to attract attention. A comment is written to answer somebody. The sentence that names a real problem is almost always in a comment, which is why this recipe leans on comment search rather than post search.

## Steps

1. **Start from complaint-shaped language, not product names.** Phrases such as "I gave up on", "the worst part of", "is there anything that", "I still do this manually" find problems; a product name finds opinions about a product.
2. **Read the comments themselves.** \`reddit_deep_comment_search\` returns the matching comment bodies with their score, author and a comment-deep permalink. \`reddit_search_comments\` returns only the parent posts, which loses the sentence. Set \`limit\` to how many parent posts to expand, and \`sort: "relevance"\` with a \`t\` window so old high-score threads do not crowd out current ones.
3. **Find who keeps saying it.** The same call with \`group_by: "author"\` returns the distinct people ranked by how many of their comments matched, with the subreddits they matched in and their top comment. A problem three hundred people mention once is a different finding from one thirty people mention repeatedly.
4. **Scope it to a community when the general search is too noisy.** \`reddit_search\` with \`subreddit\` set narrows the matching set itself, which a sort change cannot do.
5. **Read the whole thread for the best hits.** \`reddit_post_comments\` with the permalink returns the post and its comment tree, which is where the workaround people settled on usually sits.
6. **Check the person is real.** \`reddit_user_profile\` for account age and karma, \`reddit_user_comments\` for whether this is a recurring subject for them or a one-off.
7. **Keep it running.** \`reddit_set_watch\` with the complaint phrase in quotes turns a one-off sweep into a standing feed, and \`kind\` set to comments matches where this language actually appears.

## Ranking what comes back

Three signals, in order: how many distinct authors raised it, whether the thread reached a workaround or stopped at the complaint, and whether it recurs across subreddits or lives in one. A problem that appears in several unrelated communities is a market, not a niche.

## A caution on counts

A search result page is bounded by \`limit\` and a null \`after\` does not mean the listing is complete. The response carries \`listing_status\`, and only \`complete\` means nothing is missing. A frequency count taken from a truncated page is a count of that page.
`,
  },
];

export function playbookUri(slug) {
  return `${PLAYBOOK_SCHEME}://${slug}`;
}

/**
 * Register every playbook on an McpServer. Called by createServer, which is
 * what makes them part of the same catalog every caller receives.
 */
export function registerPlaybooks(server) {
  for (const p of PLAYBOOKS) {
    server.registerResource(
      p.name,
      playbookUri(p.slug),
      { title: p.title, description: p.description, mimeType: "text/markdown" },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: p.body }],
      }),
    );
  }
  return PLAYBOOKS.length;
}
