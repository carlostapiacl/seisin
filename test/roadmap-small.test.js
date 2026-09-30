/**
 * Small roadmap items, each with the case that shows it and the one that must
 * stay quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { inspect } from "../src/inspect.js";
import { wire, hookEntries } from "../src/commands/wire.js";
import { TOOL_MATCHER } from "../src/hook.js";
import { alive } from "../src/log.js";
import { runsRoot, openRun } from "../src/rundir.js";
import { recentKernelDenials } from "../src/diagnose.js";
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

/* ── one alive(), one JSON-lines reader ──────────────────────────────── */

const gonePid = () =>
  Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);

test("alive() is false only for a process the kernel says is gone", () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(gonePid()), false);
  // pid 1 is there and not ours to signal (EPERM): alive, not gone
  if (process.getuid?.() !== 0) assert.equal(alive(1), true);
  // not a pid we can ask about — and kill(-n) would ask a whole group
  for (const p of [0, -1, NaN, 1.5, undefined]) assert.equal(alive(p), true, String(p));
});

test("the run sweep removes a dead run's directory and keeps one it cannot rule dead", () => {
  const base = scratch("seisin-sweep-");
  const root = runsRoot(base);
  const dead = mkdtempSync(join(root, "dead00-"));
  writeFileSync(join(dead, "pid"), String(gonePid()));
  // pid 1 answers EPERM to an ordinary user: rundir.js used to treat only
  // EPERM as alive; this one must survive either way, and now so does anything
  // the kernel did not call gone.
  const unsure = mkdtempSync(join(root, "unsur-"));
  writeFileSync(join(unsure, "pid"), "1");
  const odd = mkdtempSync(join(root, "odd000-"));
  writeFileSync(join(odd, "pid"), "-1");
  const run = openRun({ base });
  try {
    assert.ok(!existsSync(dead), "a dead run's directory survived the next run");
    assert.ok(existsSync(unsure), "a run that may be alive was swept");
    assert.ok(existsSync(odd), "a pid file naming a process group was read as a dead run");
  } finally {
    run.close();
  }
});

test("diagnose reads the log's last 512 KB, dropping the line the cut lands in", () => {
  const dir = scratch("seisin-diag-");
  const file = join(dir, "log.jsonl");
  const now = Date.now();
  const at = new Date(now - 1000).toISOString();
  const denial = (target) => JSON.stringify({ at, role: "dev", verdict: "denied", source: "kernel", action: "write", target });
  // one recent refusal far before the budget, then filler, then one at the end
  const filler = JSON.stringify({ at, role: "other", verdict: "allowed", pad: "x".repeat(200) });
  const lines = [denial("early/a.txt")];
  let bytes = 0;
  while (bytes < 700 * 1024) { lines.push(filler); bytes += filler.length + 1; }
  lines.push(denial("late/b.txt"));
  writeFileSync(file, lines.join("\n") + "\n");
  const seen = recentKernelDenials(file, "dev", now - 60_000).map((e) => e.target);
  assert.deepEqual(seen, ["late/b.txt"], "read past the byte budget, or missed the last line");

  // The cut: 10 bytes into a refusal drops it; exactly on its first byte keeps it.
  const BUDGET = 512 * 1024;
  const L = denial("cut/c.txt");
  const padded = (n) => JSON.stringify({ pad: "y".repeat(n - 10) });   // `{"pad":""}` is 10 bytes
  const inside = join(dir, "inside.jsonl");
  writeFileSync(inside, L + "\n" + padded(BUDGET + 10 - L.length - 2) + "\n");
  assert.equal(statSync(inside).size, BUDGET + 10);
  assert.deepEqual(recentKernelDenials(inside, "dev", now - 60_000), [], "half a line was read as a refusal");
  const onEdge = join(dir, "edge.jsonl");
  const X = denial("before/x.txt");
  writeFileSync(onEdge, X + "\n" + L + "\n" + padded(BUDGET - L.length - 2) + "\n");
  assert.equal(statSync(onEdge).size, BUDGET + X.length + 1);
  assert.deepEqual(recentKernelDenials(onEdge, "dev", now - 60_000).map((e) => e.target), ["cut/c.txt"],
    "a cut on a line boundary lost a whole line, or read past the budget");
});
