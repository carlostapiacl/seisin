/**
 * The after-the-fact refusal and the session-start map (src/diagnose.js).
 *
 * The case: the kernel refused something PreToolUse never saw, and the agent
 * got `Operation not permitted` with no path. These check that the next hook
 * turns the kernel's own log line into the sentence, and says nothing when
 * there is nothing to say.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { afterTool, atSessionStart, recentKernelDenials } from "../src/diagnose.js";
import { wire, wired } from "../src/commands/wire.js";
import { logPath } from "../src/log.js";
import { resolveSrt } from "../src/commands/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const BOX = join(HERE, ".sandbox-box");
const TOML = '[roles.web]\nwrites = ["src/web/**"]\n\n[roles.api]\nwrites = ["src/api/**"]\n';

function repo(toml = TOML) {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "diag-"));
  writeFileSync(join(dir, "seisin.toml"), toml);
  mkdirSync(join(dir, "src", "api"), { recursive: true });
  mkdirSync(join(dir, "src", "web"), { recursive: true });
  return dir;
}

function kernelLine(dir, role, target, agoMs = 0) {
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  appendFileSync(logPath(dir), JSON.stringify({
    at: new Date(Date.now() - agoMs).toISOString(), role, tool: "kernel", source: "kernel",
    action: "write", kind: "file", target, verdict: "denied", owners: [], reason: "file-write-create",
  }) + "\n");
}

const FAILED = { hook_event_name: "PostToolUseFailure", tool_name: "Bash",
  error: "sh: src/api/x.ts: Operation not permitted" };

test("a failed command is followed by whose it was", async () => {
  const dir = repo();
  kernelLine(dir, "web", "src/api/x.ts");
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const out = await afterTool(cfg, "web", FAILED, { file: logPath(dir), wait: [0] });
  const text = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(text, /not a Unix permission/);
  assert.match(text, /src\/api\/x\.ts belongs to api\. It is not web's to change/);
  assert.doesNotMatch(text, /--allow|widen|add .* to writes/i, "the sentence must not suggest widening");
});

test("a repeated refusal says how many times", async () => {
  const dir = repo();
  for (let i = 0; i < 3; i++) kernelLine(dir, "web", "src/api/x.ts");
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const out = await afterTool(cfg, "web", FAILED, { file: logPath(dir), wait: [0] });
  assert.match(out.hookSpecificOutput.additionalContext, /Refused 3 times/);
});

test("nothing to say: no denial in the output, or no refusal in the log, or an old one", async () => {
  const dir = repo();
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const ok = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { stdout: "done", stderr: "" } };
  kernelLine(dir, "web", "src/api/x.ts");
  assert.equal(await afterTool(cfg, "web", ok, { file: logPath(dir), wait: [0] }), null, "a command that did not fail");
  const other = repo();
  assert.equal(await afterTool(cfg, "web", FAILED, { file: logPath(other), wait: [0] }), null, "no refusal logged");
  const old = repo();
  kernelLine(old, "web", "src/api/x.ts", 10 * 60_000);
  assert.equal(recentKernelDenials(logPath(old), "web", Date.now() - 120_000).length, 0, "ten minutes ago is another call");
});

test("another role's refusals are not this one's", async () => {
  const dir = repo();
  kernelLine(dir, "api", "src/web/y.ts");
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(await afterTool(cfg, "web", FAILED, { file: logPath(dir), wait: [0] }), null);
});

test("session start hands the role its map and its walls", () => {
  const dir = repo('[roles.web]\nwrites = ["src/web/**"]\nnever_writes = ["src/web/.git/index.lock"]\n\n[roles.api]\nwrites = ["src/api/**"]\n');
  for (let i = 0; i < 3; i++) kernelLine(dir, "web", "src/api/x.ts");
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const t = atSessionStart(cfg, "web", { hook_event_name: "SessionStart", source: "compact" }, { file: logPath(dir) })
    .hookSpecificOutput.additionalContext;
  assert.match(t, /role "web"/);
  assert.match(t, /You may write: src\/web\/\*\*/);
  assert.match(t, /Never, even inside that: src\/web\/\.git\/index\.lock/);
  assert.match(t, /write src\/api\/x\.ts \(3×\) — belongs to api/);
});

test("wire adds every event, and an old PreToolUse-only wiring is not 'already wired'", () => {
  const dir = repo();
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "seisin hook" }] }] } }));
  assert.equal(wired(dir), false);
  wire(loadConfig(join(dir, "seisin.toml")));
  assert.equal(wired(dir), true);
  const hooks = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks;
  assert.equal(hooks.PreToolUse.length, 1, "the existing entry was duplicated");
  for (const ev of ["PostToolUse", "PostToolUseFailure", "SessionStart"]) assert.ok(hooks[ev]?.length, ev);
});

const skip = resolveSrt() !== null && process.platform === "darwin" ? false : "macOS: the kernel's refusals are read from its log there";

test("a real refusal by the kernel becomes the sentence", { skip }, async () => {
  const dir = repo();
  const r = spawnSync(process.execPath, [CLI, "run", "web", "--", "sh", "-c", "echo x > src/api/real.ts"],
    { cwd: dir, encoding: "utf8" });
  assert.notEqual(r.status, 0, "the kernel let it through");
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const out = await afterTool(cfg, "web", { ...FAILED, error: r.stderr }, { file: logPath(dir) });
  assert.ok(out, `nothing said; stderr was: ${r.stderr}`);
  assert.match(out.hookSpecificOutput.additionalContext, /src\/api\/real\.ts belongs to api/);
});
