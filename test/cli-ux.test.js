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
import { CLI, boxed, repoWith, srtSkip } from "./_tmp.js";

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

/* ── 4 and 14. what a run says ─────────────────────────────────────────────── */

test("run: the header names the territory and keys; the end lists only what this run added", { skip: srtSkip() }, () => {
  const dir = demo("ux-run-");
  ask(dir, { role: "qa", action: "write", target: "frontend/old.js" });
  const r = sh(dir, "run", "frontend", "--", "sh", "-c", "echo x > backend/new.py");
  assert.match(r.err, /seisin: frontend · writes frontend\/\*\* \(\+\d+ scratch\) · keys netlify\.txt/);
  assert.match(r.err, /#2\s+frontend wants write on backend\/src\/\*\*|#2\s+frontend wants write on backend\/\*\*/);
  assert.doesNotMatch(r.err, /qa wants write/, "an older request is counted, not reprinted");
  assert.match(r.err, /this run: 1 new request\(s\) · 1 older pending — seisin requests/);

  const quiet = sh(dir, "run", "frontend", "--", "true");
  assert.equal(quiet.code, 0, quiet.all);
  assert.doesNotMatch(quiet.err, /request|pending/, "nothing new, nothing said");
});

test("run: a command that is not there is said as that, with 127", { skip: srtSkip() }, () => {
  const dir = demo("ux-run-");
  const r = sh(dir, "run", "frontend", "--", "nosuchcmd-seisin");
  assert.equal(r.code, 127);
  assert.match(r.err, /seisin: "nosuchcmd-seisin" not found on the role's PATH/);
  assert.doesNotMatch(r.err, /env:/);
});

test("run: a missing runtime is fixed the way seisin was installed", async () => {
  const { installHint } = await import("../src/commands/run.js");
  assert.match(installHint("/usr/local/lib/node_modules/seisin/src/commands"), /npm install -g seisin/);
  assert.match(installHint("/home/me/app/node_modules/seisin/src/commands"), /installed in \/home\/me\/app; reinstall it there with: npm install seisin/);
  assert.match(installHint("/home/me/seisin/src/commands"), /npm install \(in \/home\/me\/seisin\)/);
});

/* ── 12. one line for every mistake ───────────────────────────────────────── */

test("an unknown command, flag, role or action is one line and exit 2", () => {
  const dir = demo();
  const typo = sh(dir, "chek");
  assert.equal(typo.code, 2);
  assert.match(typo.err, /seisin: unknown command "chek" — did you mean "check"\?/);
  assert.doesNotMatch(typo.all, /give each agent its own folders/, "no usage dump");

  const flag = sh(dir, "check", "--bogus");
  assert.equal(flag.code, 2);
  assert.match(flag.err, /unknown flag "--bogus" for check/);

  const role = sh(dir, "walls", "fronted");
  assert.equal(role.code, 2);
  assert.match(role.err, /unknown role "fronted" — did you mean "frontend"\?\n\s+known roles: frontend, backend, qa/);

  const action = sh(dir, "explain", "frontend", "delete", "x");
  assert.equal(action.code, 2);
  assert.match(action.err, /unknown action "delete" — use read, write or mcp/);
});

test("without a policy every command says so in one line", () => {
  const dir = boxed("ux-empty-");
  for (const cmd of [["check"], ["requests"], ["explain", "a", "read", "x"], ["log"]]) {
    const r = sh(dir, ...cmd);
    assert.equal(r.code, 2, cmd.join(" "));
    assert.equal(r.all.trim().split("\n").length, 1, `${cmd.join(" ")}:\n${r.all}`);
    assert.match(r.err, /no seisin\.toml found here or above/);
  }
});

/* ── 13. per-command help ─────────────────────────────────────────────────── */

test("each command's --help lists its flags, an example and its exit codes", () => {
  const dir = boxed("ux-help-");
  const want = {
    walls: ["--since", "--min", "--all"], explain: ["mcp"], scan: ["--all"], log: ["--limit", "--verdict"],
    run: ["--debug-env", "--observe", "--settings"], review: ["--min"], check: ["--verbose"], init: ["--force"],
  };
  for (const [cmd, words] of Object.entries(want)) {
    const r = sh(dir, cmd, "--help");
    assert.equal(r.code, 0, cmd);
    for (const w of words) assert.ok(r.out.includes(w), `${cmd} --help mentions ${w}:\n${r.out}`);
    assert.match(r.out, /examples:/);
    assert.match(r.out, /exit codes:/);
  }
});

test("log: a verdict is validated, and an empty filter says what the log does hold", async () => {
  const { append, logPath } = await import("../src/log.js");
  const dir = demo();
  append(logPath(dir), { role: "frontend", action: "write", target: "backend/x", verdict: "denied", owners: ["backend"] });
  const bad = sh(dir, "log", "--verdict", "nope");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /unknown verdict "nope" — use allowed, denied or observed/);
  const other = sh(dir, "log", "--role", "qa");
  assert.equal(other.code, 0);
  assert.match(other.out, /no entries for role qa — the log has 1 for frontend/);
});

test("review: wired but nothing allowed yet is said as that, not as 'run seisin wire'", async () => {
  const { append, logPath } = await import("../src/log.js");
  const dir = demo();
  append(logPath(dir), { role: "frontend", action: "write", target: "backend/x", verdict: "denied", owners: ["backend"] });
  assert.equal(sh(dir, "wire").code, 0);
  const r = sh(dir, "review");
  assert.match(r.out, /wired, but no allowed action logged yet/);
  assert.doesNotMatch(r.out, /Run `seisin wire`/);
});

/* ── 6, 11, 16. init ──────────────────────────────────────────────────────── */

function tree(prefix, files) {
  const dir = boxed(prefix);
  for (const f of files) {
    if (f.endsWith("/")) { mkdirSync(join(dir, f), { recursive: true }); continue; }
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

test("init on a blank repo proposes the folders that hold code, and declares a key dir that is there", () => {
  const dir = tree("ux-init-", ["web/src/a.ts", "api/main.py", "docs/a.md", "node_modules/x/i.js", ".tools/t.js", ".secrets/", ".gitignore"]);
  const r = sh(dir, "init");
  assert.equal(r.code, 0, r.all);
  const toml = readFileSync(join(dir, "seisin.toml"), "utf8");
  assert.match(toml, /\[roles\.web\]\nwrites = \["web\/\*\*"\]/);
  assert.match(toml, /\[roles\.api\]\nwrites = \["api\/\*\*"\]/);
  assert.doesNotMatch(toml, /src\/web|src\/api|roles\.docs|node_modules|tools/);
  assert.match(toml, /^\[keys\]\ndir = "\.secrets"/m);
  assert.match(toml, /Each role runs as its own process/);
  assert.match(toml, /subagent runs inside its parent's process/);
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.seisin\/$/m);
  assert.match(r.out, /added \.seisin\/ to \.gitignore/);
  assert.match(r.out, /earns its setup at two roles/);
  assert.equal(sh(dir, "check").code, 0, "the proposal loads");
});

test("init from CODEOWNERS makes one role per owner, with every path, and does not stop at eight", () => {
  const lines = ["/apps/web/ @org/web", "/lib/ @org/web", "* @org/all"];
  for (let i = 1; i <= 10; i++) lines.push(`/p${i}/ @o${i}`);
  const dir = tree("ux-init-", []);
  writeFileSync(join(dir, "CODEOWNERS"), lines.join("\n") + "\n");
  assert.equal(sh(dir, "init").code, 0);
  const toml = readFileSync(join(dir, "seisin.toml"), "utf8");
  assert.match(toml, /\[roles\.web\]\nwrites = \["apps\/web\/\*\*", "lib\/\*\*"\]/);
  assert.equal(toml.match(/^\[roles\./gm).length, 11);
});

test("a second init suggests --force, which keeps the old policy as .bak", () => {
  const dir = tree("ux-init-", ["app/a.js"]);
  assert.equal(sh(dir, "init").code, 0);
  writeFileSync(join(dir, "seisin.toml"), readFileSync(join(dir, "seisin.toml"), "utf8") + "# mine\n");
  const again = sh(dir, "init");
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists here\. seisin init --force replaces it/);
  const forced = sh(dir, "init", "--force");
  assert.equal(forced.code, 0, forced.all);
  assert.match(readFileSync(join(dir, "seisin.toml.bak"), "utf8"), /# mine/);
  assert.doesNotMatch(readFileSync(join(dir, "seisin.toml"), "utf8"), /# mine/);
});

test("init --from-observations with nothing observed says where observations come from", () => {
  const dir = demo();
  const r = sh(dir, "init", "--from-observations");
  assert.equal(r.code, 2);
  assert.match(r.err, /observations come from the hook: run `seisin wire`/);
  assert.match(r.err, /a plain shell command goes through no hook/);
  assert.match(r.err, /keys stay denied/);
});
