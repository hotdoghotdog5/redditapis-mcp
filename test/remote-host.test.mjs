// remote-host.test.mjs: what a remote MCP host needs from this package.
//   - `redditapis-mcp/server` resolves to createServer (the subpath export)
//   - authHeaders replace the API key: sent on every call, no Authorization, no
//     "missing key" paywall
//   - a read that lands in an API restart (the gateway's HTML 502/503/504, or a
//     refused connection) is retried; JSON errors, timeouts and writes are not
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

const { createServer } = await import("redditapis-mcp/server");
assert.equal(typeof createServer, "function");
ok("the ./server subpath export resolves to createServer");

const NGINX_502 = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body>\r\n</html>\r\n";

function seq(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.body };
  };
  return { fetchImpl, calls };
}
const sleeps = [];
const mk = (fetchImpl, extra = {}) =>
  createServer({ apiKey: "k", baseUrl: "https://api.test", fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); }, retryDelaysMs: [3, 8], ...extra });

{
  const { fetchImpl, calls } = seq([{ status: 200, body: "{}" }]);
  const s = mk(fetchImpl, { apiKey: undefined, authHeaders: { "x-internal-secret": "s", "x-internal-key-id": "kid" } });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls[0].headers["x-internal-key-id"], "kid");
  assert.equal(calls[0].headers.Authorization, undefined);
  ok("authHeaders are sent instead of the API key, and no missing-key paywall fires");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 502, body: NGINX_502 }, { status: 200, body: '{"posts":[]}' }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [3]);
  ok("a read that hits the gateway's HTML 502 is retried and returns the real answer");
}
{
  sleeps.length = 0;
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  const { fetchImpl, calls } = seq([refused, { status: 503, body: "<!DOCTYPE html><html>503</html>" }, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, undefined);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [3, 8]);
  ok("a refused connection then an HTML 503 are ridden out within two retries");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 502, body: NGINX_502 }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.equal(calls.length, 3);
  ok("retries are bounded: after two, the gateway error is reported as before");
}
{
  const { fetchImpl, calls } = seq([{ status: 502, body: '{"error":"Auth backend error"}' }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  ok("the API's own JSON 502 is never retried");
}
{
  const { fetchImpl, calls } = seq([{ status: 502, body: NGINX_502 }, { status: 200, body: "{}" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/submit", { subreddit: "test", title: "t" }, "POST");
  assert.equal(calls.length, 1);
  ok("a WRITE is never retried, even through a gateway 502");
}
{
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const { fetchImpl, calls } = seq([abort, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  assert.match(r.content[0].text, /timed out/);
  ok("a timeout is not retried");
}

{
  sleeps.length = 0;
  const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  const { fetchImpl, calls } = seq([dns, { status: 200, body: "{}" }]);
  const r = await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.match(r.content[0].text, /ENOTFOUND/);
  ok("a DNS failure is not retried (it cannot fix itself) and its code is reported");
}
{
  sleeps.length = 0;
  const r = await mk(fetch, { baseUrl: "http://127.0.0.1:59981" }).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.deepEqual(sleeps, [3, 8]);
  assert.match(r.content[0].text, /ECONNREFUSED/);
  ok("a REAL refused connection (closed local port) is retried twice, then reported with its code");
}
{
  sleeps.length = 0;
  const { fetchImpl, calls } = seq([{ status: 504, body: "<html>504 Gateway Time-out</html>" }]);
  await mk(fetchImpl).callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(calls.length, 1);
  ok("a gateway 504 is not retried (the app may already have done, and billed, the work)");
}

{
  // A REAL socket that answers 200 headers and then drops mid-body: the API has
  // already handled the request, so it must be sent exactly once.
  let hits = 0;
  const srv = createHttp((req, res) => { hits++; res.writeHead(200, { "content-length": "1000" }); res.write("{\"partial\":"); setTimeout(() => req.socket.destroy(), 20); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  sleeps.length = 0;
  const r = await mk(fetch, { baseUrl: `http://127.0.0.1:${srv.address().port}` }).callEndpoint("/api/reddit/search", { q: "x" });
  srv.close();
  assert.equal(hits, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(r.isError, true);
  ok("a response dropped mid-body is never re-sent (the API already handled it): exactly 1 hit");
}
{
  // Closed after the request arrived but before any headers: also possibly handled.
  let hits = 0;
  const srv = createHttp((req) => { hits++; setTimeout(() => req.socket.destroy(), 20); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  sleeps.length = 0;
  await mk(fetch, { baseUrl: `http://127.0.0.1:${srv.address().port}` }).callEndpoint("/api/reddit/search", { q: "x" });
  srv.close();
  assert.equal(hits, 1);
  ok("a socket closed after the request arrived is never re-sent: exactly 1 hit");
}

console.log(`\nremote-host: ${n} passed, 0 failed`);
