/**
 * The commands the rest of the suite reaches only through their functions,
 * run the way a person or a CI script runs them: through the CLI, by exit code
 * and output. `walls` and `scan` promise an exit code that composes in a
 * script (non-zero means "there is something to look at"); nothing checked
 * that promise at the process boundary until now.
 *
 * No server is started here: `ui` is exercised only through `--link`, which
 * reads and prints, on a port this file has just proven free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { CLI, repoWith } from "./_tmp.js";
import { record } from "../src/requests.js";

const POLICY = '[roles.dev]\nwrites = ["src/**"]\n\n[roles.infra]\nwrites = ["deploy/**"]\n';

const seisin = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

/** A repo whose log holds exactly these lines. */
function repoWithLog(entries) {
  const dir = repoWith("cli-", POLICY, ["src/", "deploy/"]);
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  writeFileSync(join(dir, ".seisin", "log.jsonl"),
    entries.map((e) => JSON.stringify({ at: new Date().toISOString(), ...e })).join("\n") + "\n");
  return dir;
}
const denial = (role, target) => ({ role, action: "write", target, verdict: "denied", owners: [] });

/* ── walls ───────────────────────────────────────────────────────────── */

test("walls exits 0 and prints nothing when the role has hit no wall", () => {
  const r = seisin(repoWithLog([denial("dev", "deploy/a.yml")]), "walls", "dev");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "", "one denial is information, not a wall");
});

test("walls exits 1 and names the wall when the role keeps hitting one", () => {
  const dir = repoWithLog([denial("dev", "deploy/b.yml"), denial("dev", "deploy/b.yml"), denial("infra", "src/x.ts")]);
  const r = seisin(dir, "walls", "dev");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /deploy\/b\.yml/);
  assert.doesNotMatch(r.stdout, /src\/x\.ts/, "another role's history is not this one's");
  // The same log, asked for the role that has no wall in it.
  assert.equal(seisin(dir, "walls", "infra").status, 0);
});

test("walls without a role, or with an unknown one, is a usage error (exit 2)", () => {
  const dir = repoWithLog([]);
  const none = seisin(dir, "walls");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: seisin walls <role>/);
  const unknown = seisin(dir, "walls", "nobody");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown role "nobody"\. Known: dev, infra/);
});

/* ── scan ────────────────────────────────────────────────────────────── */

test("scan exits 0 on a repo with no credential in it", () => {
  const dir = repoWith("cli-", POLICY, ["src/"]);
  writeFileSync(join(dir, "src", "app.ts"), "export const answer = 42;\n");
  const r = seisin(dir, "scan");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("scan exits non-zero on a loose token whose shape alone proves it", () => {
  const dir = repoWith("cli-", POLICY, ["src/"]);
  // Built, not written out, so this file is not itself a finding.
  writeFileSync(join(dir, "src", "config.ts"), `const token = "${"ghp_" + "A".repeat(36)}";\n`);
  const r = seisin(dir, "scan");
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.status, 1, "1 is a finding; 2 would be seisin failing");
  assert.match(r.stdout + r.stderr, /src\/config\.ts/);
});

/* ── ui, without a server ────────────────────────────────────────────── */

/** A port nothing is listening on: bound by us a moment ago, then released. */
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

test("ui --link with no console running says so, starts nothing, and exits 0", async () => {
  const port = await freePort();
  const r = seisin(repoWith("cli-", POLICY), "ui", "--link", "--port", String(port));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`no seisin ui running on ${port} — start one with: seisin ui --port ${port}`));
});

/* ── dispatch ────────────────────────────────────────────────────────── */

test("no command prints the usage and exits 0; an unknown one exits 2", () => {
  const dir = repoWith("cli-", POLICY);
  const bare = seisin(dir);
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /seisin walls <role>/);
  assert.match(bare.stdout, /seisin scan/);
  const typo = seisin(dir, "wals", "dev");
  assert.equal(typo.status, 2);
  assert.match(typo.stdout, /seisin walls <role>/);
});

/* ── what the CLI says it did not do ─────────────────────────────────── */

test("scan names the nested checkouts it pruned", () => {
  const dir = repoWith("cli-", POLICY, ["src/"]);
  mkdirSync(join(dir, "libs", "other", ".git"), { recursive: true });
  writeFileSync(join(dir, "libs", "other", "k.txt"), "ghp_" + "B".repeat(36) + "\n");
  const r = seisin(dir, "scan");
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 nested checkout\(s\)/);
});

test("log verify says when the start of the chain is not recorded yet", () => {
  const dir = repoWithLog([denial("dev", "deploy/a.yml")]);
  const r = seisin(dir, "log", "verify");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /intact/);
  assert.match(r.stdout, /not recorded yet/);
});

test("a declined request is settled once, through the same lock a grant takes", () => {
  const dir = repoWith("cli-", POLICY, ["src/"]);
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  record(join(dir, ".seisin", "requests.jsonl"), { role: "dev", action: "write", target: "deploy/x", owners: ["infra"] });
  const first = seisin(dir, "decline", "1");
  assert.equal(first.status, 0, first.stderr);
  const again = seisin(dir, "decline", "1");
  assert.notEqual(again.status, 0, "a settled request cannot be settled again");
});
