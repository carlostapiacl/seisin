/**
 * `mcp`: which MCP servers a role may load. Declared here, enforced by
 * whatever launches the agent's CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { explain } from "../src/owners.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { TOOLS } from "../src/mcp.js";

const BOX = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
function load(toml) {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "mcp-"));
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
