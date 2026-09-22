/**
 * `never_writes`: a per-role subtraction from `writes`.
 *
 * The case it exists for is a role granted a whole repo that works in a
 * worktree, and so has no use for the canonical `.git/index.lock` — a glob
 * cannot say "the repo minus that file". These tests hold the four promises
 * the key was specified with: absent changes nothing, it beats any `writes`,
 * a refusal names it (and queues nothing), and `check` catches the spellings
 * that would otherwise subtract nothing in silence.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { explain, ownersOf } from "../src/owners.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { settingsFor } from "../src/srt.js";
import { resolveSrt } from "../src/commands/run.js";
import { decide } from "../src/hook.js";
import { pending } from "../src/requests.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
// Outside the system temp dir for the same reason sandbox.test.js is: scratch
// is writable by every role, so a repo there passes "cannot write" by accident.
const BOX = join(HERE, ".sandbox-box");

function repoWith(toml) {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "never-"));
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

const WORKTREE_ROLE =
  '[roles.dev]\nwrites = ["app/**"]\nnever_writes = ["app/.git/index.lock"]\n\n' +
  '[roles.lead]\nwrites = ["app/**"]\n';

test("absent means exactly what it meant before the key existed", () => {
  const dir = repoWith('[roles.dev]\nwrites = ["app/**"]\n');
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.deepEqual(cfg.roles.dev.neverWrites, []);
  assert.equal(explain(cfg, "dev", "write", "app/.git/index.lock").allowed, true);
  const report = inspect(cfg);
  assert.ok(!report.warnings.some((w) => /never|unknown-role-key/.test(w.kind)),
    "check has to be silent about a key nobody wrote");
});

test("it beats writes, and only for the role that wrote it", () => {
  const cfg = loadConfig(join(repoWith(WORKTREE_ROLE), "seisin.toml"));
  const v = explain(cfg, "dev", "write", "app/.git/index.lock");
  assert.equal(v.allowed, false);
  assert.equal(v.neverWrites, "app/.git/index.lock");
  assert.match(v.reason, /denied by never_writes of dev/);
  // The rest of the territory is untouched.
  assert.equal(explain(cfg, "dev", "write", "app/src/main.ts").allowed, true);
  // And the other role keeps the file: a subtraction is per role, never global.
  assert.equal(explain(cfg, "lead", "write", "app/.git/index.lock").allowed, true);
  assert.deepEqual(ownersOf(cfg, "app/.git/index.lock"), ["lead"]);
});

test("a subtree subtraction covers what is under it", () => {
  const cfg = loadConfig(join(repoWith(
    '[roles.dev]\nwrites = ["app/**"]\nnever_writes = ["app/.git/**"]\n'), "seisin.toml"));
  assert.equal(explain(cfg, "dev", "write", "app/.git/refs/heads/main").allowed, false);
  assert.equal(explain(cfg, "dev", "write", "app/README.md").allowed, true);
});

test("the kernel profile denies it, on top of the grant", () => {
  const dir = repoWith(WORKTREE_ROLE);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const fs = settingsFor(cfg, "dev").filesystem;
  assert.ok(fs.allowWrite.includes(join(dir, "app")));
  assert.ok(fs.denyWrite.includes(join(dir, "app/.git/index.lock")));
  assert.ok(!settingsFor(cfg, "lead").filesystem.denyWrite.includes(join(dir, "app/.git/index.lock")));
});

test("a refusal by never_writes queues no request", () => {
  const dir = repoWith(WORKTREE_ROLE);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const out = decide(cfg, "dev", {
    tool_name: "Write", tool_input: { file_path: join(dir, "app/.git/index.lock"), content: "" },
  });
  assert.equal(out.decision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /never_writes of dev/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /nothing was queued/);
  assert.equal(pending(join(dir, ".seisin", "requests.jsonl")).length, 0,
    "approving a request for this would undo the subtraction without anyone deciding to");
});

test("check lists it in the role's summary", () => {
  const cfg = loadConfig(join(repoWith(WORKTREE_ROLE), "seisin.toml"));
  const report = inspect(cfg);
  assert.deepEqual(report.roles.find((r) => r.name === "dev").neverWrites, ["app/.git/index.lock"]);
  assert.match(renderReport(report), /never.*app\/\.git\/index\.lock/);
});

for (const typo of ["never_write", "no_writes", "denyWrite", "deny_write"]) {
  test(`check names "${typo}" instead of ignoring it`, () => {
    const cfg = loadConfig(join(repoWith(
      `[roles.dev]\nwrites = ["app/**"]\n${typo} = ["app/.git/index.lock"]\n`), "seisin.toml"));
    // Ignored by the loader — it is not the key — and so still writable...
    assert.equal(explain(cfg, "dev", "write", "app/.git/index.lock").allowed, true);
    // ...which is exactly why check has to say so.
    const w = inspect(cfg).warnings.find((x) => x.kind === "unknown-role-key");
    assert.ok(w, `no warning for ${typo}`);
    assert.match(w.headline, new RegExp(`"${typo}"`));
    assert.match(w.headline, /Did you mean "never_writes"\?/);
  });
}

test("check names an entry that subtracts from nothing", () => {
  const cfg = loadConfig(join(repoWith(
    '[roles.dev]\nwrites = ["app/**"]\nnever_writes = ["other/.git/index.lock"]\n'), "seisin.toml"));
  const w = inspect(cfg).warnings.find((x) => x.kind === "never-writes-subtracts-nothing");
  assert.ok(w);
  assert.match(w.headline, /other\/\.git\/index\.lock/);
});

for (const [bad, why] of [["/etc/passwd", /absolute/], ["app/../x", /\.\./], ["", /non-empty string/]]) {
  test(`a malformed entry refuses to load: ${JSON.stringify(bad)}`, () => {
    const dir = repoWith(`[roles.dev]\nwrites = ["app/**"]\nnever_writes = ["${bad}"]\n`);
    assert.throws(() => loadConfig(join(dir, "seisin.toml")), why);
  });
}

// End to end: the one test that can tell the subtraction actually lands.
const skip = resolveSrt() !== null ? false : "sandbox runtime not installed";

test("the real sandbox refuses the write, and the rest of the territory still works", { skip }, () => {
  const dir = repoWith(WORKTREE_ROLE);
  mkdirSync(join(dir, "app", ".git"), { recursive: true });
  const as = (role, line) => spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line],
    { cwd: dir, encoding: "utf8" }).status === 0;
  assert.ok(as("dev", "echo x > app/ok.txt"), "the territory must still be writable");
  assert.ok(!as("dev", "echo x > app/.git/index.lock"), "never_writes did not reach the kernel");
  assert.ok(!existsSync(join(dir, "app", ".git", "index.lock")));
  assert.ok(as("lead", "echo x > app/.git/index.lock"), "the other role lost the file too");
});

test("a grant that never_writes would cancel is refused, not written", async () => {
  const { refuseIfBarred } = await import("../src/requests.js");
  const cfg = loadConfig(join(repoWith(WORKTREE_ROLE), "seisin.toml"));
  assert.throws(
    () => refuseIfBarred(cfg, { role: "dev", action: "write", target: "app/.git/index.lock" }),
    /never_writes of dev.*Granting it would change nothing/);
  // Anything else goes through as before.
  assert.doesNotThrow(() => refuseIfBarred(cfg, { role: "dev", action: "write", target: "docs/x.md" }));
  assert.doesNotThrow(() => refuseIfBarred(cfg, { role: "lead", action: "write", target: "app/.git/index.lock" }));
});
