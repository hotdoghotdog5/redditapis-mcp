// src/feedback.js, the local half of reddit_feedback_send.
//
// Claude Code's own feedback tool works like this: the model drafts a report at
// a high-signal moment, the harness writes it to a LOCAL queue, and nothing
// leaves the machine until the user reviews the queue and approves. That
// consent step is what makes it safe to let a model draft freely. This module
// gives redditapis.com customers the same loop inside whatever MCP client
// they already use: action "draft" appends to ~/.redditapis/feedback-queue.json
// and sends nothing; "list" shows the drafts; "send" posts ONLY the ids the user
// named to POST /feedback (free, not metered); "discard" drops them.
//
// The tool DESCRIPTION in src/tools.js is the product: it names
// the trigger moments and the four-bullet format. This file enforces the same
// rules mechanically so a draft that reaches the server is well-formed, and it
// auto-attaches the evidence the server already holds (the last failing call,
// the client name from the MCP handshake, this package's version), so the model
// never has to type identifiers it might get wrong.
//
// STATE ON DISK, ON PURPOSE. The queue outlives the session: a user can review
// tomorrow what an agent drafted today. Writes are atomic (temp file + rename)
// because two MCP clients can share one home directory.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const QUEUE_CAP = 10;
export const TYPES = ["bug", "idea", "missing_capability"];
export const ACTIONS = ["draft", "list", "send", "discard"];
const MAX = { title: 120, details: 8000, area: 80 };
const EVIDENCE_MAX_BYTES = 4096;

/** Where drafts live. REDDITAPIS_FEEDBACK_DIR overrides the default ~/.redditapis. */
export function queuePath(env = process.env) {
  const dir = env.REDDITAPIS_FEEDBACK_DIR || join(homedir(), ".redditapis");
  return join(dir, "feedback-queue.json");
}

/** A draft this module can act on. Anything else in the file (a hand edit, an
 * older shape, a null) is skipped rather than allowed to throw on every call. */
function isDraft(d) {
  return d && typeof d === "object" && !Array.isArray(d)
    && typeof d.id === "string" && typeof d.type === "string"
    && typeof d.title === "string" && typeof d.details === "string";
}

export function readQueue(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.drafts) ? parsed.drafts.filter(isDraft) : [];
  } catch {
    return [];
  }
}

function writeQueue(path, drafts) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, drafts }, null, 2) + "\n");
  renameSync(tmp, path);
}

// Two MCP servers can share one home directory, and temp+rename only keeps the
// file well-formed: without a lock a read-modify-write from each loses one
// side's drafts (measured 2026-09-04: two writers, five of ten drafts gone).
// mkdir is atomic on every platform node runs on, so a lock DIRECTORY is the
// mutex; a holder that died leaves it behind, so one older than STALE_MS is
// reclaimed.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;
async function withLock(path, fn) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; }
      } catch { /* vanished between checks; retry */ }
      if (Date.now() > deadline) throw new Error(`feedback queue is locked by another process (${lock}); retry in a moment`);
      await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Stable per-issue id: the same type + title redrafted replaces itself. */
export function draftId(type, title) {
  return createHash("sha256").update(`${type}\n${title.trim().toLowerCase()}`).digest("hex").slice(0, 8);
}

const CLIENT_MAX = 120; // the backend rejects longer; the model never types this field
function clientString(clientInfo, version) {
  const name = clientInfo?.name ? `${clientInfo.name}${clientInfo.version ? `/${clientInfo.version}` : ""}` : "unknown-client";
  return `${name} via redditapis-mcp@${version}`.slice(0, CLIENT_MAX);
}

// The last failing call is worth attaching only while it is plausibly the call
// the draft is about: recent, and not the feedback endpoint's own failure.
const LAST_ERROR_TTL_MS = 10 * 60 * 1000;
function usableLastError(last) {
  if (!last || typeof last !== "object") return null;
  if (typeof last.ts === "number" && Date.now() - last.ts > LAST_ERROR_TTL_MS) return null;
  if (last.path === "/feedback" || (typeof last.path === "string" && last.path.startsWith("/feedback/"))) return null;
  return last;
}

/** Does a recorded failure describe THIS tool's call? BOTH method and path
 * must match: a GET and a POST can share a path, and naming the wrong tool on
 * a draft sends the team chasing the wrong handler. Exported so the rule is
 * unit-tested here rather than only reachable through a live stdio boot. */
