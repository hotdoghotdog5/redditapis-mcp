# Changelog

## 0.11.0 (2026-10-10)

### Reads stop arriving at the size of a browser page

A report from a customer running this server inside Open WebUI: **four Reddit calls
in one turn returned about 800,000 characters**, and the chat died on context
(their window is 262,114 tokens). Nothing in this package was broken. The tool
answered with the body the API sent, and the client put that body back into the
model's context on the next turn.

**The body is Reddit's own JSON, and Reddit's JSON is a browser payload.** A post
object carries ~90 keys and a model reads about a dozen of them; `media_metadata`
and `preview` are 1-15 KB on a gallery post; and `GET /api/reddit/comments` takes
only `permalink` -- no `limit`, no `depth` -- so a comment tree comes back with no
width or depth bound at all. Measured on the new fixture
(`test/fixtures/reddit-shapes.mjs`, no key and no network needed), the four reads
of one ordinary research turn cost **1,785,339 bytes, about 446,000 tokens**:

| read | unshaped | shaped |
|---|---|---|
| `reddit_search` | 149,181 | 7,841 |
| `reddit_subreddit_posts` | 149,181 | 7,841 |
| `reddit_post_comments` | 1,109,096 | 14,552 |
| `reddit_deep_comment_search` | 377,881 | 8,563 |
| **batch** | **1,785,339 (~446,000 tok)** | **38,797 (~9,700 tok)** |

`src/compact.js` now shapes a plain GET read of `/api/reddit/*` on its way out: a
read with no `limit` asks for **10** rather than Reddit's 25 (never more than an
endpoint's own default -- `reddit_deep_comment_search` keeps its 5, because it
bills for fan-out), Reddit's media/preview/flair-blob/award/report/client-flag
fields go, a comment tree returns its **top 10 comments by score, each with its 1
best reply, 1 reply level deep**, `[deleted]` and `[removed]` go, a comment body
is bounded at 400 characters and a `selftext` at 1200, and the whole result is
capped at **16,000 bytes (~4,000 tokens)**. That is 46x smaller on the batch above,
with every call inside its ceiling -- `npm run measure:context` prints it.

**Nothing is cut silently.** A trimmed result carries a `context` object: bytes in
and out, the token estimate, the budget, counts per kind of cut (`fields`,
`comments`, `pruned`, `bodies`, `rows`), and the one line that says how to widen
the answer. A truncation marker inside a body carries how many characters were
dropped, so a model reading a shortened comment knows it is reading a shortened
comment. Rows survive longest: the byte ladder shortens comment bodies, then reply
depth, and drops whole rows last.

**Structural, not a blocklist.** Reddit ships fields this package has never seen,
so any unknown nested field over 900 bytes becomes `"[trimmed N bytes: name]"`
instead of being guessed at. The drop list is a starting point, extendable with
`REDDITAPIS_MCP_DROP_FIELDS` and `REDDITAPIS_MCP_KEEP_FIELDS`.

**Checked against the live API, not only a fixture.** The docs describe the wrapper
as Reddit's JSON; it is not byte for byte. Captured through an Open WebUI gateway
and kept as `test/fixtures/live-shapes.mjs`: a post body arrives as `text`, not
`selftext`; `comments` on a post is the comment **count**, not a list; and comments
carry bookkeeping the docs never list (`gilded`, `downs`, `author_fullname`,
`controversiality`, `subreddit_type`, a second `created`). Those names were missing
from the drop list at first, and the effect was visible: the ladder hit the ceiling
by squeezing every comment body to 110 characters -- inside budget, useless as an
answer. With them dropped, a live permalink call that came back at **205,234 bytes**
arrives at **15,466 bytes (13x smaller)**, and on the fixture built from that
capture **186,323 becomes 14,223 bytes with every kept comment still holding 400+ 
characters**. A test now fails if a future change meets the ceiling by gutting the
bodies instead of the junk around them.

**Never shaped:** writes (a `reddit_monitor_webhook_create` response carries its
signing secret exactly once, and filtering it would lose a secret with no signal),
the free `/feedback` and `/account` mounts, monitor listings and health, and the
local tools. `callEndpoint` itself stays verbatim, so `reddit_set_watch` still
parses real responses and `reddit_explain` still reports the **upstream** byte
count. `REDDITAPIS_MCP_RAW=1` restores the pre-0.11.0 passthrough byte for byte.

### The catalog is context too

Every registered tool's description is re-sent by the client on every turn:
measured, **74,275 bytes (~18,600 tokens) across 46 tools**, before a single call.
`REDDITAPIS_MCP_SKIP_TOOLS` (or `skipTools` in `createServer`) leaves matching tools
unregistered -- absent from `tools/list`, and a call naming one is an unknown tool,
never a silent no-op. A read-only client drops to 29 tools and 42,786 bytes. Same
registration-time mechanism as `inlineCredentials`.

