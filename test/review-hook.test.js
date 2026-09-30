/**
 * The hook and the run, held to what the 2026-09-30 code review found.
 *
 * Each test names the finding it fixes. Most go through the CLI, because the
 * contract that broke was the process's — its exit code and how long it took —
 * and a unit test of the function behind it would have passed all along.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratch } from "./_tmp.js";

import { targetsOf, TOOL_MATCHER } from "../src/hook.js";
import { loadConfig } from "../src/config.js";
import { wire, wired } from "../src/commands/wire.js";
import { afterTool } from "../src/diagnose.js";
import { logPath } from "../src/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const TOML = '[roles.web]\nwrites = ["src/web/**"]\n\n[roles.api]\nwrites = ["src/api/**"]\n';

/** A policy in a temp dir, and the environment a hook inside `seisin run` sees. */
function policy(toml = TOML) {
  const dir = scratch("seisin-rh-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return {
    dir,
    env: {
      ...process.env,
      SEISIN_ROLE: "web",
      SEISIN_CONFIG: join(dir, "seisin.toml"),
      // A socket nobody listens on: the entries are lost, the hook must not care.
      SEISIN_SPOOL: join(dir, "nobody-here.sock"),
    },
  };
}

function hook(env, event) {
  return spawnSync(process.execPath, [CLI, "hook"], { input: JSON.stringify(event), env, encoding: "utf8" });
}

/* ── P0-1: the hook fails open ─────────────────────────────────────────── */

test("a malformed PreToolUse event exits 0 with no decision (review P0-1)", () => {
  const { env } = policy();
  for (const tool_input of [null, { file_path: 123 }, "a string", { file_path: ["src/api/x.ts"] }]) {
    const r = hook(env, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input });
    assert.equal(r.status, 0, `exit ${r.status} for ${JSON.stringify(tool_input)} — Claude Code would block the tool\n${r.stderr}`);
    assert.equal(r.stdout, "", "no decision on a malformed event");
  }
  const bash = hook(env, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: null });
  assert.equal(bash.status, 0, bash.stderr);
});

test("targetsOf treats a non-object input as empty and ignores non-string paths", () => {
  assert.deepEqual(targetsOf("Write", null), []);
  assert.deepEqual(targetsOf("Edit", { file_path: 123 }), []);
  assert.deepEqual(targetsOf("Read", "src/x"), []);
  assert.deepEqual(targetsOf("Bash", null), []);
  assert.deepEqual(targetsOf("Write", { file_path: "src/a.ts" }), [{ action: "write", path: "src/a.ts" }]);
});

test("a well-formed denial still comes back as a decision through the CLI", () => {
  const { env } = policy();
  const r = hook(env, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/api/x.ts" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

/* ── P1-9: the PreToolUse matcher ──────────────────────────────────────── */

test("wire installs PreToolUse for the tools the hook reads, not for every tool (review P1-9)", () => {
  const { dir } = policy();
  wire(loadConfig(join(dir, "seisin.toml")));
  const pre = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].matcher, TOOL_MATCHER);
  const m = new RegExp(pre[0].matcher);
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "NotebookRead", "Bash", "mcp__supabase__execute_sql"])
    assert.ok(m.test(t), `${t} must reach the hook`);
  for (const t of ["Grep", "Glob", "TodoWrite", "BashOutput", "WebFetch"])
    assert.ok(!m.test(t), `${t} starts a Node process for nothing`);
  // Every tool the matcher lets through is one targetsOf can answer for.
  assert.deepEqual(targetsOf("Grep", { pattern: "x", path: "src" }), []);
  assert.deepEqual(targetsOf("TodoWrite", { todos: [] }), []);
  assert.ok(wired(dir));
});

test("an install with the old '*' matcher is still wired, and wire narrows it in place", () => {
  const { dir } = policy();
  wire(loadConfig(join(dir, "seisin.toml")));
  const file = join(dir, ".claude", "settings.json");
  const old = JSON.parse(readFileSync(file, "utf8"));
  old.hooks.PreToolUse[0].matcher = "*";
  // Somebody else's catch-all beside ours is theirs, and stays as it was.
  old.hooks.PreToolUse.push({ matcher: "*", hooks: [{ type: "command", command: "mine --audit" }] });
  writeFileSync(file, JSON.stringify(old));

  assert.ok(wired(dir), "an old install must not be told it is unwired");
  assert.equal(wire(loadConfig(join(dir, "seisin.toml"))).changed, true);
  const pre = JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse;
  assert.equal(pre.length, 2, "narrowing must not add an entry");
  assert.equal(pre[0].matcher, TOOL_MATCHER);
  assert.equal(pre[1].matcher, "*", "another tool's hook was narrowed");
  assert.equal(wire(loadConfig(join(dir, "seisin.toml"))).changed, false, "a second wire has nothing to do");
});

/* ── P1-11: PostToolUse on a successful Bash does not wait ─────────────── */

/** A kernel refusal of `target` for `role`, as the parent writes it. */
function kernelLine(dir, role, target) {
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  appendFileSync(logPath(dir), JSON.stringify({
    at: new Date().toISOString(), role, tool: "kernel", source: "kernel",
    action: "write", kind: "file", target, verdict: "denied", owners: [], reason: "file-write-create",
  }) + "\n");
}

test("a successful Bash that prints 'Permission denied' costs no waits and says nothing (review P1-11)", async () => {
  const { dir } = policy();
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const file = logPath(dir);
  // The default schedule, on purpose: that is what a real hook pays.
  const quiet = { hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_response: { stdout: "grep: /etc/x: Permission denied\n", stderr: "", interrupted: false } };
  let t = performance.now();
  assert.equal(await afterTool(cfg, "web", quiet, { file }), null);
  assert.ok(performance.now() - t < 90, `took ${Math.round(performance.now() - t)} ms — it waited`);

  // Even with a refusal of this role in the log: stdout of a success is not evidence.
  kernelLine(dir, "web", "src/api/x.ts");
  assert.equal(await afterTool(cfg, "web", quiet, { file }), null);

  // On stderr of a success it gets one look, and no waits.
  const clean = policy();
  const onStderr = { ...quiet, tool_response: { stdout: "", stderr: "sh: y: Permission denied\n" } };
  t = performance.now();
  assert.equal(await afterTool(loadConfig(join(clean.dir, "seisin.toml")), "web", onStderr, { file: logPath(clean.dir) }), null);
  assert.ok(performance.now() - t < 90, `took ${Math.round(performance.now() - t)} ms — it waited`);
});

test("a Bash that reports failure on stderr still gets the sentence", async () => {
  const { dir } = policy();
  kernelLine(dir, "web", "src/api/x.ts");
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const failed = { hook_event_name: "PostToolUse", tool_name: "Bash",
    tool_response: { stdout: "", stderr: "sh: src/api/x.ts: Operation not permitted\n", exit_code: 1 } };
  const out = await afterTool(cfg, "web", failed, { file: logPath(dir), wait: [0] });
  assert.match(out.hookSpecificOutput.additionalContext, /src\/api\/x\.ts belongs to api/);
});
