// createServer(): one McpServer per caller, holding that caller's key and last
// failure in its own closure.
//
// WHY A FACTORY: the key and the last-failed-call record used to be module
// globals. Under stdio there is one process per user, so that was harmless;
// served remotely, one process serves many users, and a module global would
// send one caller's requests with another caller's key and hand one caller's
// failure (path, request id) to another caller's feedback draft. Every piece
// of per-caller state now lives inside createServer, and nothing in this file
// reads process.env: the entry point (index.js for stdio) resolves config and
// passes it in.

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS, buildQuery, buildPath, buildBody, buildHeaders, takesInlineCredentials } from "./tools.js";
import { createFeedbackHandler, sameFailure } from "./feedback.js";
import { createSetWatchHandler } from "./watch.js";
import { createReadLedger, createExplainHandler } from "./provenance.js";
import { registerPlaybooks } from "./playbooks.js";
import { createCompactor } from "./compact.js";

// Read from package.json rather than a hand-maintained literal -- this drifted
// silently to "0.1.0" while the published package reached 0.1.12, so every
// User-Agent and MCP server handshake understated its own version for months.
export const { version: VERSION } = createRequire(import.meta.url)("../package.json");

export const DEFAULT_BASE_URL = "https://api.redditapis.com";
export const DEFAULT_TIMEOUT_MS = 30000;

// The trailing sentence appended to a failed call, so the model reads an error
// it can act on rather than a bare status.
//
// A 404 HINT HAS TO KNOW WHICH ENDPOINT WAS CALLED. This was a flat status-only
// ternary, so every 404 in the catalog got the listing-shaped sentence, and a
// caller whose FEEDBACK id was not found was told to check their subreddit,
// post id or permalink. None of those are involved. The feedback endpoints are
// the first mounted outside the /api/reddit surface, so they are the first
// place that assumption is plainly wrong; /account/* would have been next.
//
// Only the 404 varies, because it is the only status whose useful advice
// depends on what was being looked up. Everything else is about the KEY, the
// CREDIT balance or OUR service and reads the same on every endpoint.
const NOT_FOUND_HINTS = [
  [/^\/feedback/, " (not found. No feedback report with that id on this account, and an id from another account will not resolve here. Use the id returned by reddit_feedback_send action=send.)"],
  [/^\/account/, " (not found. That account resource does not exist for this key.)"],
];
const DEFAULT_NOT_FOUND_HINT =
  " (not found. The subreddit, post id, user, or permalink may be wrong or deleted)";

// AGENT-ACTIONABLE PAYWALL. A missing key, a rejected key and an empty balance
// are the moments a user decides whether to keep using the product, and they
// happen inside an agent's turn. Prose like "top up at redditapis.com" leaves
// the agent guessing where to send the user; a structured payload names the
// exact page, so the agent can say "you have used your free credit, top up
// here" and resume after. The payload is both appended to the text (every
// client reads that) and returned as structuredContent (clients that parse it).
export const SIGNUP_URL = "https://www.redditapis.com/signup?utm_source=mcp&utm_medium=tool_error";
export const API_KEYS_URL = "https://www.redditapis.com/dashboard/api-keys?utm_source=mcp&utm_medium=tool_error";
export const TOP_UP_URL = "https://www.redditapis.com/dashboard/buy-credits?utm_source=mcp&utm_medium=tool_error";

export function paywallFor(kind) {
  if (kind === "no_key") {
    return {
      needs: "account",
      message:
        "Missing REDDITAPIS_KEY: no API key is set. Sign up free at redditapis.com (new accounts start " +
        "with free credit, no card), copy the key from the dashboard, set REDDITAPIS_KEY in the MCP " +
        "client config, then retry this call.",
      action_url: SIGNUP_URL,
      api_keys_url: API_KEYS_URL,
      retry: "same call, after the key is set",
    };
  }
  if (kind === "bad_key") {
    return {
      needs: "valid_key",
      message:
        "The redditapis.com API key was rejected (invalid, revoked or rotated). Copy a current key from " +
        "the dashboard, set REDDITAPIS_KEY, then retry this call.",
      action_url: API_KEYS_URL,
      retry: "same call, after the key is replaced",
    };
  }
  if (kind === "credits") {
    return {
      needs: "credits",
      message:
        "The redditapis.com account is out of credits. Top up (pay as you go, no subscription), then " +
        "retry this call; nothing was charged for the failed request. reddit_account_me shows the balance.",
      action_url: TOP_UP_URL,
      retry: "same call, after topping up",
    };
  }
  return null;
}

