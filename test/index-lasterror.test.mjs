#!/usr/bin/env node
// index-lasterror.test.mjs: the server-side half of the feedback loop, driven
// over real stdio against a local HTTP stand-in for api.redditapis.com.
// Asserts what src/index.js records in lastError and what it prints in an
// error body, because src/feedback.js's own tests can only see the record it
// is handed. Each case fails when the matching review fix is removed:
//   - a 404 body carries NO feedback hint (a wrong id is not a defect)
//   - a success CLEARS lastError, so a later draft carries no stale evidence
//   - a transport failure (closed port) is recorded with status null
//   - the tool name is attached only when method AND path match
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => { if (cond) pass++; else { fail++; console.error("  FAIL:", name, detail); } };

const srv = createServer((req, res) => {
  if (req.url.startsWith("/api/reddit/sub/")) { res.writeHead(502, { "content-type": "application/json", "x-request-id": "req_t1" }); res.end('{"error":"upstream"}'); return; }
  if (req.url.startsWith("/api/reddit/search/users")) { res.writeHead(409, { "content-type": "application/json" }); res.end('{"error":"conflict"}'); return; }
  if (req.url.startsWith("/api/reddit/post/")) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not found"}'); return; }
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"posts":[]}');
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "redditapis-lasterror-"));
const queue = () => JSON.parse(readFileSync(join(dir, "feedback-queue.json"), "utf8")).drafts;
const boot = async (baseUrl) => {
  const transport = new StdioClientTransport({ command: "node", args: [new URL("../src/index.js", import.meta.url).pathname], env: { ...process.env, REDDITAPIS_KEY: "rk_test", REDDITAPIS_BASE_URL: baseUrl, REDDITAPIS_FEEDBACK_DIR: dir } });
  const client = new Client({ name: "lasterror-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
};
const txt = (r) => r.content[0].text;
const draft = (client, title) => client.callTool({ name: "reddit_feedback_send", arguments: { type: "bug", title, details: "- What happened: x\n- Repro: z\n- Evidence: auto" } });

const c = await boot(base);
// 502 carries the hint, and the draft that follows names the tool and the request id.
const r502 = await c.callTool({ name: "reddit_subreddit_about", arguments: { name: "webdev" } });
check("502 body carries the feedback hint", /draft a report with reddit_feedback_send/.test(txt(r502)), txt(r502));
await draft(c, "after 502");
let ev = queue().find((d) => d.title === "after 502").evidence;
check("draft after a 502 names the tool, endpoint, status and request id",
  ev.tool === "reddit_subreddit_about" && ev.endpoint === "/api/reddit/sub/webdev/about" && ev.status === 502 && ev.request_id === "req_t1", JSON.stringify(ev));
// 404 carries no hint.
const r404 = await c.callTool({ name: "reddit_post", arguments: { id: "abc123" } });
check("404 is an error result", r404.isError === true);
check("404 body carries NO feedback hint", !/reddit_feedback_send/.test(txt(r404)), txt(r404));
// 409 carries no hint either (a conflict with the caller's own state).
const r409 = await c.callTool({ name: "reddit_search_users", arguments: { q: "x" } });
check("409 is an error result", r409.isError === true, txt(r409));
check("409 body carries NO feedback hint", !/reddit_feedback_send/.test(txt(r409)), txt(r409));
// A success clears the record: the next draft carries nothing from the 404.
const ok = await c.callTool({ name: "reddit_subreddit_posts", arguments: { subreddit: "webdev" } });
check("read after the errors succeeds", !ok.isError, txt(ok));
await draft(c, "after success");
ev = queue().find((d) => d.title === "after success").evidence;
check("a success clears lastError: no tool/endpoint/status inherited", ev.tool === undefined && ev.endpoint === undefined && ev.status === undefined, JSON.stringify(ev));
await c.close();

// Transport failure: a closed port is recorded with status null and the endpoint.
srv.close();
const c2 = await boot(base);
const rt = await c2.callTool({ name: "reddit_subreddit_about", arguments: { name: "webdev" } });
check("closed port is an error result", rt.isError === true && /Request failed/.test(txt(rt)), txt(rt));
await draft(c2, "after transport failure");
ev = queue().find((d) => d.title === "after transport failure").evidence;
check("transport failure recorded: endpoint set, status absent, tool named (method and path match)",
  ev.endpoint === "/api/reddit/sub/webdev/about" && ev.status === undefined && ev.tool === "reddit_subreddit_about", JSON.stringify(ev));
await c2.close();

rmSync(dir, { recursive: true, force: true });
console.log(`index-lasterror: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