Also: the `limit` parameter description now says the server defaults it to 10
(it previously told callers the endpoint default applies, which stopped being
true), `reddit_monitor_deliveries` defaults to 20 rows rather than the endpoint's
50 because each row carries a whole webhook envelope, and the server instructions
say that reads arrive trimmed and where to read what was cut.

## 0.10.0 (2026-10-02)

### The watch compiler refuses rather than guesses

Seventeen defects were found in this compiler across three review rounds. Every
single one had the same signature: it consumed part of the description, emitted
a filter anyway, and said nothing. The worst produced a monitor whose keyword
was a single `"` character.

Rounds one and two were both fixed by writing better rules, and both shipped a
suite that pinned the sentences just fixed and could not fail on an input nobody
had thought of. Round two's rewrite broke nine inputs round one handled. More
rules was never going to end.

**So the contract is inverted.** Every character of a description must be
claimed by exactly one thing: a subreddit, a quoted phrase, a keyword, an
exclusion, a score clause, a delivery clause, or a word with no filter content.
Anything left over, or counted twice, and the compiler returns **no filter at
all** and names the words it could not place. A description that both watches
for and excludes the same phrase is refused too, because that monitor could
never deliver.

That inverts the failure mode from "a silently wrong monitor that looks fine" to
"a refusal that says why", which for this feature is the only safe direction:
every failure here is invisible, and the caller otherwise gets a monitor id, a
green test delivery and then silence or a firehose.

Also fixed in the same pass, all found by the change above or by the corpus:
quoted phrases are now taken out of the sentence **before** anything else reads
it, so a marker word, a subreddit or a kind word inside your own quotes is just
text (`for "ignore list"`, `for "except this"`, `for "send to production"` were
all wrecked by this); the match kind is read from the original word positions
rather than a string with substrings deleted, which had turned `posts and
comments for "post"` into a comments-only watch; a subreddit inside a keyword or
exclusion clause ends that clause instead of being swallowed into the term; and
a bare multi-word keyword is reported in `notes`, because an unquoted keyword is
a free-text run and absorbs whatever follows it.

**The suite that could not see any of this has been replaced, not extended.**
`test/watch-invariants.test.mjs` generates 28,511 sentences from pieces chosen
to collide (marker words inside quotes, subreddits inside quotes, markers before
the main clause, unicode quotes, conjunctions) and asserts seven structural
invariants that hold for every input, listed or not. Measured against the two
previous heads with the same corpus: 20,970 violations on the first, 45,072 on
the second, 0 now.

### Fixed before release, after the first review

The watch compiler matched every field with its own regular expression over the
**whole** sentence, so two clauses read the same words and one of them was
wrong. Four HIGH defects, one cause, each one silent:

- `for pricing except "giveaway"` put the EXCLUDED phrase into `q`, so `q` and
  `exclude_terms[0]` were the same string and the monitor could never deliver,
  while the caller got a monitor id, a green test delivery, and then silence.
- `for posts about pricing`, the most natural sentence there is, watched for the
  literal phrase "posts about pricing".
- `for posts with at least 5 upvotes about pricing` dropped the keyword
  entirely, leaving a firehose of every post over the score floor.
- `for "comment moderation"` read the word *comment* out of the caller's own
  keyword and switched the watch to comments only, missing every post.
- A pasted `reddit.com/r/X` link was not read as a subreddit, so the watch went
  site-wide and consumed the account's one free site-wide slot.

The sentence is now cut into clauses **once** and every field reads only its own
span; the match kind is derived last, from what is left after the subreddits,
the quoted spans and the derived terms are removed, so a keyword can never set
it. Patching the pairs one at a time had already produced three green suites
over four live defects, which is why the fix is the structure and not another
rule.

**And a lossy compile is no longer silent.** Every one of the above reported
`notes: []`. When the compiler drops or rewrites something the description
carries, it says so, and that is asserted per case.

Three more in the same family, all "unknown reported as fine":

- The webhook signing secret was read only to set a boolean and then thrown
  away, while the result asserted the secret was in it. The API returns that
  secret exactly once and the webhook list never returns it again, so a watch
  set up this way left its owner permanently unable to verify a delivery
  signature, and told them otherwise. It is now returned as `delivery.secret`,
  and the sentence is tied to the value rather than to a flag about it.
- A test delivery whose body could not be read counted as a SUCCESS
  (`ok !== false`). It is now tri-state, and an unreadable answer says the
  target is unconfirmed.
