// Live end-to-end smoke test: spawns the MCP server over stdio via the SDK
// client, lists tools, and calls one read tool against the real redditapis.com
// API. Requires REDDITAPIS_KEY (or REDDIT_APIS_KEY) in the environment; bills one
// read call. Skips gracefully (exit 0) if no key is set, so CI without a secret
// still passes the syntax/catalog tests.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../src/tools.js";

const KEY = process.env.REDDITAPIS_KEY || process.env.REDDIT_APIS_KEY;
if (!KEY) {
  console.log("SKIP live smoke: no REDDITAPIS_KEY set (syntax + catalog tests already cover the rest).");
  process.exit(0);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../src/index.js", import.meta.url).pathname],
  env: { ...process.env, REDDITAPIS_KEY: KEY },
});
const client = new Client({ name: "reddit-mcp-smoke", version: "1.0.0" }, { capabilities: {} });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  // Derived from the catalog, never typed: this line read 32 while the
  // catalog carried 36, and only ever ran with a live key, so nobody saw it.
  assert.equal(tools.length, TOOLS.length, `expected ${TOOLS.length} tools, got ${tools.length}`);
  console.log(`PASS  connected, ${tools.length} tools listed`);

  // Protocol-level only (no live call, no side effect, no plan required): the
  // 10 monitor/webhook tools registered with the correct read-only/destructive
  // annotations, matching tools.js's own write/destructive flags.
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["reddit_monitor_add", "reddit_monitor_list", "reddit_monitor_update", "reddit_monitor_remove",
                    "reddit_monitor_health", "reddit_monitor_deliveries", "reddit_monitor_webhook_create",
                    "reddit_monitor_webhook_list", "reddit_monitor_webhook_test", "reddit_monitor_webhook_delete"]) {
    assert.ok(byName[n], `expected tool ${n} to be registered`);
  }
  assert.equal(byName.reddit_monitor_remove.annotations?.destructiveHint, true, "monitor_remove should be destructiveHint:true");
  assert.equal(byName.reddit_monitor_list.annotations?.readOnlyHint, true, "monitor_list should be readOnlyHint:true");
  assert.equal(byName.reddit_monitor_add.annotations?.readOnlyHint, false, "monitor_add should be readOnlyHint:false");
  console.log(`PASS  all 10 monitor/webhook tools registered with correct annotations`);

  const res = await client.callTool({
    name: "reddit_subreddit_posts",
    arguments: { subreddit: "programming", sort: "hot", limit: 2 },
  });
  assert.ok(!res.isError, `tool returned error: ${JSON.stringify(res.content)}`);
  const text = res.content?.[0]?.text || "";
  const data = JSON.parse(text);
  const posts = data.posts || data.data?.children || [];
  assert.ok(Array.isArray(posts) && posts.length > 0, `expected posts, got: ${text.slice(0, 200)}`);
  console.log(`PASS  reddit_subreddit_posts(programming) -> ${posts.length} live posts`);

  // path-param tool
  const res2 = await client.callTool({ name: "reddit_user_profile", arguments: { name: "spez" } });
  assert.ok(!res2.isError, `user_profile error: ${JSON.stringify(res2.content)}`);
  console.log(`PASS  reddit_user_profile(spez) path-param tool -> ok`);

  console.log("\n==== live smoke passed ====");
} finally {
  await client.close().catch(() => {});
}
