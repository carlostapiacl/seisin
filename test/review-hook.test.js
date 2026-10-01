/**
 * The hook and the run, held to what the 2026-09-30 code review found.
 *
 * Each test names the finding it fixes. Most go through the CLI, because the
 * contract that broke was the process's — its exit code and how long it took —
 * and a unit test of the function behind it would have passed all along.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scratch, boxed } from "./_tmp.js";

import { targetsOf, decide, TOOL_MATCHER } from "../src/hook.js";
import { loadConfig } from "../src/config.js";
import { wire, wired } from "../src/commands/wire.js";
import { afterTool } from "../src/diagnose.js";
import { logPath } from "../src/log.js";
import { resolveSrt } from "../src/commands/run.js";
import { runsRoot } from "../src/rundir.js";
import { watchDenials } from "../src/violations.js";

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
  // Nothing beyond the protocol: Codex drops a hook answer with any other field.
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ["hookSpecificOutput"]);
});

test("a Codex apply_patch names its files in the patch headers, and those are the targets", () => {
  // The event as codex 0.150.1 sends it (2026-09-30): the patch in tool_input.command.
  const patch = "*** Begin Patch\n*** Update File: /r/front/README.md\n@@\n-a\n+b\n" +
    "*** Add File: src/new.ts\n+x\n*** Delete File: old.txt\n" +
    "*** Update File: a.ts\n*** Move to: b.ts\n*** End Patch\n";
  assert.deepEqual(targetsOf("apply_patch", { command: patch }).map((t) => t.path),
    ["/r/front/README.md", "src/new.ts", "old.txt", "a.ts", "b.ts"]);
  assert.ok(targetsOf("apply_patch", { command: patch }).every((t) => t.action === "write"));
  assert.deepEqual(targetsOf("apply_patch", { command: "+*** Add File: not-a-header" }), []);
  assert.deepEqual(targetsOf("apply_patch", null), []);
  assert.match("apply_patch", new RegExp(TOOL_MATCHER));
});

test("a Codex apply_patch outside the territory is denied by the hook, before the kernel", () => {
  const { env } = policy();
  const r = hook(env, { hook_event_name: "PreToolUse", tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Add File: src/api/x.ts\n+x\n*** End Patch\n" } });
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

/* ── timesHit one behind under `seisin run` ───────────────────────────── */

/** A PreToolUse denial of `target` for `role`, as the parent writes it from the socket. */
function hookLine(dir, role, target) {
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  appendFileSync(logPath(dir), JSON.stringify({
    at: new Date().toISOString(), role, tool: "Write", action: "write", kind: "file",
    target, verdict: "denied", owners: ["api"], reason: "x",
  }) + "\n");
}

test("the refusal counts this attempt when its entry went to the socket, not the file", () => {
  const { dir, env } = policy();
  hookLine(dir, "web", "src/api/x.ts");
  // Through the CLI with SEISIN_SPOOL set: this attempt's line goes to a
  // socket (nobody is listening, so it never reaches the file at all).
  const r = hook(env, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "src/api/x.ts" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /denied this 2 times now.*third try/);
});

test("the same count when the entry went to the file", () => {
  const { dir } = policy();
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const event = { tool_name: "Write", tool_input: { file_path: "src/api/x.ts" } };
  const lost = () => {};                       // the socket: nothing lands on disk
  hookLine(dir, "web", "src/api/x.ts");
  const viaSocket = decide(cfg, "web", event, { now: lost, ask: lost });
  const viaFile = decide(cfg, "web", event, { ask: lost });   // real append, to the file
  assert.match(viaSocket.hookSpecificOutput.permissionDecisionReason, /denied this 2 times now/);
  assert.match(viaFile.hookSpecificOutput.permissionDecisionReason, /denied this 2 times now/);
  const third = decide(cfg, "web", event, { ask: lost });
  assert.match(third.hookSpecificOutput.permissionDecisionReason, /denied this 3 times now/);
});

/* ── P0-8: a run that fails leaves nothing behind, and says so with exit 2 ── */

const noSrt = resolveSrt() ? false : "sandbox runtime not installed";

/** The run directories still on disk that belong to process `pid`. */
function leftBy(pid) {
  const root = runsRoot();
  return readdirSync(root).filter((n) => {
    try { return Number(readFileSync(join(root, n, "pid"), "utf8")) === pid; } catch { return false; }
  });
}