- When the created monitor came back without an id, the re-point was skipped
  with no note while the result still reported a registered target.

### Added

- **`reddit_set_watch`: one call where standing up a watch took three.** It compiles a plain-words
  description into a monitor filter, reads the account's own plan capabilities, creates the monitor,
  then registers, points and test-fires an optional `deliver_to` webhook. The compiler is a set of
  regular expressions, not a model, so the same sentence always compiles to the same filter, and
  everything it derived comes back in `understood` and `compiled_filter` for a person to check. It
  reads `r/Name` subreddits, quoted phrases as keyword terms (two or more become an any-of set),
  `comments` / `posts and comments` as the match kind, terms after `except` or `ignoring` as
  exclusions, and `at least N upvotes` as a score floor.
  - **The two rules that need no round trip are checked locally.** A description anchored by neither
    a subreddit nor a keyword is refused with zero network calls, and `r/all` is dropped as Reddit's
    site-wide listing rather than sent to earn a `subreddit_reserved` 400.
  - **Plan awareness is a field read, not a guess.** `GET /api/reddit/monitor/list` is free and its
    `slots` object states the account's capabilities outright (`scoped_allowed`, `comments_allowed`,
    `sitewide_allowed`, the cadence floor and the distinct-subreddit allowance). On a plan without
    subreddit-scoped watches, a description that names subreddits and also carries a keyword is
    built over every subreddit instead, and the swap is reported; a description with no keyword has
    no equivalent, so it goes as written and the API answers for itself. An unreadable `slots`
    object rewrites nothing.
  - **Ordered for the failure mode.** The monitor is created before the webhook, because a monitor
    with no `webhook_ids` still delivers to every active webhook on the account, so a watch survives
    a failed webhook registration. The reverse order would strand a webhook pointing at nothing when
    the monitor hits a slot limit.
- **Three playbooks as MCP resources**, at `playbook://competitor-mention-watch`,
  `playbook://subreddit-audit` and `playbook://pain-point-mining`. Resources rather than tools
  because the protocol makes resources application-driven: a host reads one only when it is asked
  for by URI, and nothing is prefetched. Each is built only from calls this package already exposes,
  and a test checks every tool each playbook names against the live catalog, so a recipe cannot
  quietly start pointing at something that does not exist.
- **`reddit_explain`: where the rows you are holding came from.** Per completed call, the tool that
  made it, the endpoint, when the response arrived, how many seconds old that copy now is, the
  upstream request id and the response size. It reaches no endpoint: the ledger is in memory, holds
  the 20 most recent calls, starts empty and is scoped to one server, so one caller's endpoints and
  request ids never reach another's.
  - **It reports no cache age, because there is no cache.** The read path holds no response cache for
    customer reads, so every call is served live and the age that exists is the age of this
    session's copy of the rows, not of a stored row. The result says `response_cache: "none"` rather
    than implying a freshness guarantee nothing provides, and it points at the published retention
    table instead of restating a figure that would drift the day the table changes.

### Changed

- The README's monitoring note said monitors were "subreddit-scoped, posts-only" with "no
  all-of-Reddit keyword watch, no comment monitoring yet", and that a webhook needs an active plan.
  All three have been untrue since 2026-08-13 and the note ships in the npm tarball. It now
  describes the free entitlement, site-wide and comment watching, and the full `slots` object.
- The catalog test allows a `null` path for a local tool that reaches no endpoint, and for nothing
  else; a red test proves a non-local tool with no path, and a foreign prefix with or without a
  local handler, are still refused.
- The description gate audits resource metadata under the full matcher, and resource bodies for
  hidden text and external links. Full instruction phrasing stays OFF bodies deliberately: a
  description is injected at connect time and nobody chose it, a resource is read only when its URI
  is asked for, and a recipe that could not name the calls it is a recipe for would be useless.
- **A claim about the body gate was withdrawn, because it was measured and was false.** Its
  "adversarial steering" check shipped with five planted defects that were its own five regular
  expressions restated in English. An independent corpus of ten attacks, written attacks-first with
  the patterns never consulted, is caught **0 of 10**. That number is now asserted in the test, so
  the limit cannot rot into a capability nobody re-measured. The check is kept as a mechanical
  tripwire for literal subversion and encoded payloads, and the control that actually fits the risk
  is now in place: each playbook body's content hash is pinned, so no body can change without the
  test failing and a human reading the diff.

### No tool was added for the credit balance

`reddit_account_me` already returns `credits_remaining`, `credits_used` and `total_requests`, is
free, is not metered and is already named in the server instructions. A second tool over the same
endpoint would be a second name for one job and one more entry competing for attention in the
catalog, so there is none.

