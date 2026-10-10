#!/usr/bin/env node
// per-caller-state.test.mjs: two servers built by createServer() never
// share a key or a failure record.
//
// Once the server is hosted remotely, one process serves many callers. The key
// and the last failed call used to be module globals, so caller B's request
// would have gone out with whichever key was loaded, and B's feedback draft
// could carry A's failing endpoint and request id. This builds two servers in
// one process with different keys and a fake fetch, and asserts each call
// carries its own key and each server reports only its own failure.

import { createServer } from "../src/server.js";

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  ok " : "  FAIL"} ${msg}`);
  if (!ok) failed += 1;
};

const seen = [];
function fakeFetch(status, requestId) {
  return async (url, init) => {
    seen.push({ url, key: init.headers["x-api-key"], auth: init.headers.Authorization });
    return {
      ok: status < 400,
      status,
      text: async () => (status < 400 ? "{}" : "{\"error\":\"x\"}"),
      headers: { get: (h) => (h === "x-request-id" ? requestId : null) },
    };
  };
}

const a = createServer({ apiKey: "key-A", baseUrl: "https://api.test", fetchImpl: fakeFetch(500, "req-A") });
const b = createServer({ apiKey: "key-B", baseUrl: "https://api.test", fetchImpl: fakeFetch(200, "req-B") });

await a.callEndpoint("/api/reddit/user/one", { username: "one" });
await b.callEndpoint("/api/reddit/user/one", { username: "two" });

check(seen.length === 2, `two requests made (got ${seen.length})`);
check(seen[0]?.auth === "Bearer key-A", "server A sent key A");
check(seen[1]?.auth === "Bearer key-B", "server B sent key B, not A");
check(a.getLastError()?.requestId === "req-A", "server A recorded its own failure");
check(b.getLastError() === null, "server B has no failure record, A's did not leak into it");

// A later failure on B must not touch A's record either.
const b2 = createServer({ apiKey: "key-B", baseUrl: "https://api.test", fetchImpl: fakeFetch(502, "req-B2") });
await b2.callEndpoint("/api/reddit/user/one", { username: "three" });
check(a.getLastError()?.requestId === "req-A", "server A's record unchanged by another server's failure");
check(b2.getLastError()?.requestId === "req-B2", "server B2 recorded its own failure");

// No key: a clear per-call error, never another caller's key.
const none = createServer({ apiKey: undefined, baseUrl: "https://api.test", fetchImpl: fakeFetch(200, "x") });
const before = seen.length;
const r = await none.callEndpoint("/api/reddit/user/one", { username: "four" });
check(r.isError && /Missing REDDITAPIS_KEY/.test(r.content[0].text), "keyless server fails the call clearly");
check(seen.length === before, "keyless server made no request");

if (failed) {
  console.error(`\x1b[31m✗ per-caller-state: ${failed} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m✓ per-caller-state: keys and failure records stay per server\x1b[0m");