test("a run whose key cannot be resolved exits 2 and removes its run directory", { skip: noSrt }, () => {
  const dir = boxed("rh-key-");
  writeFileSync(join(dir, "seisin.toml"),
    '[roles.keyed]\nwrites = ["src/**"]\nkeys = ["TOK=file://not-there.txt"]\nkey_mode = "scratch"\n');
  // Fails after the run directory, the settings and the spool exist.
  const r = spawnSync(process.execPath, [CLI, "run", "keyed", "--", "true"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot read/);
  assert.deepEqual(leftBy(r.pid), [], "the run's directory — socket, settings — stayed on disk");
});

test("a runtime killed by a signal exits 128 + n, like a run that was stopped", { skip: noSrt }, async () => {
  const dir = boxed("rh-sig-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.plain]\nwrites = ["src/**"]\n');
  const child = spawn(process.execPath, [CLI, "run", "plain", "--", "sleep", "20"], { cwd: dir, stdio: "ignore" });
  // The runtime is seisin's direct child other than `log stream`.
  let srt = null;
  for (const end = Date.now() + 15_000; !srt && Date.now() < end;) {
    await new Promise((ok) => setTimeout(ok, 100));
    const ps = spawnSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
    srt = ps.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .find((m) => m && Number(m[2]) === child.pid && /srt/.test(m[3]) && !/log stream/.test(m[3]))?.[1];
  }
  assert.ok(srt, "the runtime never started");
  process.kill(Number(srt), "SIGKILL");
  const [code] = await once(child, "exit");
  assert.equal(code, 128 + 9);
  assert.deepEqual(leftBy(child.pid), []);
});

test("a kernel watcher that cannot start has the whole shape run relies on", async () => {
  const w = watchDenials(() => {}, { platform: "darwin", spawnFn: () => { throw new Error("no log(1) here"); } });
  assert.equal(w.available, false);
  assert.doesNotThrow(() => w.attributeTo(123));
  assert.deepEqual(await w.close({ drain: 50 }), { attributed: 0, foreign: 0, unattributed: 0 });
});

/* ── P1-15: `ps` is not taken once per foreign denial ─────────────────── */

/** A denial as `log stream` prints it, from `pid`, tagged with `cmd` and `suffix`. */
const denial = (pid, suffix, cmd = "git gc --aggressive", path = "/private/tmp/demo/src/api/x.txt") =>
  `2026-09-30 12:00:00.000 E  kernel[0:78a1c2] (Sandbox) Sandbox: bash(${pid}) deny(1) file-write-create ${path}\n` +
  `CMD64_${Buffer.from(cmd).toString("base64")}_END_${suffix}_SBX`;

function fakeStream() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.kill = () => {};
  return child;
}
const delivered = () => new Promise((r) => setImmediate(r));
const OURS = ["env", "SEISIN_RUN_ID=abc", "sh", "-c", "work"];

test("a burst of foreign denials costs one ps, not one each (review P1-15)", async () => {
  const child = fakeStream();
  let calls = 0;
  // Two other sandboxes, alive, under their own srt (pid 500 and 600).
  const tree = new Map([[900, 1], [500, 1], [600, 1]]);
  for (let i = 0; i < 40; i++) { tree.set(10_000 + i, 500); tree.set(20_000 + i, 600); }
  const w = watchDenials(() => {}, { argv: OURS, platform: "darwin", spawnFn: () => child,
    treeFn: () => { calls++; return tree; } });
  w.attributeTo(900);

  for (let i = 0; i < 40; i++) {
    child.stdout.push(denial(10_000 + i, "_aaaaaaaaa"));
    child.stdout.push(denial(20_000 + i, "_bbbbbbbbb"));
  }
  await delivered();
  assert.ok(calls <= 2, `${calls} ps snapshots for 80 foreign denials`);
  assert.equal(w.stats.attributed, 0);
  assert.equal(w.stats.foreign, 80, "a suffix proven foreign is counted, not held");
  w.close();
});

test("throttling ps does not lose a denial from a process younger than the snapshot", async () => {
  const child = fakeStream();
  const seen = [];
  const tree = new Map([[900, 1], [500, 1], [10_000, 500]]);
  let calls = 0;
  const w = watchDenials((d) => seen.push(d.pid), { argv: OURS, platform: "darwin", spawnFn: () => child,
    treeFn: () => { calls++; return new Map(tree); } });
  w.attributeTo(900);

  child.stdout.push(denial(10_000, "_aaaaaaaaa"));      // foreign: takes the snapshot
  await delivered();
  // Ours, from a process born after that snapshot, with a tag that does not
  // match (the case the tree exists for). Inside the window: no ps now.
  tree.set(30_000, 900);
  child.stdout.push(denial(30_000, "_ours12345", "something the runtime quoted differently"));
  await delivered();
  assert.deepEqual(seen, [], "decided on a stale snapshot");
  const before = calls;
  for (const end = Date.now() + 3000; !seen.length && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(seen, [30_000], "held and never looked at again");
  assert.equal(calls, before + 1, "one snapshot for the deferred look");
  w.close();
});