## 0.9.1 (2026-10-02)

- Feedback reports no longer ask for the user's words: `reddit_feedback_send` `details` is three
  bullets (What happened, Repro, Evidence), optionally after a one-line summary of the goal, and the
  server instructions match. No quote of the conversation is collected (Connectors Directory rule
  against extraneous conversation data).
- The description gate adds check (e) for conversation-data asks in descriptions and instructions,
  and check (d) refuses external links: https on our own or example hosts only, bare hosts on real
  TLDs, backslash authorities, emails, IP addresses and javascript:/data: schemes.

## 0.9.0 (2026-10-02)

### Fixed

- **reddit_post_visibility works again.** Its path was written
  `/api/reddit/post/:id/visibility`, which the client's path builder does not
  fill, so every call sent a literal `:id` and was refused with HTTP 400 (it
  had been broken since the tool shipped). It is now `{id}`, and a test fails
  if any tool path carries an unfillable `:param`.

### Changed

- **Tool descriptions state product facts only; guidance moved to the server
  instructions.** Every tool and parameter description now says what the tool
  returns, what it takes, what it costs and what its errors mean, and nothing
  else: no instructions to the model, no names of other tools, no hidden or
  encoded text. That is the rule the Claude connector directory's compliance
  attestation sets for tool descriptions. The guidance that was spread across
  them (which search or listing tool fits which question, how to get the Reddit
  session the home feed and the four private listings need, how to read a
  partial listing or a monitor's health, what a monitor update replaces, and
  the feedback drafting policy) now lives once in the server instructions,
  which every MCP client hands its model with the tool list. Tool names, input
  schemas, annotations and behaviour are unchanged. Measured with the new gate
  on 0.8.1: 24 of 44 tools named another `reddit_*` token and every tool
  carried at least one instruction-shaped phrase (most through shared
  parameter text such as the pagination cursor); on 0.9.0 both are zero.

### Added

- **`createServer({ inlineCredentials: false })` for remote hosts.** The
  default stays `true`, so a local `npx` install sees no change. With `false`,
  every tool whose input takes the caller's Reddit cookies or session proxy is
  not registered: `reddit_home_feed`, `reddit_user_upvoted`,
  `reddit_user_saved`, `reddit_user_hidden` and `reddit_user_gilded`. They are
  absent from `tools/list`, a call naming one fails without reaching the API,
  and the server instructions drop the sentence that points at them. The test
  is `takesInlineCredentials` in `src/tools.js`, which matches the known cookie
  arguments and any credential-shaped argument name, so a future cookie
  argument is hidden by default. `test/inline-credentials.test.mjs` proves the
  hosted listing has zero such tools while the default keeps all five.
- **`test/description-compliance.test.mjs`, part of `npm test`.** It lists the
  catalog the way a client receives it (`createServer` plus an in-memory MCP
  client) and fails if any tool or parameter description names another tool,
  matches a model-instruction pattern (should, do not, never, always, must,
  use ... instead, second person, sentence-initial imperatives and similar), or
  carries zero-width, bidi, tag or control characters or a base64- or
  hex-looking run. It also checks that the server instructions still carry the
  guidance that moved and stay within 2048 characters. Planted defects for all
  three checks are asserted in the same run, so a matcher that stops catching
  them fails rather than reporting a clean catalog.

## 0.8.1 (2026-09-30)

### Fixed

- **The README's tool counts match the catalog.** It said 34 tools (22 reads, 10
  monitor/webhook, 2 feedback); the server has shipped 44 since the feedback and
  account tools landed: 30 Reddit reads, 10 monitor/webhook management tools, 3
  feedback tools and `reddit_account_me`. No code change.

## 0.8.0 (2026-09-29)

### Added

- **Remote hosting.** `redditapis-mcp/server` exports `createServer`, and an
  `authHeaders` option authenticates calls with headers the host supplies
  instead of an API key, for a remote MCP endpoint that has already signed the
  caller in (a connected app over OAuth).

### Changed

- **A read rides out an API restart.** A read that gets the gateway's HTML
  502/503, or a refused connection, is retried after 3 and then 8
  seconds. The API's own JSON errors, gateway timeouts, DNS or TLS failures
  and every write are never retried, so a request the API may already have
  handled is not sent twice.

## 0.7.0 (2026-09-29)

### Added

- **Agent-actionable paywall.** A missing key, a rejected key (403 Invalid token)
  and an empty balance (402 Insufficient credits) now return a structured payload
  instead of a prose hint:
  `needs` (`account`, `valid_key` or `credits`), the exact page to send the user
  to (`action_url`: signup, API keys, or buy credits), and one sentence the
  agent can relay, both in the text and as `structuredContent`. An agent that
  runs out of credit mid-task can now tell the user where to top up and retry
  the same call. Other failures keep their existing hints, including a 402 for
  a monitoring plan or slot limit, which buying credits would not fix.
