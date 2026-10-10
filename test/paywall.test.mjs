// paywall.test.mjs: a missing key, a rejected key and an empty balance come back
// as an agent-actionable payload (needs + the exact page to send the user to),
// in the text every client reads AND as structuredContent. Every fake response
// below is the SHAPE the live API sends (apps/api/src/middleware/auth.js and
// lib/monitor-handlers.js, read 2026-09-29): a bad key is 403 {"error":"Invalid
// token"}, an empty balance is 402 {"error":"Insufficient credits",top_up_url},
// and a monitor plan limit is ALSO 402 but must not be sold as "buy credits".
import assert from "node:assert/strict";
import { createServer, paywallFor, classifyPaywall, SIGNUP_URL, TOP_UP_URL, API_KEYS_URL } from "../src/server.js";

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };

function fakeFetch(status, body = "{}") {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  });
}
const call = (status, body) =>
  createServer({ apiKey: "k", baseUrl: "https://api.test", fetchImpl: fakeFetch(status, body) })
    .callEndpoint("/api/reddit/search", { q: "x" });
const payloadOf = (r) => JSON.parse(r.content[0].text.split("\n\n").pop());

// No key at all: an account is what is needed, and the text still names the key.
{
  const s = createServer({ apiKey: undefined, baseUrl: "https://api.test", fetchImpl: fakeFetch(200) });
  const r = await s.callEndpoint("/api/reddit/search", { q: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Missing REDDITAPIS_KEY/);
  assert.equal(r.structuredContent.needs, "account");
  assert.equal(r.structuredContent.action_url, SIGNUP_URL);
  assert.deepEqual(payloadOf(r), r.structuredContent);
  ok("no key: needs=account, signup URL, same payload in text and structuredContent");
}

// The live bad-key response: 403 {"error":"Invalid token"}.
{
  const r = await call(403, '{"error":"Invalid token"}');
  assert.equal(r.structuredContent.needs, "valid_key");
  assert.equal(r.structuredContent.action_url, API_KEYS_URL);
  assert.match(API_KEYS_URL, /\/dashboard\/api-keys\?/);
  ok("403 Invalid token (the real bad-key shape): needs=valid_key, API keys page");
}

// The live empty-balance response, with the API's own top_up_url preferred.
{
  const own = "https://www.redditapis.com/dashboard/buy-credits?from=api";
  const r = await call(402, JSON.stringify({ error: "Insufficient credits", top_up_url: own, message: "Out of credits." }));
  assert.equal(r.structuredContent.needs, "credits");
  assert.equal(r.structuredContent.action_url, own);
  assert.match(r.content[0].text, /out of credits/);
  ok("402 Insufficient credits: needs=credits, the API's own top_up_url");
}
{
  const r = await call(402, '{"error":"Insufficient credits"}');
  assert.equal(r.structuredContent.action_url, TOP_UP_URL);
  ok("402 Insufficient credits without a top_up_url: falls back to the buy-credits page");
}
{
  const r = await call(402, JSON.stringify({ error: "Insufficient credits", top_up_url: "https://evil.example/pay" }));
  assert.equal(r.structuredContent.action_url, TOP_UP_URL);
  ok("a top_up_url off www.redditapis.com is never relayed");
}

// NEGATIVE: a monitor plan / slot limit is a 402 too, and is NOT a credits problem.
for (const body of ['{"error":"subscription_required"}', '{"error":"monitor_slots_exhausted"}']) {
  const r = await call(402, body);
  assert.equal(r.structuredContent, undefined, body);
  assert.match(r.content[0].text, /^HTTP 402/);
  assert.doesNotMatch(r.content[0].text, /out of credits/);
}
ok("402 subscription_required / monitor_slots_exhausted: no credits paywall, ordinary text kept");

// NEGATIVE: a 403 that is NOT a bad key (a private or banned subreddit) keeps its hint.
{
  const r = await call(403, '{"error":"SUBREDDIT_PRIVATE"}');
  assert.equal(r.structuredContent, undefined);
  assert.match(r.content[0].text, /^HTTP 403/);
  ok("403 for a private subreddit: not a key problem, ordinary hint kept");
}

// CONTROL: a 500 is not a paywall, and a non-JSON body never throws.
{
  const r = await call(500, "<html>oops</html>");
  assert.equal(r.structuredContent, undefined);
  assert.match(r.content[0].text, /^HTTP 500/);
  assert.equal(classifyPaywall(500, "<html>"), null);
  assert.equal(paywallFor("nope"), null);
  ok("control: a 500 and a non-JSON body carry no paywall payload");
}

for (const u of [SIGNUP_URL, TOP_UP_URL, API_KEYS_URL]) assert.match(u, /^https:\/\/www\.redditapis\.com\//);
ok("every paywall URL is https on www.redditapis.com");

console.log(`\npaywall: ${n} passed, 0 failed`);
