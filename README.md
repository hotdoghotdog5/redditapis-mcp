# redditapis-mcp

[![npm version](https://img.shields.io/npm/v/redditapis-mcp)](https://www.npmjs.com/package/redditapis-mcp)
[![npm downloads](https://img.shields.io/npm/dm/redditapis-mcp)](https://www.npmjs.com/package/redditapis-mcp)
[![license](https://img.shields.io/npm/l/redditapis-mcp)](./LICENSE)

Official **Model Context Protocol** server for [redditapis.com](https://www.redditapis.com), the Reddit API as native tools for Claude, Cursor, Windsurf, and any MCP client. It turns Reddit reads (search, subreddit listings, comment trees, user profiles, community metadata) into typed tools your agent can call directly, plus (since 0.2.0) managing your own redditapis.com monitors and webhooks, and (since 0.4.0) sending the team product feedback the agent drafted and you reviewed.

Ask your agent to search Reddit for a topic, read a community's top posts of the week, pull a user's comment history, surface the redditors talking about a product, or read a subreddit's rules before you engage, and it calls the API for you. It can also set up a monitor that watches a subreddit for new posts matching a filter and delivers them to a webhook, then check what it's actually delivered. Every tool maps to a REST endpoint at `https://api.redditapis.com`; the server holds no state and forwards your API key on each call.

## Quick start

No install needed. Run with `npx`. You need one thing: an API key from **[redditapis.com](https://www.redditapis.com)**. Reads work with just that key, so there is no account login or session step to set up. Monitor/webhook management additionally requires an active monitoring plan (monitoring has no free tier).

## Setup

### Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

Restart Claude Desktop. The `reddit_*` tools appear in the tool picker.

### Claude Code

```bash
claude mcp add reddit --env REDDITAPIS_KEY=YOUR_API_KEY -- npx -y redditapis-mcp@latest
```

### Cursor

`~/.cursor/mcp.json` (or Settings > MCP > Add New Server):

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### VS Code (Copilot / agent mode)

`.vscode/mcp.json` in your workspace, or the user-level MCP settings:

```json
{
  "servers": {
    "reddit": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": { "REDDITAPIS_KEY": "YOUR_API_KEY" }
    }
  }
}
```

### Open WebUI

Open WebUI's native MCP client is **Streamable HTTP only** (v0.6.31+), so a stdio server like this one reaches it through [mcpo](https://github.com/open-webui/mcpo), the official MCP-to-OpenAPI proxy. Write a config file, because that is also where the size knobs live:

```json
// mcp_config.json
{
  "mcpServers": {
    "reddit": {
      "command": "npx",
      "args": ["-y", "redditapis-mcp@latest"],
      "env": {
        "REDDITAPIS_KEY": "YOUR_API_KEY",
        "REDDITAPIS_MCP_SKIP_TOOLS": "reddit_monitor_*,reddit_feedback_*"
      }
    }
  }
}
```

```bash
mcpo --host 0.0.0.0 --port 8000 --config mcp_config.json
```

Then in Open WebUI: **Admin Settings → Integrations (External Tools) → Add → OpenAPI**, URL `http://localhost:8000/reddit` (mcpo mounts each server under its own route). Open WebUI re-sends every connected server's tool list on every turn, so the `REDDITAPIS_MCP_SKIP_TOOLS` line above is the one worth setting there: it drops the monitoring, webhook and feedback tools a research chat never uses, from 46 tools to 29 and from ~18,600 tokens of tool descriptions to ~10,700. The registry also advertises a hosted streamable-HTTP endpoint (`https://api.redditapis.com/mcp`) for a direct **MCP (Streamable HTTP)** connection with no local process.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `REDDITAPIS_KEY` | Yes | (none) | API key from [redditapis.com](https://www.redditapis.com). `REDDIT_APIS_KEY` is accepted as an alias. |
| `REDDITAPIS_BASE_URL` | No | `https://api.redditapis.com` | Override the API host. |
| `REDDITAPIS_TIMEOUT_MS` | No | `30000` | Per-request timeout in milliseconds. |
| `REDDITAPIS_FEEDBACK_DIR` | No | `~/.redditapis` | Where `reddit_feedback_send` keeps its local draft queue (`feedback-queue.json`). |
| `REDDITAPIS_MCP_MAX_BYTES` | No | `16000` | Ceiling on the text of one read result (~4,000 tokens). Rows and text are trimmed to stay inside it. |
| `REDDITAPIS_MCP_DEFAULT_LIMIT` | No | `10` | The `limit` sent for a read that did not ask for one. `0` leaves the endpoint's own default (25 on the listings) alone. Never raised above an endpoint's own default. |
| `REDDITAPIS_MCP_MAX_COMMENTS` | No | `10` | Comments kept per post tree, the highest-scored. |
| `REDDITAPIS_MCP_MAX_REPLIES` | No | `1` | Replies kept under each kept comment, the highest-scored. |
| `REDDITAPIS_MCP_COMMENT_DEPTH` | No | `1` | Reply levels kept below each kept comment. |
| `REDDITAPIS_MCP_BODY_CHARS` | No | `1200` | Ceiling on a post's `selftext`, a subreddit description and similar fields. |
| `REDDITAPIS_MCP_COMMENT_BODY_CHARS` | No | `400` | Ceiling on a comment `body`. Separate because a payload carries thirty of them per post. |
| `REDDITAPIS_MCP_TEXT_CHARS` | No | `400` | Ceiling on any other long string. |
| `REDDITAPIS_MCP_MAX_FIELD_BYTES` | No | `900` | Ceiling on a nested field this package has never seen; over it, the field becomes `"[trimmed N bytes: name]"`. |
| `REDDITAPIS_MCP_DROP_FIELDS` | No | (built-in list) | Comma list of extra Reddit fields to drop; `*` for a prefix, e.g. `"preview,link_flair_*"`. |
| `REDDITAPIS_MCP_KEEP_FIELDS` | No | (built-in list) | Comma list of fields to protect from the drop list. |
| `REDDITAPIS_MCP_RAW` | No | off | `1` returns the upstream body verbatim, exactly as releases before 0.11.0 did. |
| `REDDITAPIS_MCP_SKIP_TOOLS` | No | (none) | Comma list of tool-name patterns to leave unregistered, e.g. `"reddit_monitor_*,reddit_feedback_*"`. Each registered tool costs its description in the model's context on every turn. |

Authentication is a Bearer token: the server sends `Authorization: Bearer <REDDITAPIS_KEY>` on every request.

## Context size: what one read costs the model

An MCP tool result goes back into the model's context on the next turn, and Reddit's own JSON is a browser payload: a post object carries roughly 90 keys of which a dozen are the answer, `media_metadata` is 1-15 KB per gallery post, and a comment tree has no width or depth limit at all. Unshaped, one ordinary research turn -- a search, a subreddit listing, a 60-comment thread, a deep comment search -- measured **1,785,339 bytes (~446,000 tokens)**, which on its own overflows a 262,144-token window and kills the chat. So reads are shaped on the way out (`src/compact.js`):

| What happens | Default |
|---|---|
| A read with no `limit` asks the endpoint for | 10 instead of 25 |
| Reddit's media, preview, flair-blob, award, report and client-flag fields | dropped |
| Comments kept from a post tree, highest-scored first | 10, each with its 1 best reply, 1 reply level deep |
| `[deleted]` / `[removed]` comments | dropped |
| A comment body longer than | 400 characters |
| A `selftext` longer than | 1200 characters |
| Any one nested field this package does not know | 900 bytes, then a `"[trimmed N bytes: name]"` marker |
| The text of a whole result | 16,000 bytes (~4,000 tokens) |

The same four calls measured against those rules: **38,797 bytes (~9,700 tokens), 46x smaller**, every one inside its ceiling. Reproduce it yourself -- it needs no key and no network:

```bash
npm run measure:context
```

Every trimmed result carries a `context` block saying what was cut, so a short answer never reads like a thin topic:

```json
{
  "posts": [ ... 8 compact posts ... ],
  "after": "t3_lastcursor",
  "context": {
    "source_bytes": 149181, "bytes": 7841, "budget_bytes": 16000, "est_tokens": 1961,
    "limit_defaulted": 10,
    "trimmed": { "fields": 1193, "empty": 101, "bodies": 25, "rows": 17 },
    "how_to_widen": "raise `limit`, page with `after`, or set REDDITAPIS_MCP_RAW=1 for the untrimmed body"
  }
}
```

Three things are never touched: **writes** (a webhook creation response carries its signing secret exactly once), the free `/feedback` and `/account` mounts, and **local tools**. The byte budget gives up comment bodies first, then reply depth, and whole rows last, so the number of answers is the last thing sacrificed. If you want the old behaviour back wholesale, set `REDDITAPIS_MCP_RAW=1`; if you want it tuned, the knobs above are all environment variables, and `scripts/measure-context.mjs` is how to see what a change to them costs.

The catalog itself is also context: measured by the same script, the 46 tools carry 74,275 bytes (~18,600 tokens) of tool and parameter description text that a client re-sends on every turn. A client that only researches Reddit can drop the monitoring, webhook and feedback tools entirely:

```json
"env": { "REDDITAPIS_KEY": "YOUR_API_KEY", "REDDITAPIS_MCP_SKIP_TOOLS": "reddit_monitor_*,reddit_feedback_*,reddit_set_watch" }
```

That leaves 29 tools and 42,786 bytes of description text, and a call to an excluded tool fails as an unknown tool rather than silently doing nothing.

## Tools

46 tools and 3 playbook resources: 30 Reddit reads, 10 monitor/webhook management tools, `reddit_set_watch` (one call that stands up a whole watch), `reddit_explain` (where the rows you are holding came from), 3 feedback tools, and 1 account tool (`reddit_account_me`, which is also where the credit balance lives). Reddit writes (posting, commenting, voting, DMs) remain a separate authenticated surface and are intentionally out of scope here -- monitor/webhook tools configure your OWN redditapis.com account (an alerting subscription), never Reddit itself, and the feedback tools send a report to the redditapis.com team, never to Reddit. Every read works with just your API key; the 6 monitor/webhook writes additionally need an active monitoring plan (see Monitoring below). The feedback tools are free and need only your key.

A few conventions across the catalog:

- Subreddit names go in **without** the `r/` prefix, and usernames **without** the `u/` prefix. `reddit_subreddit_posts` takes its community as `subreddit`; the `/sub/{name}/...` tools take it as `name`.
- Listing and search tools return an `after` cursor. Pass it back as `after` to fetch the next page, exactly as it was returned. `limit` accepts 1 to 100 (the API clamps out-of-range values); when you omit it, this server asks the endpoint for 10 rather than Reddit's 25, and says so in the response's `context` object (see Context size above).
- When `after` comes back `null` there is no next page to ask for. That does not always mean you have every item: Reddit often stops serving a busy listing long before it runs out. The final response also carries `listing_status`, which reads `complete`, `truncated` or `unknown`. Only `complete` means nothing is missing. Treat the other two as a partial answer and widen across sorts, timeframes or search terms rather than paging deeper.
- `t` (`hour`, `day`, `week`, `month`, `year`, `all`) sets the time window; on subreddit listings it applies to the `top` and `controversial` sorts, and on search it bounds the whole result set.

### Search and discovery

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_search` | `GET /api/reddit/search` | Search posts across all of Reddit or within one subreddit (`subreddit`). |
| `reddit_search_comments` | `GET /api/reddit/search/comments` | Search by comment text; returns the parent posts, since Reddit's comment search does not hand back the matching comment itself. |
| `reddit_deep_comment_search` | `GET /api/reddit/search/comments/deep` | Genuine comment search: returns the actual matching comment bodies (score, author, comment-deep permalink, parent post). `limit` sets how many parent posts to expand; `group_by="author"` switches to research mode (the distinct people talking about your query). Premium call. |
| `reddit_search_media` | `GET /api/reddit/search/media` | Search posts filtered to media, narrowed by `kind` (`image`, `video`, `gif`, `all`). |
| `reddit_search_communities` | `GET /api/reddit/search/communities` | Find subreddits by name or topic (title, subscribers, description, NSFW flag). |
| `reddit_search_users` | `GET /api/reddit/search/users` | Find redditors by name or keyword (username, karma, account age). |

### Subreddits

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_subreddit_posts` | `GET /api/reddit/posts` | List a subreddit's posts by `sort` (`new`, `hot`, `top`, `rising`, `controversial`, `best`). |
| `reddit_feedback_list` | `GET /feedback` | List the reports this account has sent, newest first, with their status. The way back to a report whose id was not kept. Free. |
| `reddit_verify_comments` | `POST /api/reddit/comments/verify` | Check whether up to 100 specific comments still exist and are publicly visible. A read despite the POST; tells 'deleted by author' from 'removed by a mod' from 'still there'. |
| `reddit_home_feed` | `GET /api/reddit/feed` | Read YOUR OWN Reddit home feed. Needs your `reddit_session` and `loid` from `POST /api/reddit/login` (a REST call, not an MCP tool); they travel as headers, never in the URL. |
| `reddit_subreddit_top` | `GET /api/reddit/sub/{name}/top` | Top posts of a subreddit for a time window (`t`). |
| `reddit_subreddit_comments` | `GET /api/reddit/sub/{name}/comments` | Stream the newest comments across an entire subreddit (not one post's thread). |
| `reddit_subreddit_about` | `GET /api/reddit/sub/{name}/about` | A subreddit's public metadata: title, description, subscriber and active-user counts, type, NSFW flag. |
| `reddit_subreddit_rules` | `GET /api/reddit/sub/{name}/rules` | A subreddit's posting rules plus Reddit's site-wide rules. |
| `reddit_subreddit_moderators` | `GET /api/reddit/sub/{name}/moderators` | A subreddit's moderator team, each with permissions, flair, and when they joined. |
| `reddit_subreddit_wiki` | `GET /api/reddit/sub/{name}/wiki/{page}` | A subreddit's wiki page by name and `page` (markdown + HTML, revision metadata). |

### Posts and comments

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_post_visibility` | `GET /api/reddit/post/{id}/visibility` | Is a post still publicly visible, or did it quietly stop being so? Fetches the post and one page of its author's listing and compares. Returns `live`, `not_visible` or `undecidable` with a reason, and never claims to know WHY. Two upstream calls, $0.004. |
| `reddit_post` | `GET /api/reddit/post/{id}` | A single post by its base-36 `id` (no `t3_` prefix): title, author, score, text, permalink, subreddit, url. |
| `reddit_post_comments` | `GET /api/reddit/comments` | A post plus its full threaded comment tree, fetched by `permalink`. |
| `reddit_by_id` | `GET /api/reddit/by_id/{fullnames}` | Bulk-hydrate up to 100 posts in one call from a comma-separated list of `t3_` fullnames. |

### Users

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_user_profile` | `GET /api/reddit/user/{name}` | A user's public profile: karma, account age, verified/employee flags, avatar. |
| `reddit_user_comments` | `GET /api/reddit/user/{name}/comments` | A user's recent comments (body, score, subreddit, parent link, timestamp). |
| `reddit_user_submitted` | `GET /api/reddit/user/{name}/submitted` | A user's submitted posts (the sibling of `reddit_user_comments`). |
| `reddit_user_achievements` | `GET /api/reddit/user/{name}/achievements` | A user's public achievements (the trophies on their profile): name, description, granted timestamp, icons. An account with none returns an empty list. |

### Community browse (no keyword)

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_subreddits_popular` | `GET /api/reddit/subreddits/popular` | Browse the most-subscribed, trending subreddits right now. |
| `reddit_subreddits_new` | `GET /api/reddit/subreddits/new` | Browse the newest subreddits, most recently created first. |
| `reddit_subreddits_default` | `GET /api/reddit/subreddits/default` | Browse Reddit's default front-page set of subreddits. |

### Monitoring: manage your own monitors and webhooks

Monitors watch **named subreddits or all of Reddit**, for **posts or comments** (`kind`). Every account holds a free entitlement of one all-of-Reddit post watch at a 60s cadence; naming a subreddit, matching comments, a faster cadence and any further watch need a paid plan. Registering a webhook does **not** need a paid plan, because the free watch delivers to one exactly like a paid watch does. Reading your own list, health and deliveries never needs a plan.

`reddit_monitor_list` returns a `slots` object that states this account's capabilities outright: `used`, `total`, `tier`, `is_free`, `cadence_s` (the tier's cadence floor), `sitewide_slots`, `distinct_subreddits_used`, `distinct_subreddits_total`, `comments_allowed`, `scoped_allowed` and `sitewide_allowed`. `reddit_set_watch` reads those flags before it builds anything.

| Tool | Endpoint | What it does |
|---|---|---|
| `reddit_set_watch` | `POST /api/reddit/monitor/add` (+ webhook create/update/test) | One call instead of three: compiles a plain-words description into a monitor filter, reads this account's plan capabilities, creates the monitor, then registers, points and test-fires the `deliver_to` webhook. Quoted phrases are taken out of the sentence first, then it is cut into clauses, so each part reads only its own words: subreddits as `r/Name` **or a pasted `reddit.com/r/Name` link**, quoted phrases as keyword terms, `except`/`without`/`ignoring` as exclusions, `at least N upvotes` as a score floor, `comments` / `posts and comments` as the match kind. **It never returns a filter it cannot fully account for** (see below). Returns `understood` and `compiled_filter` so you can check it, and `notes` names anything it dropped, rewrote or read as a whole phrase. |
| `reddit_monitor_add` | `POST /api/reddit/monitor/add` | Create a monitor: subreddits to watch plus an optional filter (keyword, author, domain, include/exclude terms, min score, NSFW). Forward-looking only from creation (or from `baseline_item_id`). |
| `reddit_monitor_list` | `GET /api/reddit/monitor/list` | List every monitor on your account, plus `slots` ({used, total, tier}). |
| `reddit_monitor_update` | `POST /api/reddit/monitor/update` | Pause/resume (`active`), re-cadence, or replace a monitor's filter. Passing any filter field REPLACES the whole filter -- resupply everything you want kept. |
| `reddit_monitor_remove` | `POST /api/reddit/monitor/remove` | Permanently delete a monitor. Cannot be undone. |
| `reddit_monitor_health` | `GET /api/reddit/monitor/health` | Per-monitor delivered/failed/suppressed counts (last 24h), `suppressed_breakdown` splitting those suppressions into `ceiling` and `stale` reasons, and whether the delivery ceiling specifically has been hit. |
| `reddit_monitor_deliveries` | `GET /api/reddit/monitor/deliveries` | The actual posts delivered (or attempted), newest first, with real content -- not just counts. Omit `id` to aggregate across every monitor you own. |
| `reddit_monitor_webhook_create` | `POST /api/reddit/monitor/webhook/create` | Register a delivery target (`webhook`/`slack`/`discord`). Returns a signing secret shown ONCE. |
| `reddit_monitor_webhook_list` | `GET /api/reddit/monitor/webhook/list` | List your webhooks. Never returns the secret. |
| `reddit_monitor_webhook_test` | `POST /api/reddit/monitor/webhook/test` | Send a one-off test delivery to confirm a webhook is wired up correctly. |
| `reddit_monitor_webhook_delete` | `POST /api/reddit/monitor/webhook/delete` | Permanently delete a webhook. Does not cascade-pause monitors still pointing at it. |

#### `reddit_set_watch` refuses rather than guesses

Every character of your description has to be claimed by exactly one thing: a subreddit, a quoted phrase, a keyword, an exclusion, a score clause, a delivery clause, or a word that carries no filter content. Anything left over means the compiler did not understand the whole sentence, and it returns **no filter at all** rather than a monitor built from the half it did understand.

| outcome | when | what you get |
|---|---|---|
| a filter | every word is accounted for | the monitor, plus `understood`, `compiled_filter` and `notes` |
| `partial_understanding` | some words could not be placed, or two parts of the filter counted the same words twice | the exact unplaced words, what *was* understood, and nothing created |
| `contradictory_filter` | the same phrase is both watched for and excluded, so the monitor could never deliver | both halves named, and nothing created |
| `no_anchor` | neither a subreddit nor a keyword | a refusal, before any request is sent |

This matters because a wrong watch is **invisible**: you get a monitor id, a green test delivery, and then either silence forever or a firehose. A refusal that names the words it could not place is recoverable in seconds; a monitor whose keyword is also its exclusion is not noticed for a week. If a description is refused, quote the exact phrase to watch for, write subreddits as `r/Name`, or build the filter directly with `reddit_monitor_add`.

### Playbooks: three recipes, served as MCP resources

Three reusable recipes ship as MCP **resources** rather than tools, because the protocol makes resources application-driven: a host shows them in a picker or a search box and reads one only when it is asked for by URI. Nothing is prefetched and nothing is injected.

| URI | What it covers |
|---|---|
| `playbook://competitor-mention-watch` | Standing up continuous coverage of competitor names and routing every match to a channel, including how to cut the false positives a brand name that is also an ordinary word produces, and how to tell a quiet monitor from a broken one. |
| `playbook://subreddit-audit` | Profiling one community before posting in it: size against real comment rate, the rules as written and as enforced, the moderator team, what endures versus what is working this month, and whether posts survive. |
| `playbook://pain-point-mining` | Finding problems in the words people actually use, from comment bodies rather than post titles, ranking them by distinct authors rather than hits, and turning a one-off sweep into a standing feed. |

Each is a short markdown document built only from calls this package already exposes, so a recipe cannot point at something unbuilt. A test checks every tool each playbook names against the live catalog.

The bodies are documentation and name the calls they are recipes for, which is the point of them. That is a deliberate difference from tool **descriptions**, which a client fetches at connect time and nobody chose: those state product facts only and a gate enforces it. A resource is read only when something asks for its URI, so it is a document you opened, not an injection. The bodies are still checked for hidden or encoded text, for any link off our own hosts, and for adversarial steering (overriding your instructions, concealment, exfiltration, or spending your credits in a loop), each with a planted-defect control.

```jsonc
// resources/list, then
{ "method": "resources/read", "params": { "uri": "playbook://subreddit-audit" } }
```

### Feedback: tell the team what broke, after you review the draft

Modelled on Claude Code's own feedback tool. When a call fails in a way that is not your key, credits or a rate limit, when you ask for something no tool covers, or when a result is plainly wrong, the model can **draft** a report into a local queue (`~/.redditapis/feedback-queue.json`, at most 10 drafts, override the directory with `REDDITAPIS_FEEDBACK_DIR`). Nothing is sent until you ask to review the queue and name the drafts to send. Each report carries the last failing call's endpoint, status and request id, your client name and this package's version, so the team can act on it without a follow-up. Use `reddit_feedback_get` with the returned server id to see whether it was triaged, shipped or declined. Both tools are free.

| Tool | Endpoint | What it does |
|------|----------|--------------|
| `reddit_feedback_send` | `POST /feedback` | `action: "draft"` (default) queues a report locally and sends nothing; `"list"` shows the queue; `"send"` posts only the drafts you name; `"discard"` drops them. |
| `reddit_explain` | none (in-process) | Provenance for the rows already fetched in this session: per completed call, the tool, the endpoint, when the response arrived, how old that copy now is, the upstream request id and the response size. The read path holds no response cache, so the age is the age of your copy, not of a stored row. |
| `reddit_account_me` | `GET /account/me` | How much credit this key has left, before spending any. Free, never metered. |
| `reddit_feedback_get` | `GET /feedback/{id}` | Read a sent report's status (`new`, `triaged`, `shipped`, `declined`) and the team's response. |

## Usage examples

### Research a topic across Reddit

> "What are people saying about the Rust borrow checker this month?"

The agent calls `reddit_search` with:

```
q: "borrow checker"
sort: "relevance"
t: "month"
sort_type: "score"
```

### Read a community's top posts of the week

> "Show me the top posts in r/programming this week."

The agent calls `reddit_subreddit_top` with:

```
name: "programming"
t: "week"
```

To page further, pass the `after` cursor from the response back on the next call: `{ name: "programming", t: "week", after: "<after from response>" }`.

### Find who is talking about a product

> "Which redditors are recommending mechanical keyboards, and what do they say?"

The agent calls `reddit_deep_comment_search` with:

```
q: "mechanical keyboard"
group_by: "author"
sort: "relevance"
```

Research mode returns the distinct people who mentioned the query, ranked by how many of their comments matched, each with their top comment and the subreddits they matched in.

### Vet a subreddit, then read a thread

> "Find a discussion about API rate limiting in r/webdev, check the sub's rules, and read the full thread."

The agent calls `reddit_search` scoped to the community:

```
q: "rate limiting"
subreddit: "webdev"
sort: "relevance"
t: "year"
```

Then `reddit_subreddit_rules` with `{ name: "webdev" }`, and finally `reddit_post_comments` with the `permalink` from a search result, for example `{ permalink: "/r/webdev/comments/abc123/some_title/" }`, to pull the post and its comment tree.

### Set up brand monitoring and check what came in

> "Watch r/SaaS and r/startups for mentions of my product, send matches to my Slack, and show me what's come in so far."

The agent calls `reddit_monitor_webhook_create` with:

```
url: "https://hooks.slack.com/services/..."
kind: "slack"
```

Then `reddit_monitor_add` with:

```
subreddit: ["SaaS", "startups"]
q: "my product name"
```

Later, `reddit_monitor_deliveries` with `{ id: "<monitor id from the add response>" }` returns the actual matching posts sent so far, or `reddit_monitor_health` for just the counts.

## No session needed for reads; monitor/webhook writes need an active plan

Reads need nothing but your API key -- no account linking, login, or cookie step. Reddit write actions (posting, commenting, voting, sending DMs) are handled by a separate authenticated surface outside this package and remain deliberately not exposed here, so an agent using this server can never post, vote, or DM as you on Reddit. Monitor/webhook management tools are a different kind of write: they configure your OWN redditapis.com account (an alerting subscription) and require an active monitoring plan for anything that creates or changes state (`reddit_monitor_add`/`update`/`remove`, `reddit_monitor_webhook_create`/`test`/`delete`); reading your own list, health, or delivery history never does.

## Troubleshooting

**`HTTP 401 (invalid or missing API key)`** Check that `REDDITAPIS_KEY` is set correctly in your MCP client config and matches the key from [redditapis.com](https://www.redditapis.com).

**`HTTP 402 (insufficient credits)`** Top up your account at [redditapis.com](https://www.redditapis.com). For a monitor/webhook write specifically, a 402 body of `subscription_required` means there is no active monitoring plan (monitoring has no free tier); `monitor_slots_exhausted` means the plan's monitor slot limit is already in use -- `reddit_monitor_list`'s `slots` field shows used vs total.

**`HTTP 403 (access forbidden)`** The subreddit or user may be private, banned, or quarantined, or your plan may not include this endpoint.

**`HTTP 404 (not found)`** The subreddit, post id, user, or permalink may be wrong or the content may have been deleted or removed.

**`HTTP 429 (rate limited)`** Wait a few seconds and retry, or reduce request frequency. For bulk work, space out calls and raise `REDDITAPIS_TIMEOUT_MS`.

**`Request failed: timed out after 30000ms`** The default timeout is 30 seconds. For large `reddit_deep_comment_search` or paginated fetches, set `REDDITAPIS_TIMEOUT_MS` higher (for example `60000`).

**The chat dies with a context-overflow error after a few Reddit calls** Since 0.11.0 a read result is capped at 16,000 bytes by default, so this should not happen with `redditapis-mcp` alone. Check whether `REDDITAPIS_MCP_RAW=1` is set (that returns Reddit's full body), and check the other servers connected to the same chat: the tool catalog of every connected server is re-sent on every turn, and this one costs about 18,600 tokens for all 46 tools. `REDDITAPIS_MCP_SKIP_TOOLS` trims that. `npm run measure:context` prints the numbers.

**Tools do not appear in Claude / Cursor** Ensure `npx` is on your PATH and Node.js 18+ is installed (`node --version`). Check your MCP client logs for startup errors.

## Development

```bash
npm install
npm run check   # syntax-check every source file
npm test        # unit-test the catalog, query/path builders and the response shaper (no network)
npm run measure:context  # bytes and tokens a batch of reads costs, unshaped vs shaped
npm start       # run the stdio server (needs REDDITAPIS_KEY)
```

## Links

- Site and API keys: [redditapis.com](https://www.redditapis.com)
- REST API base URL (call it directly, without MCP): `https://api.redditapis.com`

## FAQ

**Do I need a Reddit developer account?** No. Get an API key at [redditapis.com](https://www.redditapis.com); there is no application or approval step.

**Can it post, comment, or vote?** No. All 30 Reddit-facing tools read Reddit; posting, commenting, voting, and DMs are a separate authenticated surface and are not exposed here. Of the other 14, the 10 monitor/webhook tools manage your OWN redditapis.com monitors and webhooks (a write, but never a write to Reddit itself), the 3 feedback tools send or read a report to the redditapis.com team, and `reddit_account_me` reads your own balance and plan.

**Which clients are supported?** Claude Desktop, Claude Code, Cursor, Windsurf, and VS Code (Copilot agent mode), or any Model Context Protocol client.

**Does it store my key or data?** No. The server holds no state and forwards your API key on each call.

## License

MIT
