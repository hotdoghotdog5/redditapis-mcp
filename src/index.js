#!/usr/bin/env node
// redditapis-mcp, official MCP server for redditapis.com
//
// Exposes the Reddit API as native MCP tools for Claude, Cursor, and any MCP
// client: subreddit listings, post + comment search, community/user/media/comment
// search, a post's comment tree, subreddit top posts, user profile/comments,
// (since 0.2.0) managing your own redditapis.com monitors and webhooks -- create/
// list/update/remove a monitor, register/list/test/delete a webhook, and read
// delivery history -- and (since 0.4.0) sending the team product feedback the
// user has reviewed. Each tool is a thin, typed wrapper over a REST endpoint at
// https://api.redditapis.com, except reddit_feedback_send, whose draft queue
// lives on this machine (./feedback.js) and posts only on the user's say. The
// tool catalog lives in ./tools.js; the server itself is built by
// createServer() in ./server.js, which holds every per-caller value (key, last
// failure) in its own closure so the same code can serve many callers.
//
// This file is the stdio entry point and the ONLY place config is read from
// the environment:
//   REDDITAPIS_KEY        required. Your key from https://www.redditapis.com
//                         (REDDIT_APIS_KEY is accepted as an alias).
//   REDDITAPIS_BASE_URL   optional. Defaults to https://api.redditapis.com
//   REDDITAPIS_TIMEOUT_MS optional. Per-request timeout (default 30000)
//   REDDITAPIS_FEEDBACK_DIR optional. Where reddit_feedback_send keeps its
//                         local draft queue (default ~/.redditapis)
//   REDDITAPIS_MCP_MAX_BYTES optional. Ceiling on the text of one read result
//                         (default 12000, about 3000 tokens). See src/compact.js.
//   REDDITAPIS_MCP_DEFAULT_LIMIT optional. `limit` sent for a read that did not
//                         ask for one (default 10; 0 leaves the endpoint's own
//                         default, 25 on the listings, untouched).
//   REDDITAPIS_MCP_MAX_COMMENTS, REDDITAPIS_MCP_MAX_REPLIES,
//   REDDITAPIS_MCP_COMMENT_DEPTH optional. Comment-tree caps: top comments of a
//                         post by score (10), replies kept per comment (3), and
//                         reply levels below each one (2).
//   REDDITAPIS_MCP_BODY_CHARS, REDDITAPIS_MCP_TEXT_CHARS,
//   REDDITAPIS_MCP_MAX_FIELD_BYTES optional. Text and per-field ceilings.
//   REDDITAPIS_MCP_DROP_FIELDS, REDDITAPIS_MCP_KEEP_FIELDS optional. Comma lists
//                         that add to and subtract from the dropped Reddit field
//                         families (`*` for a prefix, e.g. "preview,link_flair_*").
//   REDDITAPIS_MCP_RAW    optional. 1/true restores the verbatim upstream body,
//                         exactly as every release before 0.11.0 returned it.
//   REDDITAPIS_MCP_SKIP_TOOLS optional. Comma list of tool-name patterns to leave
//                         unregistered, e.g. "reddit_monitor_*,reddit_feedback_*".
//                         Each registered tool costs its description in the
//                         model's context on every turn.
//
// Run:  npx -y redditapis-mcp@latest   (stdio transport)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS } from "./tools.js";
import { createServer, hintFor, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./server.js";
import { compactionFromEnv } from "./compact.js";

// Re-exported so existing importers of the entry point keep working.
export { hintFor };

const API_KEY = process.env.REDDITAPIS_KEY || process.env.REDDIT_APIS_KEY;
const BASE_URL = process.env.REDDITAPIS_BASE_URL || DEFAULT_BASE_URL;
const REQUEST_TIMEOUT_MS = Number(process.env.REDDITAPIS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
const COMPACT = compactionFromEnv(process.env);
const SKIP_TOOLS = String(process.env.REDDITAPIS_MCP_SKIP_TOOLS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// WARN AND CONTINUE, NEVER exit. A registry scanner spawns the server and calls
// tools/list to enumerate what it offers, and tools/list is the DISCOVERY step
// in the MCP spec: it comes before tool selection and before any invocation, so
// it needs no credential. Exiting here answers that scan with nothing.
//
// This is not a hypothesis. Measured 2026-09-06 by speaking raw MCP stdio to
// the published redditapis-mcp@0.5.2 with an empty env: initialize was never
// answered and tools/list returned nothing, because this line fired first. A
// scanner that behaves this way reports the server as uninspectable rather than
// as having no tools, so the listing carries no catalog at all.
//
// NOT a security relaxation. This is a stdio server: whoever spawns it already
// has local execution, so there is no unauthenticated party to expose anything
// to. A real tool CALL with no key still fails clearly, at the point of the
// call, exactly as it already does for a WRONG key (see the 401 branch in
// server.js).
if (!API_KEY) {
  console.error(
    "[reddit-mcp] Missing REDDITAPIS_KEY. Get a key at https://www.redditapis.com and set it in your MCP client config. Tools are registered but every call will fail until it is set.",
  );
}

async function main() {
  const { server, baseUrl, compactor, registeredTools } = createServer({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    timeoutMs: REQUEST_TIMEOUT_MS,
    feedbackEnv: process.env,
    compact: COMPACT,
    skipTools: SKIP_TOOLS,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logs go to stderr so they never corrupt the stdio JSON-RPC stream. The
  // compaction figures are logged because they are the difference between a chat
  // that survives a research turn and one that dies on context: a client that
  // puts every tool result back into the next request needs to know what a result
  // was allowed to cost.
  console.error(
    `[reddit-mcp] ready · ${registeredTools} of ${TOOLS.length} tools · base ${baseUrl} · `
    + (compactor.settings.raw
      ? "raw bodies (compaction off)"
      : `reads ≤ ${compactor.settings.maxBytes} bytes, default limit ${compactor.settings.defaultLimit || "endpoint"}, top ${compactor.settings.commentsPerPost} comments/post`),
  );
}

main().catch((err) => {
  console.error("[reddit-mcp] fatal:", err);
  process.exit(1);
});
