/**
 * One policy, a role per agent, and a run that can only take away from its role.
 * Which of these hold is a question for the kernel, so most of them ask it.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxed, CLI, sandboxSkip } from "./_tmp.js";
import { coveredBy, effectiveConfig, narrowingOf } from "../src/narrow.js";
import { expandVars, setVars } from "../src/vars.js";
import { loadConfig } from "../src/config.js";
import { sameAcrossRuns } from "../src/runs.js";
import { setStateDir } from "../src/state.js";
import { editPolicy, policyLockBase } from "../src/requests.js";

const skip = sandboxSkip();
const POLICY = `
[runtime]
writes = []
[roles.planner]
writes = []
reads = ["$RUN/config"]
[roles.executor]
writes = ["src/**"]
never_writes = ["src/never.ts"]
reads = ["$RUN/config"]
`;

let repo, inst;
before(() => {
  inst = boxed("narrow-inst-");
  repo = boxed("narrow-repo-");
  for (const d of ["src/api", "src/web", "docs"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(inst, "seisin.toml"), POLICY);
  mkdirSync(join(inst, "run", "config"), { recursive: true });
});

const seisin = (args, cwd = repo) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const run = (role, flags, script, cwd = repo) => seisin(
  ["run", role, "--policy", join(inst, "seisin.toml"), "--state-dir", join(inst, "state"), "--var", `RUN=${join(inst, "run")}`,
    ...flags, "--agent", "none", "--", "/bin/sh", "-c", script], cwd);

/* ── what covers what: a wrong yes is a run with more than the policy says ── */

test("a glob is inside a ceiling only when that is certain", () => {
  assert.ok(coveredBy("anything/at/all.ts", "**"));
  assert.ok(coveredBy("src/api/**", "src/**"));
  assert.ok(coveredBy("src/api/a.ts", "src/**"));
  assert.ok(coveredBy("src/*.ts", "src/**"));
  assert.ok(coveredBy("src/a.ts", "src/a.ts"));
  assert.ok(coveredBy("src/a/b.ts", "src/a"));
  assert.ok(coveredBy("src", "src/**"), "src/** matches src itself");
  assert.equal(coveredBy("docs/**", "src/**"), false);
  assert.equal(coveredBy("src-old/a", "src/**"), false, "a prefix of the text is not a parent");
  assert.equal(coveredBy("**", "src/**"), false);
  assert.equal(coveredBy("*/a.ts", "src/**"), false, "a head that is not literal is not certain");
  assert.equal(coveredBy("src/a.ts", "src/*.ts"), false, "a ceiling with a wildcard in it is not worked out");
  assert.equal(coveredBy("src/**", "src/a.ts"), false);
});

test("--only and --deny are read off the line, repeatable, and need a value", () => {
  assert.deepEqual(narrowingOf(["--only", "a", "--deny", "b", "--only", "c"]), { only: ["a", "c"], deny: ["b"] });
  assert.throws(() => narrowingOf(["--only"]), /needs a path/);
  assert.throws(() => narrowingOf(["--only", "--deny", "x"]), /needs a path/);
});

/* ── variables: only where a role reads or connects, never what the parent runs ── */

test("--var fills what a role reads and connects to, and a port becomes a number", () => {
  const p = { runtime: { writes: ["$RUN/tmp"] }, roles: { a: { reads: ["$RUN/x", "/fixed"], local_ports: ["$P"], verify: ["/bin/sh", "$RUN/v.sh"] } } };
  assert.deepEqual(expandVars(p, new Map([["RUN", "/r"], ["P", "8769"]])), []);
  assert.deepEqual(p.runtime.writes, ["/r/tmp"]);
  assert.deepEqual(p.roles.a.reads, ["/r/x", "/fixed"]);
  assert.deepEqual(p.roles.a.local_ports, [8769]);
  assert.deepEqual(p.roles.a.verify, ["/bin/sh", "/r/v.sh"]);
});

test("a variable decides nothing the parent executes, nor a role's territory", () => {
  const vars = new Map([["X", "/evil"]]);
  const p = {
    keys: { providers: { v: { command: ["$X/read"] } } },
    sandbox: { providers: { b: { command: ["$X/box"], check: ["$X/check"] } } },
    network: { allow: ["$X"] },
    roles: { a: { writes: ["$X/**"], network: ["$X"], keys: ["$X"] } },
  };
  const before = JSON.stringify(p);
  expandVars(p, vars);
  assert.equal(JSON.stringify(p), before);
});

