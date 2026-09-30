/**
 * Small roadmap items, each with the case that shows it and the one that must
 * stay quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inspect } from "../src/inspect.js";
import { wire, hookEntries } from "../src/commands/wire.js";
import { TOOL_MATCHER } from "../src/hook.js";
import { scratch, repoWith as policyRepo, CLI } from "./_tmp.js";

const silently = (fn) => {
  const w = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
};

function repoWith(settings) {
  const root = scratch("seisin-rs-");
  if (settings) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  }
  return {
    root, path: join(root, "seisin.toml"), keyDirs: [], allowedDomains: [],
    roles: { dev: { name: "dev", writes: ["src/**"], keys: [], network: null } },
  };
}

const kinds = (cfg) => inspect(cfg, null, "x").warnings.map((w) => w.kind);

test("check says when the hook was wired with the pre-0.5.0 matcher \"*\"", () => {
  // Wired before 0.5.0: every event is there, PreToolUse just runs on every tool.
  const old = hookEntries();
  old.PreToolUse[0].matcher = "*";
  const cfg = repoWith({ hooks: old });

  assert.ok(kinds(cfg).includes("hook-matcher-broad"));
  assert.ok(!kinds(cfg).includes("hook-not-wired"), "it is wired — only broadly");
  const w = inspect(cfg, null, "x").warnings.find((x) => x.kind === "hook-matcher-broad");
  assert.match(w.detail, /seisin wire/);

  // and `seisin wire` is what makes it go away
  assert.equal(silently(() => wire(cfg)).changed, true);
  const pre = JSON.parse(readFileSync(join(cfg.root, ".claude", "settings.json"), "utf8")).hooks.PreToolUse;
  assert.equal(pre[0].matcher, TOOL_MATCHER);
  assert.ok(!kinds(cfg).includes("hook-matcher-broad"));
});

test("check stays quiet about the matcher when it is narrow, missing, or not only ours", () => {
  // freshly wired
  assert.ok(!kinds(repoWith({ hooks: hookEntries() })).includes("hook-matcher-broad"));
  // not wired at all: that is hook-not-wired's to say, not this one's
  const bare = kinds(repoWith(null));
  assert.ok(bare.includes("hook-not-wired") && !bare.includes("hook-matcher-broad"));
  // a "*" entry that also runs somebody else's command: `wire` will not narrow
  // it, so check must not tell anyone to run `wire` for it
  const shared = hookEntries();
  shared.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: "seisin hook" }, { type: "command", command: "their-linter" }] }];
  assert.ok(!kinds(repoWith({ hooks: shared })).includes("hook-matcher-broad"));
});

/* ── --help is a question ─────────────────────────────────────────────── */

const seisin = (cwd, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 10_000, input: "" });

const EVERY = ["run", "check", "explain", "whose", "scan", "review", "walls", "wire", "requests",
  "grant", "decline", "deny", "log", "watch", "init", "ui", "mcp", "hook"];

test("every command answers --help and -h with its usage, exit 0, and does nothing else", () => {
  // No policy here on purpose: help must not need one.
  const dir = scratch("seisin-help-");
  for (const c of EVERY) for (const h of ["--help", "-h"]) {
    const r = seisin(dir, c, h);
    // a server or a stdin reader would still be running when the timeout hit
    assert.equal(r.status, 0, `${c} ${h}: status ${r.status} signal ${r.signal} ${r.stderr}`);
    assert.match(r.stdout, /usage:/, `${c} ${h}`);
    assert.match(r.stdout, new RegExp(`seisin ${c === "deny" ? "decline" : c}\\b`), `${c} ${h}`);
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
  assert.match(one.stdout, /seisin ui \[--port n\]/);
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
