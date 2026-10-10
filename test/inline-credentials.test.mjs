// inline-credentials.test.mjs: createServer({ inlineCredentials: false }) lists
// no tool that takes the caller's Reddit cookies, and the default still does.
//
// WHY: a remote host serves this catalog to connected apps it has already
// signed in another way. A tool whose input is the caller's own Reddit session
// would ask that app to pipe a Reddit cookie through the host, so the host
// builds the server with inlineCredentials:false and those tools are not
// registered. Local stdio users keep every tool (the default is true).
//
// Read the way a client reads it: tools/list over an in-memory MCP client, so
// a tool hidden only from TOOLS but still registered, or the reverse, fails.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, INSTRUCTIONS } from "../src/server.js";
import { auditCatalog } from "./description-compliance.test.mjs";

let n = 0;
const ok = (m) => console.log(`ok ${++n} - ${m}`);

// LITERAL, not imported from the code under test: the cookie and session
// argument names a credential-taking tool carries, and the five tools known to
// take them. If the catalog grows a sixth, this list is updated on purpose.
const CREDENTIAL_INPUTS = new Set([
  "reddit_session", "loid", "token_v2", "csrf_token", "edgebucket", "csv",
  "session_tracker", "pc", "proxy",
]);
const EXPECTED_HIDDEN = [
  "reddit_home_feed",
  "reddit_user_gilded",
  "reddit_user_hidden",
  "reddit_user_saved",
  "reddit_user_upvoted",
];

async function connect(opts) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
  };
  const { server } = createServer({ apiKey: "k", baseUrl: "https://api.test", feedbackEnv: {}, fetchImpl, ...opts });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "inline-credentials-test", version: "1" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  return { client, tools, instructions: client.getInstructions(), calls };
}

const credentialInputs = (t) => Object.keys(t.inputSchema?.properties || {}).filter((k) => CREDENTIAL_INPUTS.has(k));
const toolTokens = (text) => [...new Set([...text.matchAll(/\breddit_[a-z0-9_]+\b/g)].map((m) => m[0]))];

// 1. POSITIVE CONTROL: the default keeps every tool, the five included. Without
// this a matcher that sees no credential input anywhere would pass step 2.
const full = await connect({});
const fullWithCreds = full.tools.filter((t) => credentialInputs(t).length).map((t) => t.name).sort();
assert.ok(full.tools.length >= 44, `default listed only ${full.tools.length} tools`);
assert.deepEqual(fullWithCreds, EXPECTED_HIDDEN, `default must list the five credential-taking tools, listed ${JSON.stringify(fullWithCreds)}`);
assert.equal(full.instructions, INSTRUCTIONS, "the default server must send the default instructions");
ok(`default lists ${full.tools.length} tools, ${fullWithCreds.length} of them taking Reddit cookies`);

// 2. THE POINT: inlineCredentials:false lists ZERO tools with a credential input.
const hosted = await connect({ inlineCredentials: false });
const hostedWithCreds = hosted.tools.filter((t) => credentialInputs(t).length).map((t) => t.name);
assert.deepEqual(hostedWithCreds, [], `inlineCredentials:false still lists credential-taking tools: ${hostedWithCreds.join(", ")}`);
const hiddenNames = full.tools.map((t) => t.name).filter((name) => !hosted.tools.some((t) => t.name === name)).sort();
assert.deepEqual(hiddenNames, EXPECTED_HIDDEN, `exactly the five credential-taking tools are hidden, got ${JSON.stringify(hiddenNames)}`);
assert.equal(hosted.tools.length, full.tools.length - EXPECTED_HIDDEN.length);
ok(`inlineCredentials:false lists ${hosted.tools.length} tools and hides exactly ${hiddenNames.join(", ")}`);

// 3. Instructions point only at tools the client can see, in both modes.
for (const [mode, s] of [["default", full], ["inlineCredentials:false", hosted]]) {
  const listed = new Set(s.tools.map((t) => t.name));
  const unknown = toolTokens(s.instructions).filter((tok) => !listed.has(tok) && !CREDENTIAL_INPUTS.has(tok));
  assert.deepEqual(unknown, [], `${mode}: instructions name tools the client cannot see: ${unknown.join(", ")}`);
}
assert.doesNotMatch(hosted.instructions, /reddit_home_feed|reddit_user_(upvoted|saved|hidden|gilded)|reddit_session|POST \/api\/reddit\/login/,
  "inlineCredentials:false instructions must not point at the hidden tools or the Reddit login step");
assert.ok(hosted.instructions.length <= 2048, `hosted instructions are ${hosted.instructions.length} chars`);
ok("instructions name only listed tools in both modes, and the hosted text drops the session sentence");

// 4. A hidden tool cannot be called either, and the call never reaches the API.
const r = await hosted.client.callTool({ name: "reddit_home_feed", arguments: { reddit_session: "S", loid: "L" } }).catch((e) => ({ thrown: e }));
assert.ok(r.thrown || r.isError, `calling a hidden tool must fail, got ${JSON.stringify(r).slice(0, 200)}`);
assert.equal(hosted.calls.length, 0, "a call to a hidden tool must never reach the API");
ok("a call to a hidden tool fails and sends nothing upstream");

// 5. The hosted catalog passes the same description gate as the full one.
const { findings } = auditCatalog(hosted.tools);
assert.deepEqual(findings, [], `hosted catalog description findings: ${JSON.stringify(findings).slice(0, 300)}`);
ok("the hosted catalog passes the description-compliance checks");

// 6. Only a real boolean is accepted: a string "false" from an environment
// variable must throw rather than silently leave the cookie tools exposed.
for (const bad of ["false", 0, null, "no"]) {
  assert.throws(() => createServer({ apiKey: "k", inlineCredentials: bad }), TypeError,
    `inlineCredentials=${JSON.stringify(bad)} must throw`);
}
ok("a non-boolean inlineCredentials throws instead of exposing the cookie tools");

// 7. Every tool path is fillable by buildPath: no Express-style ':param'
// (reddit_post_visibility shipped '/post/:id/visibility' and 400'd on every call).
const { TOOLS } = await import("../src/tools.js");
const unfillable = TOOLS.filter((t) => /\/:[A-Za-z_]/.test(String(t.path || ""))).map((t) => `${t.name} ${t.path}`);
assert.deepEqual(unfillable, [], `tool paths with an unfillable :param: ${unfillable.join(", ")}`);
ok(`all ${TOOLS.length} tool paths use {param} placeholders buildPath can fill`);

await full.client.close();
await hosted.client.close();
console.log(`\ninline-credentials: ${n} passed, 0 failed`);