test("what nobody gave is left out with a name, and a command missing a word goes whole", () => {
  const p = { roles: { a: { reads: ["$RUN/x", "/fixed"], verify: ["/bin/sh", "$RUN/v.sh"] } } };
  const unbound = expandVars(p, new Map());
  assert.deepEqual(p.roles.a.reads, ["/fixed"]);
  assert.equal(p.roles.a.verify, undefined);
  assert.deepEqual(unbound.map((u) => [u.name, u.role]), [["RUN", "a"], ["RUN", "a"]]);
});

test("--var refuses a bad name, an empty value and two different values", () => {
  assert.throws(() => setVars(["run=/x"]), /capitals/);
  assert.throws(() => setVars(["RUN"]), /needs a value/);
  assert.throws(() => setVars(["RUN=/a\n/b"]), /one line/);
  assert.throws(() => setVars(["RUN=/a", "RUN=/b"]), /different values/);
  setVars([]);
});

test("a policy with a variable still loads for whatever has no run to ask, and check says so", () => {
  const cfg = loadConfig(join(inst, "seisin.toml"), undefined, { root: repo });
  assert.deepEqual(cfg.roles.planner.reads ?? [], []);
  const r = seisin(["check", "--policy", join(inst, "seisin.toml")]);
  assert.match(r.stdout + r.stderr, /no value for \$RUN/);
});

/* ── a run that cannot be what was asked does not start ── */

test("a run does not start with a value missing for its role", () => {
  const r = seisin(["run", "executor", "--policy", join(inst, "seisin.toml"), "--state-dir", join(inst, "state"),
    "--agent", "none", "--", "/bin/sh", "-c", "touch src/started"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /\$RUN .*has no value/);
  assert.equal(existsSync(join(repo, "src/started")), false);
});

test("--only outside the role is refused before anything runs, and --only never widens", () => {
  for (const g of ["docs/**", "**", "../elsewhere/**", "/etc/**"]) {
    const r = run("executor", ["--only", g], "touch ran");
    assert.equal(r.status, 2, `${g}: ${r.stderr}`);
    assert.equal(existsSync(join(repo, "ran")), false);
  }
  const none = run("planner", ["--only", "src/**"], "true");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /cannot write that/);
});

test("--observe and a narrowing are refused together: one opens what the other closes", () => {
  const r = run("executor", ["--observe", "--only", "src/api/**"], "true");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /choose one/);
});

/* ── the kernel ── */

const OUT = (p) => `(echo x > ${p}) 2>/dev/null && echo "yes ${p}" || echo "no ${p}"`;

test("the kernel holds a narrowed run to what it was narrowed to", { skip }, () => {
  const r = run("executor", ["--only", "src/api/**", "--deny", "src/api/held.ts"],
    [OUT("src/api/a.ts"), OUT("src/api/held.ts"), OUT("src/never.ts"), OUT("src/web/w.ts"), OUT("docs/d.md")].join("; "));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /yes src\/api\/a\.ts/);
  for (const p of ["src/api/held.ts", "src/never.ts", "src/web/w.ts", "docs/d.md"]) assert.match(r.stdout, new RegExp(`no ${p}`));
});

test("without --only the run has its whole role, and nothing else", { skip }, () => {
  const r = run("executor", [], [OUT("src/web/w2.ts"), OUT("docs/d2.md")].join("; "));
  assert.match(r.stdout, /yes src\/web\/w2\.ts/);
  assert.match(r.stdout, /no docs\/d2\.md/);
});

test("the role a run names is the one it gets: a planner writes nothing", { skip }, () => {
  const r = run("planner", [], OUT("src/p.ts"));
  assert.match(r.stdout, /no src\/p\.ts/);
});

test("a role that may write everything cannot write the policy it came from, nor what the run holds under", { skip }, () => {
  const dir = boxed("narrow-self-");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "seisin.toml"), '[runtime]\nwrites = []\n[roles.all]\nwrites = ["**"]\n');
  const r = seisin(["run", "all", "--deny", "src/held.ts", "--var", "A=/x", "--agent", "none", "--", "/bin/sh", "-c",
    [OUT("seisin.toml"), OUT(".seisin/policies/x.json"), OUT("src/ok.ts")].join("; ")], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no seisin\.toml/);
  assert.match(r.stdout, /no \.seisin\/policies\/x\.json/);
  assert.match(r.stdout, /yes src\/ok\.ts/);
  assert.match(readFileSync(join(dir, "seisin.toml"), "utf8"), /roles\.all/);
});