// Which failures ARE a paywall is decided from the API's own response BODY, not
// the status alone, because the status is shared (review 2026-09-29): the API
// answers a rejected key with 403 {"error":"Invalid token"} (401 is only a
// MISSING token, which this client never sends), and 402 also means a monitor
// plan or slot limit, which buying credits does not fix. Only the two bodies
// below are paywalls; everything else keeps its ordinary hint.
export function classifyPaywall(status, bodyText) {
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  const err = body && typeof body.error === "string" ? body.error : "";
  if ((status === 403 || status === 401) && err === "Invalid token") return { kind: "bad_key" };
  if (status === 402 && (err === "Insufficient credits" || typeof body?.top_up_url === "string")) {
    const url = typeof body?.top_up_url === "string" && /^https:\/\/www\.redditapis\.com\//.test(body.top_up_url)
      ? body.top_up_url
      : null;
    return { kind: "credits", topUpUrl: url };
  }
  return null;
}

function paywallResult(kind, detail = "", overrides = {}) {
  const p = { ...paywallFor(kind), ...overrides };
  return {
    isError: true,
    content: [{ type: "text", text: `${p.message}${detail ? ` (${detail})` : ""}\n\n${JSON.stringify(p)}` }],
    structuredContent: p,
  };
}

export function hintFor(status, path) {
  if (status === 401) return " (invalid or missing API key, verify REDDITAPIS_KEY at https://www.redditapis.com)";
  if (status === 402) return " (insufficient credits, top up at https://www.redditapis.com)";
  if (status === 403) return " (access forbidden. The subreddit/user may be private, banned, or quarantined)";
  if (status === 404) {
    for (const [re, hint] of NOT_FOUND_HINTS) if (re.test(path || "")) return hint;
    return DEFAULT_NOT_FOUND_HINT;
  }
  if (status === 429) return " (rate limited. Wait a few seconds and retry, or reduce request frequency)";
  if (status >= 500) return " (upstream API error. Retry in a moment; if persistent, contact https://www.redditapis.com)";
  return "";
}

// Standing instructions the client hands its model alongside the tool list.
//
// THIS IS THE ONLY PLACE GUIDANCE LIVES (0.9.0). Tool and parameter
// descriptions state product facts only: what a tool returns, its inputs, its
// cost, its errors. Which tool to use when, how to read a partial answer, how
// to get a Reddit session and the feedback policy are model guidance, and the
// protocol's place for that is the server instructions, so it is here and
// nowhere else. test/description-compliance.test.mjs fails if a description
// names another tool or instructs the model, and checks that this text still
// carries the guidance that moved. Kept within 2048 characters: Claude Code
// 2.1.287 truncates server instructions past that (its default
// CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, read from the binary 2026-10-02).
//
// THE SESSION SENTENCE IS CONDITIONAL. It names the five tools that take the
// caller's Reddit cookies; a server built with inlineCredentials:false does not
// register them, and instructions that point at a tool the client cannot see
// would send the model looking for it. buildInstructions drops that sentence
// in that mode; INSTRUCTIONS is the default (local, all tools) text.
const SESSION_SENTENCE =
  "reddit_home_feed and reddit_user_upvoted/saved/hidden/gilded need the user's own Reddit cookies (reddit_session, loid) from POST /api/reddit/login on the REST API, not an MCP tool. ";

export function buildInstructions({ inlineCredentials = true } = {}) {
  return INSTRUCTIONS_HEAD + (inlineCredentials ? SESSION_SENTENCE : "") + INSTRUCTIONS_TAIL;
}

const INSTRUCTIONS_HEAD =
  "redditapis.com MCP server. Read tools cost credits per call (most $0.002); monitor, webhook and feedback tools are free. " +
  "reddit_account_me shows the balance for free before a large batch; on a 402, give the user the error's top-up URL. " +
  "reddit_search: sort='relevance' with a large `limit` for best matches; sort_type='score' re-orders that page. " +
  "reddit_deep_comment_search returns matching comments; reddit_search_comments only their posts. " +
  "reddit_search_communities searches subreddits; reddit_subreddits_popular/new/default browse them. Reads arrive trimmed; a trimmed result carries `context` with what was cut and how to widen it. ";

