/**
 * One path question, three surfaces, one answer.
 *
 * Turning a caller's path into the repo-relative path the policy is written in
 * was copied into four places and missing from a fifth: `seisin_explain` over
 * MCP answered "has no owner" for an absolute path the CLI called allowed —
 * the same defect decisions.md records as closed, closed in one surface only.
 * None of the copies resolved symlinks either, so a path spelled through one
 * (on macOS, `/var/folders/…` is `/private/var/folders/…`) was refused by the
 * sentence while the kernel, which sees the real path, allowed it. Found by the
 * read-only review of 2026-09-22. Now every surface asks `toRepoRelative`, and
 * this runs the same cases through all three.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { explainCommand } from "../src/commands/explain.js";
import { HANDLERS } from "../src/mcp.js";
import { decide } from "../src/hook.js";
import { toRepoRelative } from "../src/paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function repo(parent) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "surf-"));
  writeFileSync(join(dir, "seisin.toml"), '[roles.api]\nwrites = ["src/api/**"]\n\n[roles.web]\nwrites = ["src/web/**"]\n');
  return dir;
}

/** The same question to the CLI, the MCP server and the hook. */
function ask(dir, role, target) {
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const cli = explainCommand(cfg, [role, "write", target]).allowed;
  const cwd = process.cwd();
  process.chdir(dir);
  let mcp;
  try { mcp = HANDLERS.seisin_explain({ role, action: "write", target }).allowed; }
  finally { process.chdir(cwd); }
  const hook = decide(cfg, role, { tool_name: "Write", tool_input: { file_path: target, content: "" } },
    { now: () => {}, ask: () => {} }).decision !== "deny";
  return { cli, mcp, hook };
}

test("an absolute path gets the same answer from the CLI, MCP and the hook", () => {
  const dir = repo(join(HERE, ".sandbox-box"));
  assert.deepEqual(ask(dir, "api", join(dir, "src/api/x.ts")), { cli: true, mcp: true, hook: true });
  assert.deepEqual(ask(dir, "web", join(dir, "src/api/x.ts")), { cli: false, mcp: false, hook: false });
});

test("a path spelled through a symlink is the same path", () => {
  // tmpdir() on macOS is /var/folders/…, a link to /private/var/folders/….
  const dir = repo(tmpdir());
  const real = realpathSync(dir);
  const via = real === dir ? dir : real;          // the other spelling, where there is one
  assert.deepEqual(ask(dir, "api", join(via, "src/api/x.ts")), { cli: true, mcp: true, hook: true });
  assert.equal(toRepoRelative(loadConfig(join(dir, "seisin.toml")), join(via, "src/api/x.ts")), "src/api/x.ts");
});

test("a path outside the repo is left as written, and owns nothing", () => {
  const dir = repo(join(HERE, ".sandbox-box"));
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(toRepoRelative(cfg, "/etc/hosts"), "/etc/hosts");
  assert.equal(toRepoRelative(cfg, "src/api/x.ts"), "src/api/x.ts");
});
