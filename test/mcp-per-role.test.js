/**
 * `mcp`: which MCP servers a role may load. Declared here, enforced by
 * whatever launches the agent's CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boxed } from "./_tmp.js";

import { loadConfig } from "../src/config.js";
import { explain } from "../src/owners.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { TOOLS } from "../src/mcp.js";
import { targetsOf, decide } from "../src/hook.js";

const BOX = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
function load(toml) {
  mkdirSync(BOX, { recursive: true });
  const dir = boxed("mcp-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return loadConfig(join(dir, "seisin.toml"));
}

const TOML =
  '[roles.qa]\nwrites = ["qa/**"]\nmcp = ["playwright", "playwright"]\n\n' +
  '[roles.gerente]\nwrites = ["docs/**"]\nmcp = []\n\n' +
  '[roles.otro]\nwrites = ["src/**"]\n';

test("absent is null, empty is none, and a repeat is one", () => {
  const cfg = load(TOML);
  assert.deepEqual(cfg.roles.qa.mcp, ["playwright"]);
  assert.deepEqual(cfg.roles.gerente.mcp, []);
  assert.equal(cfg.roles.otro.mcp, null, "a policy that never mentions MCP must not mean 'none'");
});

test("explain answers the three cases", () => {
  const cfg = load(TOML);
  assert.equal(explain(cfg, "qa", "mcp", "playwright").allowed, true);
  const no = explain(cfg, "qa", "mcp", "tradingview");
  assert.equal(no.allowed, false);
  assert.match(no.reason, /only playwright/);
  assert.equal(explain(cfg, "gerente", "mcp", "playwright").allowed, false);
  const open = explain(cfg, "otro", "mcp", "anything");
  assert.equal(open.allowed, true);
  assert.equal(open.declared, false);
});

test("a name that is not a server name refuses to load", () => {
  for (const bad of ['["play wright"]', '["../x"]', '[""]', "[8001]"])
    assert.throws(() => load(`[roles.qa]\nwrites = ["qa/**"]\nmcp = ${bad}\n`), /MCP server name|array of strings|expected a string/, bad);
});

test("check shows the list and knows the key", () => {
  const report = inspect(load(TOML));
  assert.ok(!report.warnings.some((w) => w.kind === "unknown-role-key"));
  const text = renderReport(report);
  assert.match(text, /mcp\s+playwright/);
  assert.match(text, /mcp\s+none/);
});

test("the MCP tool takes mcp as an action", () => {
  const t = TOOLS.find((x) => x.name === "seisin_explain");
  assert.ok(t.inputSchema.properties.action.enum.includes("mcp"));
});

// ── An MCP tool call is a resource, not a path ──
// Until 0.4 the hook returned nothing for `mcp__*`, so the call got no verdict,
// no owner and no line in the log — measured on 2026-09-24, the event reaches
// the hook, we just were not reading it. Now it resolves to its server and is
// answered by the same `mcp = [...]` the launcher already reads.

test("targetsOf resolves an mcp tool call to its server, and a bad name to none", () => {
  assert.deepEqual(targetsOf("mcp__supabase__execute_sql", { query: "select 1" }),
    [{ action: "use", tool: "mcp__supabase__execute_sql", server: "supabase" }]);
  // Server names carry single underscores; the split is on the double.
  assert.deepEqual(targetsOf("mcp__claude_ai_Gmail__get_thread", {}),
    [{ action: "use", tool: "mcp__claude_ai_Gmail__get_thread", server: "claude_ai_Gmail" }]);
  // Unparsable: no second `__`. Returned as an unknown tool, not dropped.
  assert.deepEqual(targetsOf("mcp__weird", {}), [{ action: "use", tool: "mcp__weird", server: null }]);
});

const evt = (name, input = {}) => ({ tool_name: name, tool_input: input });

test("a call to a declared server is allowed and logged, and nothing is queued", () => {
  const cfg = load(TOML); // qa: mcp = ["playwright"]
  const seen = [];
  let queued = 0;
  const out = decide(cfg, "qa", evt("mcp__playwright__browser_click", { ref: "x" }),
    { now: (_f, e) => seen.push(e), ask: () => (queued++, true) });
  assert.equal(out.decision, null, "an allowed call is not denied");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].verdict, "allowed");
  assert.equal(seen[0].kind, "tool");
  assert.equal(seen[0].target, "mcp__playwright__browser_click");
  assert.equal(queued, 0, "an allowed call queues nothing");
});

test("a call to a server outside the list is denied, explained, and never queued", () => {
  const cfg = load(TOML); // qa: mcp = ["playwright"]
  const seen = [];
  let queued = 0;
  const out = decide(cfg, "qa", evt("mcp__tradingview__quote_get", { symbol: "XAUUSD" }),
    { now: (_f, e) => seen.push(e), ask: () => (queued++, true) });
  assert.equal(out.decision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /only playwright/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /mcp list/);
  assert.equal(seen[0].verdict, "denied");
  assert.equal(queued, 0, "an mcp denial is a policy change, not a grantable request");
});

test("an unparsable mcp tool name is closed, not waved through", () => {
  const cfg = load(TOML);
  const seen = [];
  const out = decide(cfg, "otro", evt("mcp__weird", {}), // otro has no mcp list
    { now: (_f, e) => seen.push(e), ask: () => true });
  assert.equal(out.decision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /not a recognisable/);
  assert.equal(seen[0].verdict, "denied");
});

test("a role with no mcp list is not limited, but the call is still recorded", () => {
  const cfg = load(TOML); // otro: no mcp key at all
  const seen = [];
  const out = decide(cfg, "otro", evt("mcp__anything__do", {}),
    { now: (_f, e) => seen.push(e), ask: () => true });
  assert.equal(out.decision, null);
  assert.equal(seen[0].verdict, "allowed");
  assert.equal(seen[0].kind, "tool");
});

test("observe records the mcp call and returns no decision", () => {
  const cfg = load(TOML);
  const seen = [];
  const out = decide(cfg, "qa", evt("mcp__tradingview__quote_get", {}),
    { observe: true, now: (_f, e) => seen.push(e), ask: () => true });
  assert.equal(out.decision, null);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(seen[0].verdict, "observed");
});