const INSTRUCTIONS_TAIL =
  "A null `after` with listing_status truncated or unknown is a partial answer: say so and widen the sort, timeframe or query. " +
  "In monitor health read stream_liveness, then coverage_24h; unknown, partial or null is unanswered, not healthy. " +
  "A monitor update replaces the whole filter, so resupply subreddit and kind. On a failed webhook test, relay its `hint`. " +
  "Feedback: never send a draft unless the user names it after reviewing action \"list\"; drafting is local and silent. " +
  "Draft with reddit_feedback_send (action \"draft\") when a call other than 401/402/429 gets worked around, no tool covers the ask, " +
  "a documented field is empty or wrong, or the user is frustrated: one per issue, unannounced mid-task, " +
  "three bullets (What happened, Repro, Evidence), optionally one goal line in your words, never a quote; identifiers only, never payloads, secrets or personal names. " +
  "Before drafting a report that a parameter is IGNORED or a field is EMPTY, re-run the call with a distinctive value that could only match if the parameter was honoured, and with the phrase quoted; " +
  "if either comes back on topic the issue is ranking or matching, so title it that way and say what the control showed.";

export const INSTRUCTIONS = buildInstructions({ inlineCredentials: true });

/**
 * Build one server for one caller.
 *
 * @param {object} opts
 * @param {string|undefined} opts.apiKey   the caller's key; calls fail clearly without one
 * @param {string} [opts.baseUrl]          API origin, default https://api.redditapis.com
 * @param {number} [opts.timeoutMs]        per-request timeout, must be > 0
 * @param {object} [opts.feedbackEnv]      env-shaped object for the feedback queue location
 *                                         (REDDITAPIS_FEEDBACK_DIR); a remote host gives each
 *                                         caller its own directory
 * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
 * @param {Record<string,string>} [opts.authHeaders]
 *        headers that authenticate each call INSTEAD of the API key, for a host
 *        that already authenticated the caller another way (a connected app's
 *        OAuth token resolved to an account) and forwards calls over its own
 *        trusted channel. When set, no API key is required or sent.
 * @param {(ms:number)=>Promise<void>} [opts.sleepImpl] injectable for tests
 * @param {number[]} [opts.retryDelaysMs] waits before each retry of a read that
 *        hit a gateway failure (an API restart); default [3000, 8000]
 * @param {object} [opts.compact]       COMPACT_DEFAULTS-shaped overrides for the
 *        response shaper in src/compact.js: default `limit`, the byte budget, the
 *        comment-tree caps, and the drop/keep field lists. `raw: true` restores
 *        the verbatim passthrough. The stdio entry point fills this from the
 *        REDDITAPIS_MCP_* environment; a host embedding createServer passes
 *        values directly, in keeping with the rule that nothing here reads
 *        process.env.
 * @param {string[]} [opts.skipTools]   name patterns (`*` wildcards) of tools to
 *        leave UNREGISTERED, for a client that only needs part of the catalog.
 *        Every registered tool costs its description in the model's context on
 *        every turn: measured by `npm run measure:context`, the 46-tool catalog
 *        carries 74,275 bytes of tool and parameter description text, about 18,600
 *        tokens, before a single call is made, and a read-only client drops that to
 *        42,786 bytes over 29 tools. Same mechanism as inlineCredentials -- filtered
 *        at registration, so an excluded tool is absent from tools/list and a call
 *        naming it is an unknown tool rather than a tool that answers nothing.
 * @param {boolean} [opts.inlineCredentials] default true. false leaves every
 *        tool whose input schema takes the caller's Reddit cookies or session
 *        proxy (takesInlineCredentials in tools.js) UNREGISTERED, and drops the
 *        instructions sentence that names them. A remote host passes false so a
 *        connected app is never asked to send a Reddit session through it.
 */
