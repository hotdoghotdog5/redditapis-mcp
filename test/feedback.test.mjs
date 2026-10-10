#!/usr/bin/env node
// feedback.test.mjs: the local draft queue behind reddit_feedback_send.
// No network: callEndpoint is a recorder, and the assertion that a draft makes
// ZERO calls is the red test that matters (a draft that posted would send an
// unreviewed report). The queue lives in a temp dir via REDDITAPIS_FEEDBACK_DIR
// so a run never touches the developer's real queue.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedbackHandler, queuePath, draftId, QUEUE_CAP, sameFailure } from "../src/feedback.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else { fail++; console.error("  FAIL:", name, detail); }
};

const dir = mkdtempSync(join(tmpdir(), "redditapis-feedback-"));
const env = { REDDITAPIS_FEEDBACK_DIR: dir };
const calls = [];
let nextResponse = () => ({ content: [{ type: "text", text: JSON.stringify({ id: "srv-1", status: "new" }) }] });
const callEndpoint = async (path, args, method) => {
  calls.push({ path, args, method });
  return nextResponse();
};
let lastError = null;
const tool = createFeedbackHandler({
  callEndpoint,
  version: "9.9.9",
  getClientInfo: () => ({ name: "claude-code", version: "2.1.259" }),
  getLastError: () => lastError,
  env,
});
const txt = (r) => r.content[0].text;
const queue = () => JSON.parse(readFileSync(queuePath(env), "utf8")).drafts;

check("queue path honours REDDITAPIS_FEEDBACK_DIR", queuePath(env) === join(dir, "feedback-queue.json"));
check("default queue path is under ~/.redditapis", /\.redditapis\/feedback-queue\.json$/.test(queuePath({})));

// draft
{
  const r = await tool({ type: "bug", title: "post_comments 502 on deleted post", details: "- What happened: 502\n- Repro: x\n- Evidence: y", area: "posts/comments" });
  check("draft is not an error", !r.isError, txt(r));
  check("draft says nothing was sent", /Nothing was sent/.test(txt(r)));
  check("draft made no network call", calls.length === 0);
  const q = queue();
  check("one draft on disk", q.length === 1);
  check("draft id is stable", q[0].id === draftId("bug", "post_comments 502 on deleted post"));
  check("client is filled from the handshake and version", q[0].client === "claude-code/2.1.259 via redditapis-mcp@9.9.9");
  check("evidence carries mcp_version", q[0].evidence.mcp_version === "9.9.9");
  check("area kept", q[0].area === "posts/comments");
}
{
  const r = await tool({ type: "bug", title: "Post_comments 502 on deleted post ", details: "updated details" });
  check("redraft replaces", /replaced an earlier draft/.test(txt(r)));
  check("still one draft", queue().length === 1);
  check("details updated", queue()[0].details === "updated details");
}
{
  lastError = { tool: "reddit_post_comments", path: "/api/reddit/comments", status: 502, requestId: "req_9" };
  await tool({ type: "missing_capability", title: "no way to list a subreddit's flairs", details: "d", evidence: { status: 418 } });
  const d = queue().find((x) => x.type === "missing_capability");
  check("evidence.tool filled from last error", d.evidence.tool === "reddit_post_comments");
  check("evidence.endpoint filled from last error", d.evidence.endpoint === "/api/reddit/comments");
  check("model-supplied evidence.status wins", d.evidence.status === 418);
  check("request_id filled", d.evidence.request_id === "req_9");
  lastError = null;
}
{
  const bad1 = await tool({ type: "rant", title: "t", details: "d" });
  check("bad type is an error", bad1.isError && /type is required/.test(txt(bad1)));
  const bad2 = await tool({ type: "idea", title: "", details: "d" });
  check("empty title is an error", bad2.isError && /title is required/.test(txt(bad2)));
  const bad3 = await tool({ type: "idea", title: "t", details: "" });
  check("empty details is an error", bad3.isError && /three labelled bullets/.test(txt(bad3)));
  const bad4 = await tool({ type: "idea", title: "t", details: "d", evidence: { blob: "x".repeat(5000) } });
  check("oversized evidence is an error", bad4.isError && /4096/.test(txt(bad4)));
  check("rejections wrote nothing", queue().length === 2);
  check("rejections made no network call", calls.length === 0);
}

// list
{
  const r = await tool({ action: "list" });
  check("list names both drafts", /2 feedback draft\(s\) pending/.test(txt(r)) && /502/.test(txt(r)) && /flairs/.test(txt(r)));
  check("list makes no network call", calls.length === 0);
}

