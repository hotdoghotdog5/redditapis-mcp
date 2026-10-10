// src/provenance.js, the local half of reddit_explain.
//
// WHAT A ROW'S PROVENANCE ACTUALLY IS ON THIS PRODUCT, measured rather than
// assumed, because the honest answer turned out to be the opposite of the
// obvious one.
//
// The plan this tool came from specified "cache age" as the field to surface.
// There is no cache to age. The redditapis.com read path holds no response
// cache for customer reads: the whole customer read path (routes/reddit.js and
// services/reddit/client.js on origin/main) carries exactly one `cache`
// mention and it is about which egress path to use, not about response bodies;
// there is no Redis, memcached, LRU or keyv dependency in either service. That
// was re-derived with a positive control in the 2026-09-27 implementation spec,
// and it is visible from this side too: no response this client receives
// carries a cache header, an age field or a fetched-at stamp. A "cache hit" and
// a "cache miss" are the same code: a live fetch.
//
// SO THE AGE THAT EXISTS IS REAL, AND IT IS NOT A CACHE AGE. A row an agent is
// holding was fetched at a particular instant by a particular call in this
// session, and it has been getting older ever since. That instant is something
// this process observed directly, so it can be reported without inventing
// anything: the ledger below records, for every call that succeeded, which tool
// made it, which endpoint it reached, when the response arrived, the upstream
// request id and how many bytes came back. reddit_explain reads that back.
//
// WHAT IT DELIBERATELY DOES NOT DO: it does not claim a cache age, and it does
// not restate a retention period. The retention table is published and is the
// emitting system for that fact; a number copied into a tool description drifts
// silently the day the table changes, so the description points at the page.
//
// SCOPE. The ledger is per server, which is per caller, for the same reason
// every other piece of state in this package is: served remotely, one process
// serves many callers, and a shared ledger would hand one caller's endpoints
// and request ids to another. It lives in memory only and starts empty.

export const LEDGER_CAP = 20;

/** A bounded, newest-first ledger of the calls one server has completed. */
export function createReadLedger({ cap = LEDGER_CAP, now = () => Date.now() } = {}) {
  const entries = [];
  return {
    record(entry) {
      if (!entry || typeof entry.tool !== "string") return;
      entries.unshift({
        tool: entry.tool,
        endpoint: entry.path ?? null,
        method: entry.method || "GET",
        observed_at_ms: now(),
        request_id: entry.requestId ?? null,
        bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
      });
      if (entries.length > cap) entries.length = cap;
    },
    list() {
      return entries.slice();
    },
    get size() {
      return entries.length;
    },
  };
}

// Stated once, used in the result. Each clause is a fact about this product's
// read path, not advice.
export const FRESHNESS = Object.freeze({
  source: "reddit.com, fetched through api.redditapis.com at the moment the call ran",
  response_cache: "none",
  response_cache_detail:
    "The redditapis.com read path holds no response cache for customer reads, so every call is served live and the age below is the age of this session's copy of the rows, not the age of a stored row.",
  retention_policy_url: "https://www.redditapis.com/privacy-and-data-handling",
});

/**
 * Build the reddit_explain handler.
 *
 * @param {object} deps
 * @param {() => Array} deps.listReads  reads the server's ledger
 * @param {() => number} [deps.now]     injectable clock, for tests
 */
export function createExplainHandler({ listReads, now = () => Date.now() }) {
  return async function explain(args = {}) {
    const { tool, limit } = args;
    const t = now();
    let rows = listReads();
    if (typeof tool === "string" && tool.length) rows = rows.filter((r) => r.tool === tool);
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(LEDGER_CAP, Math.trunc(limit))) : 5;
    rows = rows.slice(0, n);

    const calls = rows.map((r) => ({
      tool: r.tool,
      endpoint: r.endpoint,
      method: r.method,
      observed_at: new Date(r.observed_at_ms).toISOString(),
      age_seconds: Math.max(0, Math.round((t - r.observed_at_ms) / 1000)),
      request_id: r.request_id,
      response_bytes: r.bytes,
    }));

    const payload = { calls, call_count: calls.length, ...FRESHNESS };

    const head = calls.length
      ? calls
          .map(
            (c) =>
              `${c.tool} reached ${c.method} ${c.endpoint} at ${c.observed_at}, ${c.age_seconds}s ago` +
              `${c.request_id ? `, upstream request id ${c.request_id}` : ""}` +
              `${c.response_bytes != null ? `, ${c.response_bytes} bytes` : ""}.`,
          )
          .join(" ")
      : tool
        ? `No completed call by ${tool} is recorded in this session.`
        : "No completed call is recorded in this session yet; the ledger starts empty and fills as tools run.";

    return {
      content: [
        {
          type: "text",
          text: `${head} ${FRESHNESS.response_cache_detail} Retention by category is published at ${FRESHNESS.retention_policy_url}.\n\n${JSON.stringify(payload)}`,
        },
      ],
      structuredContent: payload,
    };
  };
}
