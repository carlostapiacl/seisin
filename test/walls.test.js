/**
 * The walls a role keeps hitting, and the denial that remembers.
 *
 * The log is written by hand here rather than produced by a run: what is being
 * tested is what the reader concludes from a history, and building the history
 * directly is the only way to state one precisely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { walls, render, timesHit } from "../src/walls.js";
import { decide } from "../src/hook.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  roles: {
    dev: { name: "dev", writes: ["src/**"], keys: [], keyEntries: [] },
    infra: { name: "infra", writes: ["deploy/**"], keys: [], keyEntries: [] },
  },
};

/** A log file holding exactly these lines. */
function logWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), "seisin-walls-"));
  const file = join(dir, "log.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify({ at: "2026-09-20T10:00:00.000Z", ...e })).join("\n") + "\n");
  return { dir, file };
}

const denial = (role, target, action = "write") => ({ role, action, target, verdict: "denied" });

test("one denial is information; two is a wall", () => {
  const { dir, file } = logWith([denial("dev", "deploy/a.yml"), denial("dev", "deploy/b.yml"), denial("dev", "deploy/b.yml")]);
  const got = walls(cfg, "dev", { file });
  assert.equal(got.length, 1);
  assert.equal(got[0].target, "deploy/b.yml");
  assert.equal(got[0].times, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a wall the policy now allows is not a wall, whatever the log says", () => {
  // The point of recomputing instead of trusting the history: a grant makes
  // its wall disappear on the next turn, not after a time window expires.
  const { dir, file } = logWith([denial("dev", "src/app.ts"), denial("dev", "src/app.ts"), denial("dev", "src/app.ts")]);
  assert.equal(walls(cfg, "dev", { file }).length, 0, "dev writes src/** today");
  rmSync(dir, { recursive: true, force: true });
});

test("walls are per role — another role's history is not yours", () => {
  const { dir, file } = logWith([denial("infra", "src/x.ts"), denial("infra", "src/x.ts")]);
  assert.equal(walls(cfg, "dev", { file }).length, 0);
  assert.equal(walls(cfg, "infra", { file }).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("two repos are two walls, because collapsing them hides which one was hit", () => {
  const { dir, file } = logWith([
    denial("dev", "deploy/a.yml"), denial("dev", "deploy/a.yml"),
    denial("dev", "deploy/b.yml"), denial("dev", "deploy/b.yml"),
  ]);
  assert.equal(walls(cfg, "dev", { file }).length, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("the same path read and written are different walls", () => {
  const { dir, file } = logWith([
    denial("dev", ".secrets/t.txt", "read"), denial("dev", ".secrets/t.txt", "read"),
    denial("dev", ".secrets/t.txt", "write"), denial("dev", ".secrets/t.txt", "write"),
  ]);
  const got = walls(cfg, "dev", { file });
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((w) => w.action).sort(), ["read", "write"]);
  rmSync(dir, { recursive: true, force: true });
});

test("most-repeated first, because that is the one costing the most", () => {
  const { dir, file } = logWith([
    ...Array(2).fill(denial("dev", "deploy/small.yml")),
    ...Array(5).fill(denial("dev", "deploy/big.yml")),
  ]);
  assert.equal(walls(cfg, "dev", { file })[0].target, "deploy/big.yml");
  rmSync(dir, { recursive: true, force: true });
});

test("nothing to say prints nothing, because a section that always speaks stops being read", () => {
  assert.equal(render([]), "");
});

test("the rendered block carries the reason, which is where the other way in is", () => {
  const { dir, file } = logWith([denial("dev", "deploy/a.yml"), denial("dev", "deploy/a.yml")]);
  const text = render(walls(cfg, "dev", { file }));
  assert.match(text, /2× write deploy\/a\.yml/);
  assert.match(text, /belongs to infra/);
  assert.match(text, /1 of your calls went into retrying/);
  rmSync(dir, { recursive: true, force: true });
});

test("an empty or missing log answers nothing and claims nothing", () => {
  assert.deepEqual(walls(cfg, "dev", { file: "/nope/does-not-exist.jsonl" }), []);
});

// ── the denial that remembers ──────────────────────────────────────────────

test("timesHit counts this exact pair and nothing near it", () => {
  const { dir, file } = logWith([
    denial("dev", "deploy/a.yml"), denial("dev", "deploy/a.yml"),
    denial("dev", "deploy/b.yml"),
    denial("infra", "deploy/a.yml"),
    { role: "dev", action: "write", target: "deploy/a.yml", verdict: "allowed" },
  ]);
  assert.equal(timesHit(file, "dev", "write", "deploy/a.yml"), 2);
  assert.equal(timesHit(file, "dev", "write", "deploy/b.yml"), 1);
  assert.equal(timesHit(file, "dev", "read", "deploy/a.yml"), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("the first denial does not count at you; the second does", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-walls-hook-"));
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const local = { ...cfg, root: dir };
  const event = { tool_name: "Write", tool_input: { file_path: "deploy/x.yml" } };
  const noop = () => {};

  const first = decide(local, "dev", event, { ask: noop });
  assert.equal(first.decision, "deny");
  assert.ok(!/denied this/.test(first.hookSpecificOutput.permissionDecisionReason),
    "a counter reading 1× on every first denial is noise");

  const second = decide(local, "dev", event, { ask: noop });
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /denied this 2 times now/);
  assert.match(second.hookSpecificOutput.permissionDecisionReason, /third try/);

  const third = decide(local, "dev", event, { ask: noop });
  assert.match(third.hookSpecificOutput.permissionDecisionReason, /denied this 3 times now/);
  rmSync(dir, { recursive: true, force: true });
});

test("the count still names the owner — remembering does not replace the answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-walls-hook-"));
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const local = { ...cfg, root: dir };
  const event = { tool_name: "Write", tool_input: { file_path: "deploy/x.yml" } };
  const noop = () => {};
  decide(local, "dev", event, { ask: noop });
  const reason = decide(local, "dev", event, { ask: noop }).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /belongs to infra/);
  assert.match(reason, /Already queued/);
  rmSync(dir, { recursive: true, force: true });
});

test("observing counts nothing at anyone, because nothing was refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-walls-hook-"));
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const local = { ...cfg, root: dir };
  const event = { tool_name: "Write", tool_input: { file_path: "deploy/x.yml" } };
  for (let i = 0; i < 3; i++) decide(local, "dev", event, { observe: true, ask: () => {} });
  assert.equal(timesHit(join(dir, ".seisin", "log.jsonl"), "dev", "write", "deploy/x.yml"), 0);
  rmSync(dir, { recursive: true, force: true });
});