export function createServer({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  feedbackEnv = process.env,
  fetchImpl = fetch,
  authHeaders = null,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  retryDelaysMs = [3000, 8000],
  inlineCredentials = true,
  compact = {},
  skipTools = [],
} = {}) {
  // A STRING "false" from an environment variable must not silently leave the
  // cookie tools exposed on a hosted server (review 2026-10-02): booleans only.
  if (typeof inlineCredentials !== "boolean") {
    throw new TypeError(`inlineCredentials must be a boolean, got ${typeof inlineCredentials}`);
  }
  const BASE_URL = String(baseUrl).replace(/\/+$/, "");
  const REQUEST_TIMEOUT_MS = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  // The response shaper. Built once per server, like everything else here, and
  // applied ONLY to a plain GET read under /api/reddit/ on its way out of the
  // tool handler: callEndpoint itself stays verbatim, because src/watch.js parses
  // those bodies and the provenance ledger reports the UPSTREAM byte count.
  const compactor = createCompactor(compact);

  // Tool-name patterns to leave unregistered. Compiled once, and an empty list is
  // the identity, so every host that does not set it keeps the whole catalog.
  const skipPatterns = (Array.isArray(skipTools) ? skipTools : [skipTools])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"));
  const skipped = (tool) => skipPatterns.some((re) => re.test(tool.name));

  // The last tool call that failed, so a feedback draft can carry the endpoint,
  // status and request id without the model retyping them. Set in callEndpoint's
  // error branch; the tool name is added by the registration wrapper below.
  // Per server, so one caller's failure never reaches another caller's draft.
  let lastError = null;

  // Provenance of what this caller has already fetched: which tool reached
  // which endpoint, when the response arrived, the upstream request id and the
  // size. Per server for the same reason lastError is (see the file header);
  // in memory only, bounded, and read back by reddit_explain. See
  // src/provenance.js for why this is an observation of OUR calls and not a
  // cache age: there is no response cache on the read path to age.
  const readLedger = createReadLedger();

  // REST call. Resolves any {param} path placeholders from args, and for GET
  // sends the rest as a query string; for POST it sends the rest as a JSON body
  // (see buildBody -- `tool` is passed through only to read its
  // `filterSpecFields`). Forwards the API key as a Bearer token (redditapis.com
  // authenticates via `Authorization: Bearer <key>` only).
  async function callEndpoint(pathTemplate, args, method = "GET", tool = null) {
    // The credential check lives here, not at startup, so listing tools needs no
    // key and calling one still cannot silently proceed without it. Without this
    // the request would carry an Authorization header reading "Bearer
    // undefined" and the caller would read a 401 about an INVALID key when the
    // real answer is that no key was ever set.
    if (!apiKey && !authHeaders) return paywallResult("no_key");
    const { path, rest: pathRest } = buildPath(pathTemplate, args);
    // A tool that declares `sessionHeaders` has its Reddit session args lifted
    // out of the query and onto headers. For every other tool this is the
    // identity, so the request is byte-for-byte what it was before.
    const { headers: sessionHeaders, rest } = buildHeaders(tool, pathRest);
    const isWrite = method !== "GET";
    const q = isWrite ? "" : buildQuery(rest);
    const url = `${BASE_URL}${path}${q ? `?${q}` : ""}`;

    const headers = {
      ...(authHeaders ? authHeaders : { Authorization: `Bearer ${apiKey}` }),
      accept: "application/json",
      "user-agent": `reddit-mcp/${VERSION}`,
      ...sessionHeaders,
    };
    let requestBody;
    if (isWrite) {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(buildBody(tool || {}, rest));
    }

    // An API restart makes the gateway answer an HTML 502/503 or refuse the
    // connection for a short window. A READ is retried through it; the API's own
    // JSON errors, timeouts and writes never are, so a request the API may already have
    // handled is never sent twice (a gateway 504 is not retried for that reason).
    // Only a REFUSED connection is retried: the request never reached the API,
    // so it cannot have been handled or billed. A reset, a broken pipe or a
    // socket dropped mid-answer can all happen after the API did the work, and
    // "fetch failed" alone also covers DNS and TLS errors that retrying cannot fix.
    const RETRYABLE_NET = new Set(["ECONNREFUSED"]);
    const gatewayFailure = (status, text) =>
      (status === 502 || status === 503) && /^\s*<(!doctype|html)/i.test(text);
    const transientNetwork = (err) =>
      !gotResponse && err?.name !== "AbortError" && RETRYABLE_NET.has(err?.cause?.code ?? err?.code);
    let attempt = 0;
    let gotResponse = false;
    for (;;) {
    gotResponse = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { method, headers, body: requestBody, signal: ctrl.signal });
      gotResponse = true;
      const body = await res.text();
      if (!isWrite && attempt < retryDelaysMs.length && gatewayFailure(res.status, body)) {
        clearTimeout(timer);
        await sleepImpl(retryDelaysMs[attempt++]);
        continue;
      }
      if (!res.ok) {
        const hint = hintFor(res.status, path);
        lastError = {
          path,
          method,
          status: res.status,
          requestId: res.headers.get("x-request-id") || undefined,
          ts: Date.now(),
        };
        // Credential, credit, rate-limit and not-found failures are the caller's
        // situation (a 404 is almost always a wrong id or a deleted thing, a 409
        // a conflict with the caller's own state), not a product defect;
        // everything else may be one, and the model reads error bodies closely,
        // so the pointer lives here.
        const feedbackHint =
          res.status === 401 || res.status === 402 || res.status === 404 || res.status === 409 || res.status === 429
            ? ""
            : " If this blocked the user's task and looks like a defect or a missing capability, draft a report with reddit_feedback_send (queued locally until the user reviews it).";
        const pw = classifyPaywall(res.status, body);
        if (pw) {
          return paywallResult(pw.kind, `HTTP ${res.status}: ${body.slice(0, 1200)}`, pw.topUpUrl ? { action_url: pw.topUpUrl } : {});
        }
        return { isError: true, content: [{ type: "text", text: `HTTP ${res.status}${hint}: ${body.slice(0, 1200)}${feedbackHint}` }] };
      }
      // A success clears the record so a later draft never inherits an old
      // failure's endpoint or request id (review 2026-09-04: a remove's draft
      // carried the previous update's 404).
      lastError = null;
      // Recorded only on a SUCCESS, because a failed call produced no rows and
      // so has no provenance to explain. The tool name comes from the catalog
      // entry the caller invoked; a composite tool passes its own name on each
      // leg, so a leg is attributed to the tool that actually made it.
      readLedger.record({
        tool: tool?.name || "(unnamed)",
        path,
        method,
        requestId: res.headers.get("x-request-id") || null,
        bytes: body.length,
      });
      return { content: [{ type: "text", text: body }] };
    } catch (err) {
      if (!isWrite && attempt < retryDelaysMs.length && transientNetwork(err)) {
        clearTimeout(timer);
        await sleepImpl(retryDelaysMs[attempt++]);
        continue;
      }
      const code = err?.cause?.code ?? err?.code;
      const msg = err?.name === "AbortError"
        ? `timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `${err?.message || String(err)}${code ? ` (${code})` : ""}`;
      lastError = { path, method, status: null, error: msg.slice(0, 200), ts: Date.now() };
      return { isError: true, content: [{ type: "text", text: `Request failed: ${msg}` }] };
    } finally {
      clearTimeout(timer);
    }
    }
  }

  const server = new McpServer(
    { name: "redditapis", version: VERSION },
    { instructions: buildInstructions({ inlineCredentials: inlineCredentials !== false }) },
  );

  // Handlers for tools that carry local: "<name>" in the catalog. A name the
  // catalog uses and this map lacks is a boot-time failure, never a silent
  // passthrough to the API with the local args attached.
  const LOCAL_HANDLERS = {
    feedback: createFeedbackHandler({
      callEndpoint,
      version: VERSION,
      getClientInfo: () => server.server.getClientVersion(),
      getLastError: () => lastError,
      env: feedbackEnv,
    }),
    set_watch: createSetWatchHandler({ callEndpoint }),
    explain: createExplainHandler({ listReads: () => readLedger.list() }),
  };

  // The playbooks are RESOURCES, not tools: the MCP specification makes
  // resources application-driven, which is the right primitive for a recipe a
  // host or a person picks by name. Registering them here is what puts them in
  // the same catalog every caller receives. See src/playbooks.js for why the
  // metadata and the contents are held to different standards.
  registerPlaybooks(server);

  let registeredTools = 0;
  for (const tool of TOOLS) {
    // Filtered at registration, so a hidden tool is absent from tools/list and
    // a tools/call naming it fails as an unknown tool, never reaching the API.
    if (inlineCredentials === false && takesInlineCredentials(tool)) continue;
    if (skipped(tool)) continue;
    registeredTools++;
    const method = tool.method || "GET";
    const annotations = {
      title: tool.name,
      readOnlyHint: !tool.write,
      destructiveHint: Boolean(tool.destructive),
      openWorldHint: true,
    };
    let handler;
    if (tool.local) {
      handler = LOCAL_HANDLERS[tool.local];
      if (!handler) throw new Error(`[reddit-mcp] tool ${tool.name} declares local handler "${tool.local}" but src/server.js has none`);
    } else {
      handler = async (args) => {
        // A read that did not ask for a page size gets this server's default
        // (src/compact.js), and the result says so in `context`.
        const sent = compactor.applyDefaultLimit(tool, args);
        const result = await callEndpoint(tool.path, sent.args, method, tool);
        if (result?.isError && lastError) {
          let resolved = null;
          try { resolved = buildPath(tool.path, args).path; } catch { resolved = null; }
          // Name the tool only when BOTH method and path match the recorded
          // failure; a GET and a POST can share a path.
          if (sameFailure(lastError, resolved, method)) lastError.tool = tool.name;
        }
        if (result?.isError) return result;
        return compactor.compactResult(tool, result, { defaultedLimit: sent.defaulted });
      };
    }
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape, annotations },
      handler,
    );
  }

  return {
    server,
    callEndpoint,
    compactor,
    registeredTools,
    getLastError: () => lastError,
    getReads: () => readLedger.list(),
    baseUrl: BASE_URL,
    timeoutMs: REQUEST_TIMEOUT_MS,
  };
}
