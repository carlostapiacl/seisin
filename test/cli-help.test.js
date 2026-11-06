/**
 * Help: every command answers it, and a command's own words stay its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { scratch, repoWith as policyRepo, CLI } from "./_tmp.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/* ── --help is a question ─────────────────────────────────────────────── */

const seisin = (cwd, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 10_000, input: "" });

const EVERY = ["run", "check", "explain", "whose", "scan", "review", "walls", "wire", "requests",
  "grant", "decline", "log", "watch", "init", "ui", "mcp", "hook"];

test("every command answers --help and -h with its usage, exit 0, and does nothing else", () => {
  // No policy here on purpose: help must not need one.
  const dir = scratch("seisin-help-");
  for (const c of EVERY) for (const h of ["--help", "-h"]) {
    const r = seisin(dir, c, h);
    // a server or a stdin reader would still be running when the timeout hit
    assert.equal(r.status, 0, `${c} ${h}: status ${r.status} signal ${r.signal} ${r.stderr}`);
    assert.match(r.stdout, /usage:/, `${c} ${h}`);
    assert.match(r.stdout, new RegExp(`seisin ${c}\\b`), `${c} ${h}`);
  }
  // wire and init write files when they run; asked for help, they wrote nothing
  assert.deepEqual(readdirSync(dir), []);
});

test("seisin --help, -h and help exit 0; help <command> narrows; an unknown command is still 2", () => {
  const dir = scratch("seisin-help-");
  for (const a of [["--help"], ["-h"], ["help"], []]) {
    const r = seisin(dir, ...a);
    assert.equal(r.status, 0, a.join(" "));
    assert.match(r.stdout, /seisin run <role>/);
  }
  const one = seisin(dir, "help", "ui");
  assert.equal(one.status, 0);
  assert.match(one.stdout, /seisin ui \[--port <n>\]/);
  assert.doesNotMatch(one.stdout, /seisin run/);
  assert.equal(seisin(dir, "nonsense").status, 2);
});

test("--help after the command's own words belongs to the command", () => {
  const dir = policyRepo("help-", '[roles.dev]\nwrites = ["src/**"]\n', ["src/"]);
  // after `--` it is the agent's flag: seisin runs (and here refuses the role)
  const after = seisin(dir, "run", "nobody", "--", "ls", "--help");
  assert.equal(after.status, 2);
  assert.match(after.stderr, /unknown role "nobody"/);
  // without `--`, from the first word of the command on, it is still theirs
  const bare = seisin(dir, "run", "nobody", "ls", "--help");
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /unknown role "nobody"/);
  // but seisin's own flags, before the command, are seisin's
  assert.equal(seisin(dir, "run", "dev", "--help").status, 0);
  // the value of a flag is a value
  const reason = seisin(dir, "grant", "1", "--reason", "-h");
  assert.notEqual(reason.status, 0);
  assert.doesNotMatch(reason.stdout, /usage:/);
});

test("run help honours the agent option's value and the child command's own flags", () => {
  const root = scratch("seisin-help-agent-");
  writeFileSync(join(root, "seisin.toml"), '[roles.dev]\nwrites = []\n');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 2000 });
  for (const args of [["run", "dev", "--agent", "codex", "--help"], ["run", "dev", "--agent", "codex", "-h", "--", "true"]]) {
    const r = cli(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage:/);
  }
  const value = cli("run", "dev", "--agent", "--help", "--", "true");
  assert.equal(value.status, 2);
  assert.doesNotMatch(value.stdout, /usage:/);
  const child = cli("run", "missing", "--agent", "codex", "echo", "--help");
  assert.equal(child.status, 2);
  assert.match(child.stderr, /unknown role/);
});