- The MCP SDK floor is pinned to ^1.29.0.

### Changed

- **Per-caller server state.** The server is now built by `createServer()` in
  `src/server.js`, which holds the API key and the last-failed-call record in
  its own closure instead of module globals. Under stdio nothing changes (one
  process, one caller); it is the prerequisite for serving the same tools
  remotely, where one process serves many callers. `src/index.js` is now only
  the stdio entry and the one place config is read from the environment.
  `test/per-caller-state.test.mjs` proves two servers in one process never
  share a key or a failure record.

## 0.6.1 (2026-09-11)

### Changed

- **The server instructions now ask for a control before an "ignored parameter" report.** A generic query on a score-ordered sort returns the site-wide listing, which reads exactly like a dropped parameter and is not one; a report with that title was sent on 2026-09-11 and needed a correction. The instructions now say: before drafting a report that a parameter is ignored or a field is empty, re-run with a distinctive value that could only match if the parameter was honoured, and with the phrase quoted, then title the report by what the control showed.
- **`prepublish-tenant-check` refuses a patch bump when the tool catalog grew.** It reads the published tarball from npm (the emitting system, never a recorded count), counts the catalog on both sides, and blocks a publish whose version is a patch over the published one while the catalog is larger. 0.6.0 was first cut as 0.5.4 with a new tool and only a reviewer caught it. Fails closed when npm cannot be read.

## 0.6.0 (2026-09-11)

A minor rather than a patch because a tool was added: anyone pinned to 0.5.x opts in rather than receiving it silently, the same rule the 0.5.0 and 0.4.0 entries below state.

### Added

- **`reddit_user_achievements`.** A user's public achievements, the trophies on their reddit.com/user/<name>/achievements page, with name, description, granted timestamp and icons. An account with none returns an empty list, so a zero count is a real answer.

### Changed

- **`reddit_search` no longer steers you into site-wide `sort=top`.** Reddit orders `top`, `new` and `comments` by that one number over a LOOSELY matched set (OCR image text and comments count, and the word "reddit" is in almost every large post), so a generic multi-word query with `sort=top` and no `subreddit` returned the site-wide viral listing rather than the topic. Measured 2026-09-11: `q=reddit api pricing`, `sort=top`, `t=year` returned r/MadeMeSmile at 107k upvotes and a bathroom remodel; `sort=relevance` on the same query returned API-pricing threads; the quoted phrase returned exact matches only; `q=pgvector` was on topic on any sort. The tool description and the `sort` enum text now say only `relevance` weights match quality and point at `sort=relevance` plus `sort_type=score`, a quoted phrase, or a `subreddit` scope. The worked example no longer models `sort=top`.

### Housekeeping

- The authoring repo had fallen behind the published package: 0.5.3 shipped from the org repo on 2026-09-06 without landing here, so `src/index.js` in this repo still exited on a missing key. That change and its test are now back in the authoring repo, and this release is cut from it.

## 0.5.3 (2026-09-06)

### Fixed

- **A registry scanner can now read the tool catalog without a key.** `src/index.js` used to `process.exit(1)` when `REDDITAPIS_KEY` was unset, so a directory that spawns the server to enumerate its tools got no answer to `initialize` and nothing from `tools/list`, and listed the server as uninspectable. Measured 2026-09-06 by speaking raw MCP stdio to the published 0.5.2 with an empty env. The server now warns and continues; a tool CALL with no key fails at the call with a clear message, and no `Bearer undefined` header is ever sent. Not a security relaxation: this is a stdio server, whoever spawns it already has local execution. Test: `test/scannable-without-key.test.mjs`. (This entry was written on 2026-09-11; the 0.5.3 release carried no changelog line.)

## 0.5.2 (2026-09-06)

### Added

- **`reddit_post_visibility`.** Is a post still publicly visible, or did it quietly stop being so? A removed Reddit post still returns when you fetch it by id, with its title and score, so asking the post does not answer the question. This fetches the post and then one page of its author's submitted listing and compares them, returning a verdict of `live`, `not_visible` or `undecidable` with a plain-language reason and a `confident` flag. It never says WHY a post is not visible: a moderator removal, an admin removal, a spam filter and an author who has hidden their post history are indistinguishable from outside, and only one of them is a removal. `undecidable` is a real answer, not a failure. Two upstream calls, billed as one request at $0.004.

## 0.5.1 (2026-09-06)

### Fixed

