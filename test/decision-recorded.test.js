/**
 * A person's decision is recorded, or the person is told it was not.
 *
 * `settle` went through the bookkeeping writer, whose rule is the agent's: never
 * take a turn down over a line. So a queue that could not be written printed
 * "declined" over nothing, and printed "granted" over a request that stayed
 * open, exit 0 both times. A later decline of that open request then read as a
 * refusal while the role kept the path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requestsPath, pending } from "../src/requests.js";
import { loadConfig } from "../src/config.js";
import { decideRequest, stillAllowed } from "../src/decide-request.js";
import { CLI } from "./_tmp.js";

const POLICY = '[roles.a]\nwrites = ["lib/**"]\n';
const root = process.getuid?.() === 0;

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "seisin-decision-")));
  mkdirSync(join(dir, "src"));
  spawnSync("git", ["init", "-q", "."], { cwd: dir });
  writeFileSync(join(dir, "seisin.toml"), POLICY);
  const queue = requestsPath(dir);
  mkdirSync(dirname(queue), { recursive: true });
  // A line, as a run leaves it; `record` itself may be under a spool in the suite.
  appendFileSync(queue, JSON.stringify({
    at: new Date().toISOString(), kind: "asked", key: "a:write:src", role: "a", action: "write", target: "src/x.js", owners: [],
  }) + "\n");
  return { dir, queue, toml: () => readFileSync(join(dir, "seisin.toml"), "utf8"), kinds: () => kinds(queue) };
}

const kinds = (queue) => readFileSync(queue, "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);

function seisin(dir, args, env = {}) {
  const clean = { ...process.env, ...env };
  if (!("SEISIN_SPOOL" in env)) delete clean.SEISIN_SPOOL;
  delete clean.SEISIN_STATE_DIR;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: clean, encoding: "utf8", input: "" });
  return { code: r.status, text: r.stdout + r.stderr };
}

test("a queue that cannot be written refuses the grant before the policy changes", { skip: root }, () => {
  const r = repo();
  chmodSync(r.queue, 0o444);
  const out = seisin(r.dir, ["grant", "1", "--reason", "x"]);
  assert.notEqual(out.code, 0);
  assert.match(out.text, /could not be recorded/);
  assert.doesNotMatch(out.text, /\bgranted\b/);
  assert.equal(r.toml(), POLICY);
  chmodSync(r.queue, 0o644);
  assert.equal(seisin(r.dir, ["grant", "1", "--reason", "x"]).code, 0);
  assert.deepEqual(r.kinds(), ["asked", "granted"]);
});

test("a decline that was not recorded does not say declined", { skip: root }, () => {
  const r = repo();
  chmodSync(r.queue, 0o444);
  const out = seisin(r.dir, ["decline", "1", "--reason", "x"]);
  assert.notEqual(out.code, 0);
  assert.doesNotMatch(out.text, /\bdeclined\b/);
  assert.deepEqual(r.kinds(), ["asked"]);
});

test("a queue held by a live process refuses the grant with the policy untouched", () => {
  const r = repo();
  const holder = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    writeFileSync(r.queue + ".lock", `${holder.pid} other\n`);
    const out = seisin(r.dir, ["grant", "1", "--reason", "x"]);
    assert.notEqual(out.code, 0);
    assert.match(out.text, /another decision is in progress/);
    assert.equal(r.toml(), POLICY);
  } finally {
    holder.kill();
  }
});

test("a line that fails after the policy changed says so, and the same grant closes it", () => {
  const r = repo();
  // The disk fills between opening the queue and writing the line. Only the
  // append fails: the policy goes through writeFileSync and rename.
  const full = join(r.dir, "full.mjs");
  writeFileSync(full, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
fs.appendFileSync = () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); };
syncBuiltinESMExports();`);
  const limited = spawnSync(process.execPath, ["--import", full, CLI, "grant", "1", "--reason", "first"], {
    cwd: r.dir, encoding: "utf8", input: "", env: (({ SEISIN_SPOOL, SEISIN_STATE_DIR, ...e }) => e)(process.env),
  });
  assert.notEqual(limited.status, 0, limited.stdout + limited.stderr);
  assert.match(limited.stderr + limited.stdout, /already gives a "src\/\*\*"/);
  assert.match(limited.stderr + limited.stdout, /run this grant again/);
  assert.match(r.toml(), /"src\/\*\*"/);
  assert.equal(r.kinds().includes("granted"), false);

  const again = seisin(r.dir, ["grant", "1", "--reason", "second"]);
  assert.equal(again.code, 0);
  assert.match(again.text, /already granted/);
  assert.equal(r.kinds().includes("granted"), true);
});

test("a decision never goes to a spool, which would drop it", () => {
  const r = repo();
  const out = seisin(r.dir, ["decline", "1", "--reason", "x"], { SEISIN_SPOOL: join(r.dir, "nobody.sock") });
  assert.equal(out.code, 0);
  assert.deepEqual(r.kinds(), ["asked", "declined"]);
});

test("declining what the policy already gives says the role keeps it", () => {
  const r = repo();
  writeFileSync(join(r.dir, "seisin.toml"), '[roles.a]\nwrites = ["lib/**", "src/**"]\n');
  const out = seisin(r.dir, ["decline", "1", "--reason", "x"]);
  assert.equal(out.code, 0);
  assert.match(out.text, /a keeps it/);
  assert.deepEqual(r.kinds(), ["asked", "declined"]);
});

test("declining what the policy does not give carries no warning", () => {
  const r = repo();
  const out = seisin(r.dir, ["decline", "1", "--reason", "x"]);
  assert.equal(out.code, 0);
  assert.doesNotMatch(out.text, /keeps it/);
});

test("a queue with old declines to migrate still takes a decision: the lookup holds no queue lock", () => {
  const r = repo();
  appendFileSync(r.queue, JSON.stringify({ at: new Date().toISOString(), kind: "asked", key: "a:write:docs", role: "a", action: "write", target: "docs/y.md", owners: [] }) + "\n");
  appendFileSync(r.queue, JSON.stringify({ at: new Date().toISOString(), kind: "denied", key: "a:write:docs", reason: "old" }) + "\n");
  const started = Date.now();
  const out = seisin(r.dir, ["grant", "1", "--reason", "x"]);
  assert.equal(out.code, 0, out.text);
  assert.ok(Date.now() - started < 5000, "waited on its own lock");
  assert.match(r.toml(), /"src\/\*\*"/);
});

test("the warning reads the policy under the lock, not the one loaded before waiting for it", () => {
  const r = repo();
  const stale = loadConfig(join(r.dir, "seisin.toml"));
  writeFileSync(join(r.dir, "seisin.toml"), '[roles.a]\nwrites = ["lib/**", "src/**"]\n');
  const { stillAllowed: why } = decideRequest(stale, {
    decision: "declined", reason: "x", reload: false, includeOnly: false,
    select: () => pending(r.queue)[0],
  });
  assert.ok(why);
});

test("a closed key is not called open by a file of the same name in the repo", () => {
  const r = repo();
  writeFileSync(join(r.dir, "README.md"), "x");
  mkdirSync(join(r.dir, ".secrets"));
  writeFileSync(join(r.dir, ".secrets", "README.md"), "x");
  writeFileSync(join(r.dir, "seisin.toml"),
    '[keys]\ndir = [".secrets"]\n[roles.a]\nwrites = ["lib/**"]\n[roles.b]\nkeys = ["README.md"]\n');
  const config = loadConfig(join(r.dir, "seisin.toml"));
  const asked = { role: "a", action: "read", target: "README.md" };
  assert.equal(stillAllowed(config, asked), null);
  assert.ok(stillAllowed(config, { ...asked, role: "b" }));
});

test("a decision after a line cut short lands on its own line, and closes the request", () => {
  const r = repo();
  appendFileSync(r.queue, '{"at":"2026-11-05T00:00:00Z","kind":"gran');
  const out = seisin(r.dir, ["decline", "1", "--reason", "x"]);
  assert.equal(out.code, 0, out.text);
  assert.deepEqual(pending(r.queue), []);
});

test("granting what the role's writes already cover closes it and adds no line", () => {
  const r = repo();
  const wide = '[roles.a]\nwrites = ["**"]\n';
  writeFileSync(join(r.dir, "seisin.toml"), wide);
  const out = seisin(r.dir, ["grant", "1", "--reason", "x"]);
  assert.equal(out.code, 0, out.text);
  assert.match(out.text, /already granted/);
  assert.equal(r.toml(), wide);
  assert.deepEqual(r.kinds(), ["asked", "granted"]);
});