export function sameFailure(last, resolvedPath, method) {
  return Boolean(last) && resolvedPath === last.path && method === last.method;
}

const text = (t, isError = false) => ({ isError, content: [{ type: "text", text: t }] });

function summarize(d) {
  const first = d.details.split("\n")[0].slice(0, 140);
  return `${d.id}  [${d.type}] ${d.title}${d.area ? ` (${d.area})` : ""}  drafted ${d.ts}\n    ${first}`;
}

/**
 * @param {object} deps
 * @param {(path:string, args:object, method:string)=>Promise<object>} deps.callEndpoint
 *        index.js's callEndpoint: a POST sends `args` as the JSON body.
 * @param {string} deps.version            this package's version
 * @param {() => ({name?:string, version?:string}|undefined)} [deps.getClientInfo]
 * @param {() => (object|null)} [deps.getLastError]   the last failing tool call, if any
 * @param {object} [deps.env]
 */
export function createFeedbackHandler({ callEndpoint, version, getClientInfo, getLastError, env = process.env }) {
  return async function feedbackTool(args = {}) {
    const action = args.action || "draft";
    if (!ACTIONS.includes(action)) return text(`action must be one of ${ACTIONS.join(", ")}.`, true);
    const path = queuePath(env);
    try {
      if (action === "send") return await sendAction(args, path);
      return await withLock(path, () => run(action, args, path));
    } catch (err) {
      return text(err?.message || String(err), true);
    }
  };

  // Remove exactly these ids from the queue ON DISK: lock, re-read, filter,
  // write, release. Never from a snapshot taken earlier, so a draft another
  // process added in the meantime survives.
  async function removeFromQueue(path, ids) {
    await withLock(path, () => {
      const now = readQueue(path);
      writeQueue(path, now.filter((x) => !ids.includes(x.id)));
    });
  }

  // NEVER HOLD THE LOCK ACROSS A NETWORK CALL (review 2026-09-04, OBSERVED):
  // LOCK_STALE_MS is 10s and a request may take 30s, so a send that held the
  // lock for the whole batch was reclaimed as stale by a concurrent drafter,
  // and the sender's pre-send snapshot then overwrote that draft. So: under
  // the lock, read and pick; release; post each draft with no lock held; after
  // each success take the lock again, RE-READ the queue and remove exactly
  // that id. A crash mid-batch still never resends a posted draft, and a
  // draft added during the batch is never lost.
  async function sendAction(args, path) {
    const picked = await withLock(path, () => {
      const drafts = readQueue(path);
      const ids = [...new Set((Array.isArray(args.ids) ? args.ids : []).map(String))];
      if (ids.length === 0) return { error: text(`action "send" needs ids: the draft ids the user named (from action "list").`, true) };
      const unknown = ids.filter((id) => !drafts.some((d) => d.id === id));
      if (unknown.length) return { error: text(`Unknown draft id(s): ${unknown.join(", ")}. Run action "list" to see the current ids.`, true) };
      return { drafts: ids.map((id) => drafts.find((d) => d.id === id)) };
    });
    if (picked.error) return picked.error;

    const sent = [];
    const failed = [];
    const sentIds = [];
    const stuck = [];
    for (const d of picked.drafts) {
      const body = { type: d.type, title: d.title, details: d.details, evidence: d.evidence, client: d.client };
      if (d.area) body.area = d.area;
      const res = await callEndpoint("/feedback", body, "POST");
      const out = res?.content?.[0]?.text ?? "";
      if (res?.isError) {
        failed.push(`${d.id}: ${out.slice(0, 300)}`);
        continue;
      }
      let serverId = null;
      try { serverId = JSON.parse(out).id ?? null; } catch { /* body was not JSON; keep null */ }
      sent.push(`${d.id} -> ${serverId ?? "sent"}`);
      sentIds.push(d.id);
      // Persist after EACH success, from a fresh read of the file, so a process
      // that dies mid-loop cannot re-send a report the server already holds. The
      // server already holds this report, so a lock that cannot be re-taken (a
      // foreign holder past the wait) must NOT become an error that hides the
      // server id and leaves the draft re-sendable: report it as posted and name
      // the draft to discard.
      try {
        await removeFromQueue(path, [d.id]);
      } catch (err) {
        stuck.push(`${d.id} (server id ${serverId ?? "unknown"}): ${err?.message || String(err)}`);
      }
    }
    const remaining = readQueue(path).length;
    const lines = [];
    if (sent.length) lines.push(`Sent ${sent.length} report(s) to redditapis.com (free, not metered):\n  ${sent.join("\n  ")}\nCheck one later with reddit_feedback_get using the server id.`);
    if (failed.length) lines.push(`${failed.length} draft(s) stayed in the queue because the send failed:\n  ${failed.join("\n  ")}`);
    if (stuck.length) lines.push(`${stuck.length} report(s) WERE posted but the local draft could not be removed (the queue was locked). Do not send these ids again; remove them with action "discard":\n  ${stuck.join("\n  ")}`);
    lines.push(`${remaining} draft(s) still pending.`);
    return text(lines.join("\n\n"), sent.length === 0);
  }

  async function run(action, args, path) {
    if (action === "draft") {
      if (!TYPES.includes(args.type)) return text(`type is required for a draft and must be one of ${TYPES.join(", ")}.`, true);
      const title = String(args.title ?? "").trim();
      if (!title || title.length > MAX.title) return text(`title is required for a draft, at most ${MAX.title} characters.`, true);
      const details = String(args.details ?? "").trim();
      if (!details || details.length > MAX.details) return text(`details is required for a draft, at most ${MAX.details} characters. Use the three labelled bullets: What happened, Repro, Evidence.`, true);
      const area = args.area ? String(args.area).trim().slice(0, MAX.area) : undefined;

      const client = clientString(getClientInfo?.(), version);
      const evidence = { ...(args.evidence && typeof args.evidence === "object" && !Array.isArray(args.evidence) ? args.evidence : {}) };
      const last = usableLastError(getLastError?.());
      // Fill only what the model did not supply: its own evidence wins.
      if (last) {
        if (evidence.tool === undefined && last.tool) evidence.tool = last.tool;
        if (evidence.endpoint === undefined && last.path) evidence.endpoint = last.path;
        if (evidence.status === undefined && last.status) evidence.status = last.status;
        if (evidence.request_id === undefined && last.requestId) evidence.request_id = last.requestId;
      }
      evidence.mcp_version = version;
      evidence.client = client;
      if (Buffer.byteLength(JSON.stringify(evidence), "utf8") > EVIDENCE_MAX_BYTES) {
        return text(`evidence must serialize to ${EVIDENCE_MAX_BYTES} bytes or fewer. Send identifiers (tool, endpoint, status, request id), never payloads.`, true);
      }

      const drafts = readQueue(path);
      const draft = { id: draftId(args.type, title), ts: new Date().toISOString(), type: args.type, title, details, area, evidence, client };
      const idx = drafts.findIndex((d) => d.id === draft.id);
      if (idx >= 0) {
        drafts[idx] = draft;
      } else {
        if (drafts.length >= QUEUE_CAP) {
          return text(`The local feedback queue already holds ${QUEUE_CAP} drafts. Ask the user to review them (action "list", then "send" or "discard") before drafting more.`, true);
        }
        drafts.push(draft);
      }
      writeQueue(path, drafts);
      return text(
        `Queued locally as draft ${draft.id}${idx >= 0 ? " (replaced an earlier draft with the same title)" : ""}. ${drafts.length} draft(s) pending in ${path}. ` +
          `Nothing was sent and nothing needs to be said to the user right now. When the user asks to review or send feedback, call this tool with action "list", ` +
          `then action "send" with only the ids the user names, or "discard".`,
      );
    }

    const drafts = readQueue(path);

    if (action === "list") {
      if (drafts.length === 0) return text(`No feedback drafts pending (${path}).`);
      return text(
        `${drafts.length} feedback draft(s) pending in ${path}. Show these to the user and send only the ids they name:\n\n` +
          drafts.map(summarize).join("\n"),
      );
    }

    const ids = [...new Set((Array.isArray(args.ids) ? args.ids : []).map(String))];
    if (ids.length === 0) return text(`action "${action}" needs ids: the draft ids the user named (from action "list").`, true);
    const unknown = ids.filter((id) => !drafts.some((d) => d.id === id));
    if (unknown.length) return text(`Unknown draft id(s): ${unknown.join(", ")}. Run action "list" to see the current ids.`, true);

    if (action === "discard") {
      const kept = drafts.filter((d) => !ids.includes(d.id));
      writeQueue(path, kept);
      return text(`Discarded ${ids.length} draft(s): ${ids.join(", ")}. ${kept.length} still pending.`);
    }

  }
}