- **The npm package page was showing a description cut off mid-word.** `package.json` carried a 394-character description; npm stores at most 255 and truncates the rest without an error or a warning, so the visible end of the description on npmjs.com was the fragment `register/test/dele`. 139 characters were being silently discarded. Measured against `registry.npmjs.org` rather than guessed. The description is now 249 characters and ends as a sentence, and `scripts/prepublish-tenant-check.mjs` refuses to publish one that is over the bound or that does not end in a full stop, the second check being the one that catches a cut string regardless of its length.

## 0.5.0 (2026-09-06)

### Added

- **`reddit_home_feed`, the caller's own front page.** A shared account pool can never answer "what is on MY home feed", so this reads it with your own Reddit session, sent as headers rather than in the URL. Part of the same change that gave nine existing read tools an authenticated mode: send `x-reddit-session` and `x-reddit-loid` and a private, restricted or member-only subreddit is readable as the account that belongs there, instead of coming back empty. Send neither and the read is served anonymously from the pool exactly as before, so existing integrations are untouched.
- **`reddit_verify_comments`, verify up to a hundred comments in one call.**
- **`reddit_feedback_list`, find a report whose id you lost.** `GET /feedback` with cursor paging and a type filter, so a report you sent and did not record is still reachable.

### Fixed

- **A foreign-tenant token that `git push` shipped and `npm pack` did not.** The published tarball was clean, so this never reached a customer through npm, but the string was in the repo.
- The stuck-lock test used the wrong queue-directory env var and wrote to the real home directory instead of its fixture.
- `send` now releases the queue lock across the network, a 409 carries no hint, and a posted draft fails soft rather than stranding the queue.

### Why a minor rather than a patch

The catalog moved from 38 tools to 41. A client enumerating tools sees three it did not have, which is a capability change, so anyone pinned to 0.4.x opts in rather than receiving it silently.

### Note on the gap this closes

0.4.0 was published on 2026-09-04 and the registry served it unchanged for two days while HEAD moved 50 commits ahead. Because both the registry and the repo said `0.4.0`, every version-based freshness check read clean while the BYTES differed: `src/index.js`, `src/tools.js` and `README.md` all diverged, and customers running `npx redditapis-mcp` were enumerating 38 tools against a repo that shipped 41. Found by `ship-chain.sh`, which compares the published tarball to HEAD file by file rather than comparing version strings.

## 0.4.0 (2026-09-04)

### Added

- **`reddit_feedback_send` and `reddit_feedback_get`, report a bug or a gap to the redditapis.com team from inside the session you are already in.** Modelled on Claude Code's own feedback tool: the model drafts a report at a high-signal moment (a call failed in a way that is not your key, credits or a rate limit and you had to work around it; you asked for something no tool covers; a documented field came back empty or wrong; you were plainly frustrated with a result) into a local queue at `~/.redditapis/feedback-queue.json` (override with `REDDITAPIS_FEEDBACK_DIR`, at most 10 drafts), and nothing is sent until you review the queue and name the drafts to send. Each draft carries the last failing call's endpoint, status and request id, your MCP client's name and this package's version, filled in automatically, so a report is actionable without a follow-up. `reddit_feedback_send` takes `action` (`draft`, `list`, `send`, `discard`); `reddit_feedback_get` reads a sent report's status and the team's response. Both are free and need only your API key. The trigger list also ships as the server's MCP `instructions`, so a client that honours them nudges its model at the right moments, and every non-credential error body (anything but 401/402/429) now ends with a one-line pointer to the tool. This takes the catalog to 38 tools (34 documented in the table above plus the 4 cookie-authenticated user-history reads).
- **Catalog support for local handlers.** A tool may declare `local: "<handler>"` in `src/tools.js` and name its local-only args in `localArgs`; those args are consumed in this package and never sent to the API. `src/index.js` refuses to boot if a catalog entry names a handler it does not implement, and the catalog test pins that every `localArgs` entry is a real key of the tool's shape, so neither flag can turn into a silent passthrough.

### Fixed

- `test/smoke.mjs` asserted a tool count of 32 against a catalog of 36; it now derives the expected count from the catalog it lists.

## 0.3.0 (2026-08-16)

### Added

- **`exclude_subreddits` and `exclude_terms` on `reddit_monitor_add` and `reddit_monitor_update`.** Per-monitor subreddit exclusion for sitewide keyword watches, and term exclusion for every monitor. Published as a minor rather than a patch because a real capability was added; anyone pinned to 0.2.x opts in rather than receiving it silently. (This entry was written retroactively on 2026-09-04: the version shipped with no changelog line.)