// send
{
  const noIds = await tool({ action: "send" });
  check("send without ids is an error", noIds.isError && /needs ids/.test(txt(noIds)));
  const unknown = await tool({ action: "send", ids: ["deadbeef"] });
  check("unknown id is an error", unknown.isError && /Unknown draft id/.test(txt(unknown)));
  check("no call for a refused send", calls.length === 0);

  const id = draftId("bug", "post_comments 502 on deleted post");
  const r = await tool({ action: "send", ids: [id] });
  check("send is not an error", !r.isError, txt(r));
  check("exactly one POST", calls.length === 1);
  check("posted to /feedback as a POST", calls[0].path === "/feedback" && calls[0].method === "POST");
  check("body carries the draft fields", calls[0].args.type === "bug" && calls[0].args.details === "updated details" && calls[0].args.client.startsWith("claude-code/"));
  check("body carries no local-only keys", !("action" in calls[0].args) && !("ids" in calls[0].args));
  check("reports the server id", /srv-1/.test(txt(r)));
  check("sent draft left the queue", queue().length === 1 && queue()[0].type === "missing_capability");
}
{
  nextResponse = () => ({ isError: true, content: [{ type: "text", text: "HTTP 502 (upstream)" }] });
  const id = queue()[0].id;
  const r = await tool({ action: "send", ids: [id] });
  check("failed send is an error result", r.isError === true);
  check("failed send names the draft", new RegExp(id).test(txt(r)) && /stayed in the queue/.test(txt(r)));
  check("draft kept", queue().length === 1);
  nextResponse = () => ({ content: [{ type: "text", text: "{}" }] });
}

// discard
{
  const id = queue()[0].id;
  const r = await tool({ action: "discard", ids: [id] });
  check("discard confirms", /Discarded 1/.test(txt(r)));
  check("queue empty", queue().length === 0);
  const empty = await tool({ action: "list" });
  check("empty list says so", /No feedback drafts pending/.test(txt(empty)));
}

// cap
{
  for (let i = 0; i < QUEUE_CAP; i++) await tool({ type: "idea", title: `idea ${i}`, details: "d" });
  check(`queue holds ${QUEUE_CAP}`, queue().length === QUEUE_CAP);
  const over = await tool({ type: "idea", title: "one too many", details: "d" });
  check("cap refuses the eleventh", over.isError && /already holds/.test(txt(over)));
  check("cap did not write", queue().length === QUEUE_CAP);
  const bad = await tool({ action: "explode" });
  check("unknown action is an error", bad.isError);
  check("drafting never made a network call", calls.length === 2);
}