/* ── what is left behind ── */

test("the log says what the run came from, what it took away, and which variables; the file is the hash", { skip }, () => {
  const state = join(boxed("narrow-log-"), ".seisin");
  const r = seisin(["run", "executor", "--policy", join(inst, "seisin.toml"), "--state-dir", state, "--run-id", "RUN1",
    "--var", `RUN=${join(inst, "run")}`, "--only", "src/api/**", "--agent", "none", "--", "/bin/sh", "-c", "echo x > docs/refused; true"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(join(state, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const n = lines.find((e) => e.event === "narrowed");
  assert.ok(n, "a narrowed line");
  assert.deepEqual(n.only, ["src/api/**"]);
  assert.deepEqual(n.vars, ["RUN"]);
  assert.equal(n.run, "RUN1");
  assert.equal(n.source, join(inst, "seisin.toml"));
  assert.match(n.sourcePolicy, /^[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(n).includes(join(inst, "run")), false, "the log names a variable, not its value");
  const files = readdirSync(join(state, "policies"));
  assert.deepEqual(files, [`${n.policy}.json`]);
  const denied = lines.find((e) => e.verdict === "denied" && e.target === "docs/refused");
  assert.equal(denied?.policy, n.policy, "a denial joins to the file that held at the time");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "policies", files[0]), "utf8")).roles.executor.writes, ["src/api/**"]);
  assert.equal(seisin(["log", "verify", "--policy", join(inst, "seisin.toml"), "--state-dir", state]).status, 0);
});

test("the same run twice is one file; two different runs never share one", () => {
  const state = boxed("narrow-hash-");
  setStateDir(state);
  setVars([`RUN=/a`]);
  const cfg = loadConfig(join(inst, "seisin.toml"), undefined, { root: repo });
  const a = effectiveConfig(cfg, "executor", { only: ["src/api/**"], deny: [] });
  const b = effectiveConfig(cfg, "executor", { only: ["src/api/**"], deny: [] });
  const c = effectiveConfig(cfg, "executor", { only: ["src/web/**"], deny: [] });
  assert.equal(a.config.path, b.config.path);
  assert.notEqual(a.config.path, c.config.path);
  assert.equal(a.config.root, repo, "still rooted where the run is");
  setVars([]);
  // setStateDir hands itself to everything this process starts; no later test may inherit it.
  delete process.env.SEISIN_STATE_DIR;
});

test("a run with nothing to work out holds under the policy itself, and writes nothing new", () => {
  const dir = boxed("narrow-plain-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.a]\nwrites = ["src/**"]\n');
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const held = effectiveConfig(cfg, "a", { only: [], deny: [] });
  assert.equal(held.config, cfg);
  assert.equal(held.narrowed, null);
});

/* ── across runs ── */

test("a path under the run's own folder reads the same in every run", () => {
  assert.equal(sameAcrossRuns("/d/turns/01ABC/home/.claude/plugins", "01ABC"), "$RUN/home/.claude/plugins");
  assert.equal(sameAcrossRuns("/d/turns/01ABC", "01ABC"), "$RUN");
  assert.equal(sameAcrossRuns("/d/other/home", "01ABC"), "/d/other/home");
  assert.equal(sameAcrossRuns("/d/01ABCD/x", "01ABC"), "/d/01ABCD/x", "a longer name is another folder");
});

test("review --runs --json sums the runs for a program, and a narrowed run reads as a run", { skip }, () => {
  const dir = boxed("narrow-runs-");
  for (const id of ["R1", "R2"]) {
    const folder = join(dir, id);
    const home = join(folder, "home");
    mkdirSync(home, { recursive: true });
    const r = seisin(["run", "executor", "--policy", join(inst, "seisin.toml"), "--state-dir", join(folder, ".seisin"), "--run-id", id,
      "--var", `RUN=${join(inst, "run")}`, "--only", "src/api/**", "--agent", "none", "--", "/bin/sh", "-c", "echo x > docs/wall.md; true"]);
    assert.equal(r.status, 0, r.stderr);
  }
  const r = seisin(["review", "--runs", dir, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const view = JSON.parse(r.stdout);
  assert.equal(view.total, 2);
  assert.equal(view.runs.every((x) => x.outcome !== "unread"), true, JSON.stringify(view.runs.map((x) => x.error)));
  const wall = view.causes.find((c) => c.target === "docs/wall.md");
  assert.equal(wall?.runs, 2);
  assert.equal(seisin(["review", "--runs", dir]).status, 2, "only for a program");
});

/* ── one repo, one record ── */

function repoWithWorktree(prefix) {
  const dir = boxed(prefix);
  const main = join(dir, "main");
  mkdirSync(join(main, "src"), { recursive: true });
  const git = (...a) => spawnSync("git", a, { cwd: main, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(main, "seisin.toml"), '[runtime]\nwrites = []\n[roles.api]\nwrites = ["src/**"]\n[roles.docs]\nwrites = ["docs/**"]\n');
  writeFileSync(join(main, ".gitignore"), ".seisin/\n");
  writeFileSync(join(main, "src/a"), "a");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  git("worktree", "add", "-q", "../wt", "-b", "t");
  return { main, wt: join(dir, "wt"), git };
}

test("what a role asked for in a worktree is there from the checkout, and outlives the worktree", { skip }, () => {
  const { main, wt, git } = repoWithWorktree("narrow-wt-");
  mkdirSync(join(wt, "docs"));
  const r = seisin(["run", "api", "--agent", "none", "--", "/bin/sh", "-c", "echo x > docs/d; true"], wt);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(wt, ".seisin")), false, "nothing of seisin's in the worktree");
  assert.match(seisin(["requests"], main).stdout, /api wants write on docs/);
  git("worktree", "remove", "--force", wt);
  assert.match(seisin(["requests"], main).stdout, /api wants write on docs/);
  assert.match(seisin(["log"], main).stdout, /docs\/d/);
});

test("a role in a worktree cannot write the record it now shares with the checkout", { skip }, () => {
  const { main, wt } = repoWithWorktree("narrow-wt2-");
  const r = seisin(["run", "api", "--agent", "none", "--", "/bin/sh", "-c", OUT(join(main, ".seisin/log.jsonl"))], wt);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^no /m);
});

test("a policy in a folder inside a worktree keeps its record beside it, and writes nothing in the main checkout", { skip }, () => {
  const { main, wt } = repoWithWorktree("narrow-wt3-");
  const sub = join(wt, "sub");
  mkdirSync(join(sub, "src"), { recursive: true });
  writeFileSync(join(sub, "seisin.toml"), '[runtime]\nwrites = []\n[roles.a]\nwrites = ["src/**"]\n');
  const r = seisin(["run", "a", "--agent", "none", "--", "/bin/sh", "-c", "echo x > other; true"], sub);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(main, "sub")), false);
  assert.equal(existsSync(join(sub, ".seisin")), true);
});

/* ── one policy is one thing to lock ── */

test("two grants on one policy take one lock, whatever state folder each was given", () => {
  const dir = boxed("narrow-lock-");
  const policy = join(dir, "seisin.toml");
  writeFileSync(policy, '[roles.a]\nwrites = ["a/**"]\n[roles.b]\nwrites = ["b/**"]\n');
  const mine = loadConfig(policy, undefined, { root: boxed("narrow-lock-a-") });
  const other = loadConfig(policy, undefined, { root: boxed("narrow-lock-b-") });
  setStateDir(boxed("narrow-lock-sa-"));
  const a = policyLockBase(mine);
  setStateDir(boxed("narrow-lock-sb-"));
  const b = policyLockBase(other);
  delete process.env.SEISIN_STATE_DIR;
  assert.equal(a, b);
  assert.equal(a, join(dir, ".seisin", "policy"));
  writeFileSync(`${a}.lock`, `${process.pid} holder\n`);
  assert.throws(() => editPolicy(other, (t) => ({ toml: t + "\n", changed: true }), { waitMs: 50 }), /lock|in progress|busy/i);
  rmSync(`${a}.lock`);
  assert.equal(readFileSync(policy, "utf8").endsWith("\n\n"), false, "nothing written while another edit held it");
});

/* ── the MCP server ── */

test("seisin mcp --policy serves that policy, from wherever it was started", () => {
  const dir = boxed("narrow-mcp-");
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "seisin_explain",
    arguments: { role: "planner", action: "write", target: "src/a" } } }) + "\n";
  const r = spawnSync(process.execPath, [CLI, "mcp", "--policy", join(inst, "seisin.toml")], { cwd: dir, input: call, encoding: "utf8" });
  const answer = JSON.parse(r.stdout.trim().split("\n")[0]);
  assert.equal(answer.result.isError, undefined, r.stdout);
  assert.equal(answer.result.structuredContent.allowed, false);
});