## 0.2.0
- **10 new monitor/webhook management tools** (task #43), the first WRITES this
  catalog has ever carried. Unlike the reddit comment/vote/DM writes this MCP
  still excludes, these configure the caller's OWN redditapis.com account (an
  alerting subscription), never Reddit itself:
  - **`reddit_monitor_add`** / **`reddit_monitor_list`** / **`reddit_monitor_update`** /
    **`reddit_monitor_remove`** — create, list, update (pause/resume/re-filter/
    re-cadence), and permanently delete a monitor. Requires an active plan to
    create/update (monitoring has no free tier); reading your own list never does.
  - **`reddit_monitor_health`** — per-monitor delivered/failed/suppressed counts and
    whether the delivery ceiling has been hit.
  - **`reddit_monitor_deliveries`** — the actual Reddit posts a monitor's webhook
    has received, not just counts (task #47, the feature the operator asked for
    directly: "can they check which all posts their webhook has received").
  - **`reddit_monitor_webhook_create`** / **`reddit_monitor_webhook_list`** /
    **`reddit_monitor_webhook_test`** / **`reddit_monitor_webhook_delete`** —
    register a delivery target (secret shown once), list registered webhooks
    (secret never re-shown), send a one-off test delivery, and permanently
    delete one.
  - All 10 verified live end to end against production (real create/update/
    pause/resume/remove/re-add round trips, a real signed test delivery), not
    just unit-tested against a mock.
  - `remove`/`webhook_delete` are marked `destructive: true`; every write is
    `write: true`; every other tool remains a pure, `readOnlyHint: true` read.
  - Fixed two pre-existing drifts found while touching this file: the reported
    `VERSION` was hardcoded `"0.1.0"` while the package had shipped up to
    0.1.12 for months (now read live from package.json, so it can't drift
    again), and `test/tools.test.mjs` / `test/smoke.mjs` both hardcoded stale
    tool counts (12 and 11) against an actual catalog of 22 -- neither test
    file had been updated as the catalog grew.
  - Brings the tool count to 32 (22 reads + 10 monitor/webhook writes).

## 0.1.12
- reddit_search gains advanced filters applied to the returned page (the pullpush
  filter-power model): min_score/max_score, min_comments/max_comments, is_video,
  is_self, over_18, locked, stickied, spoiler, contest_mode, and sort_type
  (score/num_comments/created). Because filtering is post-hoc on a page, the
  response adds a meta object (fetched, returned, filtered_out); paginate with
  after to filter more. No price change ($0.002), no new endpoint.

## 0.1.11
- Two new read tools for subreddit governance (both $0.002, one upstream read each):
  - **`reddit_subreddit_moderators`** (`GET /api/reddit/sub/{name}/moderators`),
    a subreddit's moderator team: each moderator's username, id, mod permissions,
    flair text, and the time they were added. Returns a `moderators` list.
  - **`reddit_subreddit_wiki`** (`GET /api/reddit/sub/{name}/wiki/{page}`), a
    subreddit's wiki page by name and page: the page's markdown and HTML content,
    a may-revise flag, and the last revision's metadata. Returns a single object.
    The page may be multi-segment, for example index, rules, or config/sidebar.
  - Brings the published read-only tool count to 22.

## 0.1.10
- Three new read tools for community DISCOVERY (all $0.002, one upstream read each):
  - **`reddit_subreddits_popular`** (`GET /api/reddit/subreddits/popular`), browse
    the most-subscribed, trending subreddits right now, no keyword needed.
  - **`reddit_subreddits_new`** (`GET /api/reddit/subreddits/new`), browse the
    newest subreddits, the communities most recently created.
  - **`reddit_subreddits_default`** (`GET /api/reddit/subreddits/default`), browse
    Reddit's default front-page set of subreddits.
  - Each returns a `subreddits` list (same per-item shape as
    `reddit_subreddit_about`) plus an `after` cursor, and takes only `after` +
    `limit`. These BROWSE communities; `reddit_search_communities` SEARCHES by
    keyword. Brings the published read-only tool count to 20.

## 0.1.9
- Two new read tools (both $0.002, one upstream read each):
  - **`reddit_subreddit_rules`** (`GET /api/reddit/sub/{name}/rules`), a
    subreddit's posting rules: each rule's name, description, what it applies to
    (posts, comments, or all), violation reason, priority, and creation date,
    plus Reddit's site-wide rules. Check a community's rules before posting.
  - **`reddit_by_id`** (`GET /api/reddit/by_id/{fullnames}`) — bulk-fetch posts
    by comma-separated t3_ fullnames (up to 100) in one call. Same post shape as
    the subreddit listings. Hydrate ids you already have without a call per post.
  - Brings the published read-only tool count to 17.

