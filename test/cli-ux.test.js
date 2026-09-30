/**
 * What a new user meets at the prompt: the answers, the numbers and the
 * one-line errors of the CLI, from a first-run review with a small sample repo.
 *
 * Every test here runs the real binary in a repo under test/.sandbox-box, so
 * what is asserted is what a person would read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, boxed, repoWith } from "./_tmp.js";

const TOML = `[keys]
dir = ".secrets"

[roles.frontend]
writes = ["frontend/**"]
keys   = ["netlify.txt"]

[roles.backend]
writes = ["backend/**"]
keys   = ["stripe.txt"]

[roles.qa]
writes = ["qa/**"]
keys   = []
`;

const FILES = [".secrets/netlify.txt", ".secrets/stripe.txt", "frontend/src/app.js", "backend/src/server.py", ".env"];

function sh(cwd, ...args) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.SEISIN_ROLE;
  delete env.SEISIN_CONFIG;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

function demo(prefix = "ux-", toml = TOML, files = FILES) {
  return repoWith(prefix, toml, files);
}

function ask(dir, entry) {
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const key = `${entry.role}:${entry.action}:${entry.action === "read" ? entry.target : entry.target.split("/").slice(0, -1).join("/") || "."}`;
  appendFileSync(join(dir, ".seisin", "requests.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), kind: "asked", key, owners: [], ...entry }) + "\n");
  return key;
}

/* ── 1. a read outside every key dir is open ─────────────────────────────── */

test("explain: a read outside every key dir is allowed, and says why", () => {
  const dir = demo();
  const r = sh(dir, "explain", "frontend", "read", ".env");
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /allowed\s+frontend read \.env/);
  assert.match(r.out, /outside every \[keys\] dir \(\.secrets\), so every role reads it/);
  assert.match(r.out, /Move it into \.secrets\/ to make it a key/);
});

test("explain: a read inside a key dir keeps the key answer", () => {
  const dir = demo();
  const theirs = sh(dir, "explain", "frontend", "read", ".secrets/stripe.txt");
  assert.equal(theirs.code, 1);
  assert.match(theirs.out, /denied .* belongs to backend/s);
  assert.equal(sh(dir, "explain", "frontend", "read", "netlify").code, 0);
  assert.equal(sh(dir, "explain", "frontend", "read", "stripe").code, 1);
});

test("explain: an undeclared key is advised in the form keys are written", () => {
  const dir = demo();
  const r = sh(dir, "explain", "qa", "read", ".secrets/new.txt");
  assert.equal(r.code, 1);
  assert.match(r.out, /add "new.txt" to a role's keys/);
  assert.doesNotMatch(r.out, /add "\.secrets\/new\.txt"/);
});

/* ── 2. relative paths are relative to where you stand ───────────────────── */

test("explain and whose read a relative path from the working directory", () => {
  const dir = demo();
  const sub = join(dir, "frontend", "src");
  const r = sh(sub, "explain", "frontend", "write", "app.js");
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /frontend write frontend\/src\/app\.js/);
  const w = sh(sub, "whose", "app.js");
  assert.match(w.out, /frontend\/src\/app\.js belongs to frontend/);
  const up = sh(sub, "explain", "backend", "write", "../../backend/src/server.py");
  assert.equal(up.code, 0, up.all);
  assert.match(up.out, /backend write backend\/src\/server\.py/);
});

/* ── 3. a key another role declares ───────────────────────────────────────── */

test("requests: a read of a declared key says who declares it; grant warns and writes the short form", () => {
  const dir = demo();
  const key = ask(dir, { role: "qa", action: "read", target: ".secrets/stripe.txt" });
  const list = sh(dir, "requests");
  assert.match(list.out, /qa wants read on stripe\.txt \(declared by backend\)/);
  assert.doesNotMatch(list.out, /unowned/);

  const g = sh(dir, "grant", key);
  assert.equal(g.code, 0, g.all);
  assert.match(g.out, /shared: stripe\.txt is also declared by backend/);
  const toml = readFileSync(join(dir, "seisin.toml"), "utf8");
  const qa = toml.slice(toml.indexOf("[roles.qa]"));
  assert.match(qa, /"stripe\.txt"/);
  assert.doesNotMatch(qa, /\.secrets\/stripe\.txt/);
});

/* ── 5. numbers are positions ─────────────────────────────────────────────── */

test("requests says numbers shift; grant and decline print the renumbered queue", () => {
  const dir = demo();
  ask(dir, { role: "qa", action: "write", target: "frontend/a.js" });
  ask(dir, { role: "qa", action: "write", target: "backend/b.py" });
  ask(dir, { role: "frontend", action: "write", target: "backend/c.py" });
  assert.match(sh(dir, "requests").out, /#n is a position .* the id does not/);
  const d = sh(dir, "decline", "1");
  assert.equal(d.code, 0, d.all);
  assert.match(d.out, /left, renumbered: #1 qa write backend\/\*\* · #2 frontend write backend\/\*\*/);
  const g = sh(dir, "grant", "2");
  assert.match(g.out, /granted\s+frontend → backend\/\*\*/);
  assert.match(g.out, /left, renumbered: #1 qa write backend\/\*\*/);
});

test("grant and decline with no argument point at seisin requests", () => {
  const dir = demo();
  for (const verb of ["grant", "decline"]) {
    const r = sh(dir, verb);
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(`usage: seisin ${verb} <n\\|id> .* seisin requests`));
  }
});