// ── review fixes (2026-09-04) ─────────────────────────────────────────────
{
  // Junk entries in the file are skipped, never thrown on.
  await tool({ action: "discard", ids: queue().map((d) => d.id) });
  await tool({ type: "bug", title: "real one", details: "d" });
  const raw = JSON.parse(readFileSync(queuePath(env), "utf8"));
  raw.drafts.push(null, { id: "half" }, 7);
  writeFileSync(queuePath(env), JSON.stringify(raw));
  const l = await tool({ action: "list" });
  check("list survives junk entries", !l.isError && /1 feedback draft/.test(txt(l)), txt(l));
  const d = await tool({ type: "idea", title: "another", details: "d" });
  check("draft survives junk entries", !d.isError, txt(d));
  check("junk dropped on the next write", JSON.parse(readFileSync(queuePath(env), "utf8")).drafts.every((x) => x && typeof x.id === "string"));
}
{
  // Duplicate ids post once; each success is persisted before the next send.
  calls.length = 0;
  const ids = queue().map((d) => d.id);
  let n = 0;
  nextResponse = () => (++n === 1
    ? { content: [{ type: "text", text: '{"id":"srv-a"}' }] }
    : { isError: true, content: [{ type: "text", text: "HTTP 502" }] });
  const r = await tool({ action: "send", ids: [ids[0], ids[0], ids[1]] });
  check("duplicate id posts once", calls.filter((c) => c.args.title === "real one").length === 1);
  check("second draft failed and stayed", queue().length === 1 && queue()[0].id === ids[1], txt(r));
  nextResponse = () => ({ content: [{ type: "text", text: "{}" }] });
  await tool({ action: "discard", ids: queue().map((d) => d.id) });
}
{
  // Stale or self-referential lastError is not attached; a fresh one is.
  lastError = { tool: "reddit_user_profile", path: "/api/reddit/user/spez", status: 500, ts: Date.now() - 11 * 60 * 1000 };
  await tool({ type: "bug", title: "stale check", details: "d" });
  check("stale lastError ignored", queue()[0].evidence.tool === undefined);
  lastError = { path: "/feedback", method: "POST", status: 502, ts: Date.now() };
  await tool({ type: "bug", title: "self check", details: "d" });
  check("a failed send is not evidence", queue().find((d) => d.title === "self check").evidence.endpoint === undefined);
  lastError = { tool: "reddit_user_profile", path: "/api/reddit/user/spez", status: 500, ts: Date.now() };
  await tool({ type: "bug", title: "fresh check", details: "d" });
  check("fresh lastError attached", queue().find((d) => d.title === "fresh check").evidence.tool === "reddit_user_profile");
  lastError = null;
  await tool({ action: "discard", ids: queue().map((d) => d.id) });
}
{
  // client is capped at what billing accepts.
  const longTool = createFeedbackHandler({ callEndpoint, version: "9.9.9", getClientInfo: () => ({ name: "x".repeat(200), version: "1" }), env });
  await longTool({ type: "idea", title: "long client", details: "d" });
  check("client capped at 120", queue()[0].client.length === 120);
  await tool({ action: "discard", ids: queue().map((d) => d.id) });
}
{
  // Two processes drafting into one queue lose nothing.
  const dir2 = mkdtempSync(join(tmpdir(), "redditapis-feedback-race-"));
  const code = `import("${new URL("../src/feedback.js", import.meta.url).pathname}").then(async ({ createFeedbackHandler }) => { const t = createFeedbackHandler({ callEndpoint: async () => ({}), version: "0", env: { REDDITAPIS_FEEDBACK_DIR: process.argv[1] } }); for (let i = 0; i < 5; i++) await t({ type: "idea", title: process.argv[2] + i, details: "d" }); });`;
  const procs = ["A-", "B-"].map((tag) => spawnSync(process.execPath, ["--input-type=module", "-e", code, dir2, tag], { encoding: "utf8" }));
  const p2 = spawnSync(process.execPath, ["--input-type=module", "-e", code, dir2, "C-"], { encoding: "utf8" });
  const survivors = JSON.parse(readFileSync(join(dir2, "feedback-queue.json"), "utf8")).drafts.map((d) => d.title).sort();
  check("sequential writers keep all drafts", survivors.length === 10 && survivors.filter((t) => t.startsWith("A-")).length === 5, survivors.join(","));
  // True concurrency: two writers started together.
  const dir3 = mkdtempSync(join(tmpdir(), "redditapis-feedback-race2-"));
  const { spawn } = await import("node:child_process");
  await Promise.all(["A-", "B-"].map((tag) => new Promise((res) => spawn(process.execPath, ["--input-type=module", "-e", code, dir3, tag], { stdio: "ignore" }).on("exit", res))));
  const s3 = JSON.parse(readFileSync(join(dir3, "feedback-queue.json"), "utf8")).drafts.map((d) => d.title);
  check("concurrent writers keep all drafts (10 of 10)", s3.length === 10, s3.join(","));
  rmSync(dir2, { recursive: true, force: true }); rmSync(dir3, { recursive: true, force: true });
  void procs; void p2;
}

{
  // The tool-naming predicate index.js uses: method AND path, never path alone.
  const last = { path: "/api/reddit/x", method: "POST", status: 500, ts: Date.now() };
  check("sameFailure: same path and method matches", sameFailure(last, "/api/reddit/x", "POST"));
  check("sameFailure: same path, different method does NOT match", !sameFailure(last, "/api/reddit/x", "GET"));
  check("sameFailure: different path does not match", !sameFailure(last, "/api/reddit/y", "POST"));
  check("sameFailure: no record does not match", !sameFailure(null, "/api/reddit/x", "POST"));
}