## 0.1.8
- **`reddit_deep_comment_search`** gains a research mode: pass `group_by="author"`
  to get the distinct PEOPLE who mentioned your query (ranked by matching-comment
  count, then total score) instead of a flat comment list. Each author carries
  `comment_count`, `total_score`, the `subreddits` they matched in, and their
  `top_comment`. `max_authors` caps the people returned; `meta.authors_capped`
  flags a trim. `[deleted]` accounts are dropped. No price change (still $0.02).

## 0.1.7
- Three new read tools (all $0.002, one upstream read each):
  - **`reddit_user_submitted`** (`GET /api/reddit/user/{name}/submitted`) — a
    user's submitted POSTS, the sibling of `reddit_user_comments`. Same post
    shape as the subreddit listings.
  - **`reddit_subreddit_comments`** (`GET /api/reddit/sub/{name}/comments`), the
    subreddit NEW-COMMENT stream (every new comment across a community, not one
    post's thread). Same comment shape as `reddit_user_comments`.
  - **`reddit_subreddit_about`** (`GET /api/reddit/sub/{name}/about`), a
    subreddit's public metadata (title, public description, subscriber count,
    active-user count, creation date, type, NSFW flag). Returns a single object.
  - Brings the published read-only tool count to 15.

## 0.1.6
- `reddit_deep_comment_search` v1.1, driven by a customer report that there was
  no reliable way to expand a search past the first few posts:
  - **Pagination.** The response `after` cursor is now honoured on input — pass it
    back as `after` to expand the next batch of parent posts. Each call stays
    bounded, so a caller can page as deep as they want. (The cursor was previously
    returned but ignored.)
  - **`limit` cap raised 10 -> 25** parent posts per call.
  - **`max_comments`** optional cap on how many comments are returned; the
    highest-scored are kept.
  - Comments now come back **sorted by score** (highest first).
  - Honest completeness meta: `comments_matched` (found) vs `comments_returned`
    (after cap) vs `capped`, alongside `truncated`.
  - Matching now runs on the **visible comment text at word boundaries** (link
    URLs stripped), so a result always mentions the query where a reader can see
    it — fixes the false positives from matching inside link URLs / as substrings.

## 0.1.5
- Description honesty pass, three tool descriptions promised fields the live
  response does not return. All found by the new V-DESC gate
  (reconcile-description-shape.mjs), which probes EVERY tool against the live API
  and asserts no description claims a field the response lacks:
  - `reddit_search_media` claimed a `permalink`; the response carries `url`. Corrected.
  - `reddit_subreddit_posts` claimed `flair` and `media`; neither is in the
    `/posts` response (fields are title, author, upvotes, comments, permalink, url,
    text). Removed.
  - `reddit_post` claimed `body/selftext` and `media`; `/post/{id}` returns `text`
    (no `body`, no `selftext`, no `media`). Corrected to `text`.

## 0.1.4
- New tool `reddit_deep_comment_search`. Where `reddit_search_comments` returns
  the parent posts (Reddit's comment search never hands back the comment), this
  returns the ACTUAL matching comments with body, score, author, a comment-deep
  permalink, and the parent post. It fetches each matching post's comment tree
  and filters the bodies. Premium call (`limit` = parent posts to expand, 1-10).
  Best-effort: a deleted or deeply-nested comment may be missed. Also cross-links
  the two tools in their descriptions.

## 0.1.3
- `reddit_search_comments` description no longer overpromises. It previously
  claimed to "Return matching comments with author, body, score" and to find
  "opinions/answers buried in threads", but the endpoint returns PARENT POSTS,
  not comment objects: Reddit's comment search is a MODE that matches comment
  text and hands back the t3 posts, and does not expose which comment matched or
  its body. The openapi spec already said this; the MCP tool description and the
  README table had drifted and still promised comment bodies/scores the response
  never contained. A customer relied on the old text and reported it as a bug.
  The description now states the real behaviour. No API surface change.

## 0.1.2
- `reddit_search` and `reddit_search_comments` now describe the `t` time window
  accurately. Unlike a subreddit listing, search applies `t` to the `relevance`
  and `top` sorts as well, and when it is omitted Reddit defaults to `all` — so a
  broad relevance query surfaces old high-upvote posts that only loosely match.
  The tool description now says so, which materially changes the queries an agent
  writes. No API surface change.

## 0.1.1
- Corrected package metadata.


## 0.1.0
- Initial release: 11 read tools over the redditapis.com API (subreddit listings,
  post/comment/community/user/media search, comment tree, subreddit top posts,
  user profile + comments). Stdio transport, Bearer auth, per-request timeout.
