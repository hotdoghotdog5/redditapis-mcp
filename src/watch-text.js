// src/watch-text.js, the sentence reddit_set_watch hands back.
//
// WHY THIS IS A SEPARATE FILE FROM THE TOOL DESCRIPTION, and why the rules are
// opposite in the two places.
//
// A tool DESCRIPTION is catalog metadata: the connector directory's compliance
// requirement is that it states product facts only, naming no other tool and
// instructing no model. test/description-compliance.test.mjs enforces that over
// every description in the shipped catalog.
//
// A tool RESULT is data the caller asked for. Naming the next call in a result
// is what every REST error body on this API already does ("reddit_account_me
// shows the balance"), and it is the only place a next step can be stated
// truthfully, because it depends on what actually happened. So the Slack offer
// and the plan step live here, in the result, and never in the description.
//
// NOTHING HERE IS A CLAIM THE RESULT DOES NOT CARRY. Every sentence below is
// built from a field of the payload the API returned, or from the `slots`
// object the account's own monitor list reported. There is no figure typed in
// from a pricing page: a price that drifts in a hardcoded string is a wrong
// fact repeated confidently, which is the expensive kind.

const SLACK_OFFER =
  "To put these matches in a Slack channel, create an incoming webhook in Slack and pass its hooks.slack.com URL as deliver_to on the next reddit_set_watch call, or register it with reddit_monitor_webhook_create and repoint this monitor with reddit_monitor_update; the Slack payload shape is inferred from the host.";

/** One line describing what the plan currently allows, from the account's own slots object. */
export function planStep(slots) {
  if (!slots || typeof slots !== "object") return null;
  const bits = [];
  if (Number.isFinite(slots.used) && Number.isFinite(slots.total)) {
    bits.push(`${slots.used} of ${slots.total} monitor slots in use`);
  }
  if (Number.isFinite(slots.distinct_subreddits_used) && Number.isFinite(slots.distinct_subreddits_total)) {
    bits.push(`${slots.distinct_subreddits_used} of ${slots.distinct_subreddits_total} distinct subreddits`);
  }
  if (Number.isFinite(slots.cadence_s)) bits.push(`a ${slots.cadence_s}s cadence floor`);

  const locked = [];
  if (slots.scoped_allowed === false) locked.push("watches limited to named subreddits");
  if (slots.comments_allowed === false) locked.push("comment matching");
  if (slots.sitewide_allowed === false) locked.push("site-wide keyword watches");

  const head = bits.length ? `This account has ${bits.join(", ")}.` : null;
  const tail = locked.length
    ? `Not on this plan yet: ${locked.join(", ")}. A higher plan adds ${locked.length === 1 ? "it" : "them"}.`
    : null;
  return [head, tail].filter(Boolean).join(" ") || null;
}

/** The human-readable half of a successful reddit_set_watch result. */
export function buildWatchSummary(payload) {
  const u = payload?.understood || {};
  const lines = [];

  const what = [];
  if (u.keyword) what.push(`the keyword ${JSON.stringify(u.keyword)}`);
  if (Array.isArray(u.any_of) && u.any_of.length) what.push(`any of ${u.any_of.map((t) => JSON.stringify(t)).join(", ")}`);
  const where = Array.isArray(u.subreddits) && u.subreddits.length
    ? `r/${u.subreddits.join(", r/")}`
    : "every subreddit";
  const kindWord = u.match_kind === "both" ? "posts and comments" : u.match_kind === "comment" ? "comments" : "posts";

  lines.push(
    `Watching ${where} for new ${kindWord}${what.length ? ` matching ${what.join(" and ")}` : ""}` +
      `${Array.isArray(u.excluded_terms) && u.excluded_terms.length ? `, excluding ${u.excluded_terms.map((t) => JSON.stringify(t)).join(", ")}` : ""}` +
      `${u.min_score != null ? `, with a score floor of ${u.min_score}` : ""}.`,
  );

  const id = payload?.monitor?.id;
  if (id) lines.push(`Monitor id ${id}.`);

  const d = payload?.delivery;
  if (d?.registered) {
    // THE SECRET SENTENCE IS CONDITIONAL ON THE SECRET BEING THERE. It used to
    // be printed whenever the API had returned one, while the handler kept only
    // a boolean and threw the value away, so the result asserted something
    // about a credential that was not in it. `secret` now carries the value and
    // this sentence is tied to the value, not to a flag about it.
    lines.push(
      `Delivery target registered${d.kind ? ` as kind ${d.kind}` : ""}${d.webhook_id ? ` (id ${d.webhook_id})` : ""}.` +
        (d.secret ? " Its signing secret is in this result, as `delivery.secret`, and is not returned again." : ""),
    );
    if (d.test && d.test.ok === false) {
      lines.push(`The test delivery did not land: ${d.test.hint || d.test.reason || d.test.detail || "no detail returned"}.`);
    } else if (d.test && d.test.ok === true) {
      lines.push("A test delivery reached the target.");
    } else if (d.test) {
      // UNKNOWN IS NOT FINE. A test whose answer could not be read says so,
      // because "a test delivery reached the target" on no evidence is the one
      // thing the caller must not be told.
      lines.push("A test delivery was sent and the response did not say whether it landed; the target is unconfirmed.");
    }
  } else if (d && d.registered === false) {
    lines.push("The delivery target was not registered; matches go to every active webhook already on the account.");
  } else {
    lines.push("No delivery target was given, so matches go to every active webhook already on the account.");
  }

  for (const n of payload?.notes || []) lines.push(n);

  lines.push(SLACK_OFFER);
  const step = planStep(payload?.plan);
  if (step) lines.push(step);

  return lines.join(" ");
}
