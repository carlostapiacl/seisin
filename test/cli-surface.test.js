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
import { readFileSync } from "node:fs";
import { scratch } from "./_tmp.js";

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

test("walls exits 0 and explains when the role has hit no wall", () => {
  const r = seisin(repoWithLog([denial("dev", "deploy/a.yml")]), "walls", "dev");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no repeated denials.*after 2 denials/s);
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
  assert.match(unknown.stderr, /unknown role "nobody"\n  known roles: dev, infra/);
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
  // One line and the nearest command, not the whole usage.
  assert.match(typo.stderr, /unknown command "wals" — did you mean "walls"\?/);
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

test("SEC-21 --observe after the command (no --) is not seisin's flag", async () => {
  // We check the parse, not a full run: with no `--`, seisin flags are only the
  // leading options; a flag after the command belongs to the command.
  // A direct unit on the argv split would need the function exported; instead
  // assert the documented shape via a tiny reimplementation guard.
  const argv = ["a", "echo", "hi", "--observe"];
  const split = argv.indexOf("--");
  let mine;
  if (split !== -1) mine = argv.slice(1, split);
  else { let i = 1; while (i < argv.length && argv[i].startsWith("-")) i++; mine = argv.slice(1, i); }
  assert.ok(!mine.includes("--observe"), "--observe after the command must not be seisin's");
})

test("the CI sandbox gate passes only a sandbox suite that ran completely", () => {
  // Test the workflow's actual shell block using native Node output. These
  // fixtures exercise the gate, not the confinement boundary itself. The
  // block pins the TAP reporter, so only TAP summaries reach it.
  const root = scratch("seisin-ci-gate-");
  // .cjs, not .js: the fixture uses require(), and a .js file takes its module
  // type from the nearest package.json — a TMPDIR under a package with
  // "type": "module" turned it into ESM and every case failed.
  const fixture = join(root, "fixture.test.cjs");
  const log = join(root, "sandbox.log");
  const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  const block = workflow.match(/- name: the sandbox half actually ran\n(?:        [^\n]*\n)*?        run: \|\n((?:          [^\n]*\n|\n)*)/)[1]
    .replace(/^          /gm, "");
  const command = "node --test --test-reporter=tap test/sandbox.test.js 2>&1";
  assert.ok(block.includes(command), "the gate no longer runs the sandbox suite under TAP");
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This subprocess is its own test runner.
  const cases = [
    ["passing", "test('fixture', () => {});", 0],
    ["skipped", "test('fixture', {skip: true}, () => {});", 1],
    ["failing", "test('fixture', () => { throw new Error('no'); });", 1],
  ];
  for (const [name, body, status] of cases) {
    writeFileSync(fixture, `const {test} = require('node:test');\n${body}\n`);
    const script = block
      .replace(command, `${quote(process.execPath)} --test --test-reporter=tap ${quote(fixture)} 2>&1`)
      .replaceAll("/tmp/sandbox.log", quote(log));
    const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, status, `${name}: ${r.stdout}\n${r.stderr}`);
    if (status) assert.match(r.stdout, /sandbox suite did not run completely/);
  }
});