// ── second-wave review fixes (2026-09-04) ───────────────────────────────
{
  // Per-send persistence, observed DURING the batch: by the time the second
  // draft is posted, the first is already gone from the file.
  await tool({ action: "discard", ids: queue().map((d) => d.id) });
  await tool({ type: "idea", title: "batch first", details: "d" });
  await tool({ type: "idea", title: "batch second", details: "d" });
  const [id1, id2] = queue().map((d) => d.id);
  calls.length = 0;
  let seenDuringSecond = null;
  const observing = createFeedbackHandler({
    callEndpoint: async (path, args) => {
      if (args.title === "batch second") seenDuringSecond = queue().map((d) => d.id);
      return { content: [{ type: "text", text: JSON.stringify({ id: `srv-${args.title}` }) }] };
    },
    version: "9.9.9", env,
  });
  const r = await observing({ action: "send", ids: [id1, id2] });
  check("both drafts sent", !r.isError && /Sent 2/.test(txt(r)), txt(r));
  check("first draft already gone from disk while the second is being posted", Array.isArray(seenDuringSecond) && !seenDuringSecond.includes(id1) && seenDuringSecond.includes(id2), JSON.stringify(seenDuringSecond));
  check("queue empty after the batch", queue().length === 0);
}
{
  // The lock is never held across the network: A sends with an upstream that
  // outlasts LOCK_STALE_MS while B drafts; B's draft survives and A's posted
  // draft is gone. Two real processes, one queue directory.
  const dirL = mkdtempSync(join(tmpdir(), "redditapis-feedback-slowsend-"));
  const mod = new URL("../src/feedback.js", import.meta.url).pathname;
  const seed = `import("${mod}").then(async ({ createFeedbackHandler }) => { const t = createFeedbackHandler({ callEndpoint: async () => ({}), version: "0", env: { REDDITAPIS_FEEDBACK_DIR: process.argv[1] } }); await t({ type: "idea", title: "A-posted", details: "d" }); });`;
  spawnSync(process.execPath, ["--input-type=module", "-e", seed, dirL], { encoding: "utf8" });
  const idA = JSON.parse(readFileSync(join(dirL, "feedback-queue.json"), "utf8")).drafts[0].id;
  const sender = `import("${mod}").then(async ({ createFeedbackHandler }) => { const t = createFeedbackHandler({ callEndpoint: () => new Promise((r) => setTimeout(() => r({ content: [{ type: "text", text: '{"id":"srv-slow"}' }] }), 11500)), version: "0", env: { REDDITAPIS_FEEDBACK_DIR: process.argv[1] } }); const out = await t({ action: "send", ids: [process.argv[2]] }); process.stdout.write(out.content[0].text); });`;
  const drafter = `import("${mod}").then(async ({ createFeedbackHandler }) => { const t = createFeedbackHandler({ callEndpoint: async () => ({}), version: "0", env: { REDDITAPIS_FEEDBACK_DIR: process.argv[1] } }); const out = await t({ type: "idea", title: "B-during", details: "d" }); process.stdout.write(out.content[0].text); });`;
  const { spawn } = await import("node:child_process");
  const wait = (child) => new Promise((res) => { let out = ""; child.stdout.on("data", (c) => (out += c)); child.on("exit", (code) => res({ code, out })); });
  const a = spawn(process.execPath, ["--input-type=module", "-e", sender, dirL, idA]);
  await new Promise((r) => setTimeout(r, 2000));
  const b = spawn(process.execPath, ["--input-type=module", "-e", drafter, dirL]);
  const [ra, rb] = await Promise.all([wait(a), wait(b)]);
  check("B's draft was accepted while A was mid-send", rb.code === 0 && /Queued locally/.test(rb.out), rb.out.slice(0, 120));
  check("A's send completed", ra.code === 0 && /Sent 1/.test(ra.out), ra.out.slice(0, 160));
  const titles = JSON.parse(readFileSync(join(dirL, "feedback-queue.json"), "utf8")).drafts.map((d) => d.title);
  check("B's draft survives A's slow send and A's posted draft is gone", titles.length === 1 && titles[0] === "B-during", titles.join(","));
  rmSync(dirL, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
// ── a posted report whose draft cannot be removed is never re-sendable ─────
{
  const { mkdtempSync: mkd, mkdirSync: mk, readFileSync: rf, rmSync: rm } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: jn } = await import("node:path");
  const dir5 = mkd(jn(td(), "rapi-feedback-stuck-"));
  const env5 = { REDDITAPIS_FEEDBACK_DIR: dir5 };
  const qp5 = queuePath(env5);
  const lockDir = `${qp5}.lock`;
  let posts5 = 0;
  const stuckTool = createFeedbackHandler({
    callEndpoint: async () => {
      posts5++;
      // A foreign holder takes the lock while we are on the network and keeps it
      // past the lock wait, so the per-success removal cannot take it.
      mk(lockDir, { recursive: true });
      return { content: [{ type: "text", text: JSON.stringify({ id: "srv-stuck" }) }] };
    },
    version: "9.9.9", getClientInfo: () => ({ name: "a", version: "1" }), getLastError: () => null, env: env5,
  });
  await stuckTool({ type: "bug", title: "stuck one", details: "- What happened: 1\n- Repro: 3\n- Evidence: 4" });
  const id5 = JSON.parse(rf(qp5, "utf8")).drafts[0].id;
  const r5 = await stuckTool({ action: "send", ids: [id5] });
  rm(lockDir, { recursive: true, force: true });
  const t5 = r5.content[0].text;
  check("posted once even though the removal failed", posts5 === 1);
  check("the send is reported as a success, not an error", !r5.isError, t5);
  check("the server id is still reported", /srv-stuck/.test(t5), t5);
  check("the caller is told not to resend and to discard", /WERE posted/.test(t5) && new RegExp(id5).test(t5) && /discard/.test(t5), t5);
  rm(dir5, { recursive: true, force: true });
}

console.log(`feedback: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
