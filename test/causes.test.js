/**
 * The console's front page, as arithmetic.
 *
 * Each of these fixes a mistake the page actually made before it was looked
 * at on a real log — which is the only reason they are worth their lines.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { causesOf } from "../src/serve.js";
import { TOOLS } from "../src/mcp.js";
import { boxed } from "./_tmp.js";

const cfg = {
  root: "/repo",
  keyDirs: [],
  roles: {
    a: { name: "a", writes: ["src/**"], keys: [], keyEntries: [] },
    b: { name: "b", writes: ["deploy/**"], keys: [], keyEntries: [] },
  },
};

const denial = (role, target, action = "write") => ({ role, action, target, verdict: "denied", owners: [] });

test("the name rollup catches what the path grouping hides", () => {
  // The bug: six of the top seven causes were the same lock file in six
  // repositories, no single path above 17%, so the page concluded "no cause
  // dominates" — the arithmetic was right and the reading was backwards.
  const log = [];
  for (const repo of ["one", "two", "three", "four", "five", "six"])
    for (let i = 0; i < 20; i++) log.push(denial("a", `${repo}/.git/index.lock`));
  log.push(denial("a", "deploy/only-once.yml"));

  const f = causesOf(cfg, log);
  assert.ok(f.causes[0].share < 0.2, "no single PATH dominates, which is the trap");
  assert.equal(f.families[0].name, "index.lock");
  assert.equal(f.families[0].paths, 6);
  assert.ok(f.families[0].share > 0.9, "one NAME does dominate, which is the reading");
});

test("`distinct` is the real number of causes, not the length of the list shown", () => {
  // The page said "over 12 distinct paths" because it counted the list, which
  // is capped at twelve. The real number was 159. A wrong number stated
  // confidently is worse than no number.
  const log = [];
  for (let i = 0; i < 40; i++) log.push(denial("a", `deploy/file-${i}.yml`));
  const f = causesOf(cfg, log);
  assert.equal(f.distinct, 40);
  assert.equal(f.causes.length, 12, "the list is still capped");
});

test("a cause two of three roles still hit is still friction", () => {
  // `every` retired a live cause the moment one role got a grant. `some` —
  // here, a count — keeps it on the page for the roles it still blocks.
  const log = [denial("a", "deploy/x.yml"), denial("b", "deploy/x.yml")];
  const f = causesOf(cfg, log);
  assert.equal(f.causes[0].stillRefused, 1, "a is refused, b owns deploy/**");
  assert.deepEqual(f.causes[0].roles, ["a", "b"]);
});

test("a cause nobody is refused any more reports zero, and the page greys it", () => {
  const f = causesOf(cfg, [denial("b", "deploy/x.yml"), denial("b", "deploy/x.yml")]);
  assert.equal(f.causes[0].stillRefused, 0);
});

test("only refusals count — an allowed line is not friction", () => {
  const f = causesOf(cfg, [
    denial("a", "deploy/x.yml"),
    { role: "a", action: "write", target: "src/ok.ts", verdict: "allowed", owners: ["a"] },
  ]);
  assert.equal(f.total, 1);
});

test("an empty log answers nothing and claims nothing", () => {
  const f = causesOf(cfg, []);
  assert.equal(f.total, 0);
  assert.deepEqual(f.causes, []);
});

// ── the same arithmetic, through MCP ───────────────────────────────────────

test("the MCP exposes causes and walls, not only the raw log", () => {
  // `seisin_activity` hands an agent the events and asks it to re-derive the
  // grouping — without the policy, which is the half that makes the grouping
  // mean anything. A person opens the console; an agent calls these.
  const names = TOOLS.map((t) => t.name);
  for (const n of ["seisin_causes", "seisin_walls"]) assert.ok(names.includes(n), n);
});

test("every MCP tool says it is read-only, because granting never happens here", () => {
  for (const t of TOOLS) assert.match(t.description, /read-only/i, t.name);
});

test("anything the console derives is reachable over MCP", () => {
  // The rule in CONTRIBUTING, as a test, because a rule is the version of this
  // that people forget at 2am. `causes` and `walls` shipped in the console and
  // not in the server for a day: an assistant got the raw log and had to
  // re-derive the grouping without the policy.
  //
  // Only the DERIVED views. Raw passthrough (`log`, `toml`) is not analysis and
  // `seisin_activity` already covers the log.
  const DERIVED = ["causes", "walls"];
  const names = TOOLS.map((t) => t.name);
  for (const k of DERIVED)
    assert.ok(names.includes("seisin_" + k),
      `the console computes ${k} and no MCP tool exposes it`);
});

test("the time window narrows what comes from the log, and nothing else", async () => {
  const { state, sinceOf } = await import("../src/serve.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = boxed("window-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.a]\nwrites = ["src/**"]\n');
  mkdirSync(join(dir, ".seisin"));
  const line = (at, target) => JSON.stringify({ at, role: "a", action: "write", target, verdict: "denied", owners: [] });
  writeFileSync(join(dir, ".seisin", "log.jsonl"),
    [line("2026-09-20T10:00:00.000Z", "old/x.ts"), line("2026-09-23T10:00:00.000Z", "new/y.ts")].join("\n") + "\n");

  const all = state(join(dir, "seisin.toml"));
  assert.equal(all.causes.total, 2);
  assert.equal(all.roles[0].blocks, 2);

  const since = sinceOf("/api/state?since=2026-09-22T00:00:00.000Z");
  const recent = state(join(dir, "seisin.toml"), { since });
  assert.equal(recent.since, "2026-09-22T00:00:00.000Z");
  assert.equal(recent.causes.total, 1);
  assert.deepEqual(recent.log.map((e) => e.target), ["new/y.ts"]);
  assert.equal(recent.roles[0].blocks, 1, "the per-role count follows the window");

  assert.equal(sinceOf("/api/state"), null);
  assert.equal(sinceOf("/api/state?since=yesterday-ish"), null, "a bad filter shows everything");
});

test("'all' is never smaller than a window inside it", async () => {
  const { state } = await import("../src/serve.js");
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = boxed("window-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.a]\nwrites = ["src/**"]\n');
  mkdirSync(join(dir, ".seisin"));
  // More than the old 4000-line cap, all of it recent.
  const at = new Date().toISOString();
  const lines = Array.from({ length: 4500 }, (_, i) =>
    JSON.stringify({ at, role: "a", action: "write", target: `docs/f${i % 50}.md`, verdict: "denied", owners: [] }));
  writeFileSync(join(dir, ".seisin", "log.jsonl"), lines.join("\n") + "\n");
  const all = state(join(dir, "seisin.toml"));
  const month = state(join(dir, "seisin.toml"), { since: new Date(Date.now() - 30 * 864e5).toISOString() });
  assert.equal(month.causes.total, 4500);
  assert.equal(all.causes.total, 4500, "'all' was capped at the last 4000 lines");
  assert.equal(all.roles[0].blocks, 4500);
});

// ── where a refused path stands NOW ────────────────────────────────────────
//
// The console's "N are on paths no role owns" was computed from the owners
// each log line recorded the day of the refusal. Measured on one deployment:
// 1,178 of 1,486 paths shown as nobody's; against that day's policy, 316.
// Every grant made since, every protected surface, every port and every path
// outside the repository was being counted as a decision somebody owed.

async function repoWithLog(toml, lines) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = boxed("standing-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  // Exists, so it is protected on Linux as well, where only existing control
  // files are.
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  writeFileSync(join(dir, ".seisin", "log.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, path: join(dir, "seisin.toml") };
}

const TWO = '[roles.a]\nwrites = ["src/**"]\n\n[roles.b]\nwrites = ["deploy/**"]\n';
const refused = (target, extra = {}) => ({ at: "2026-09-28T10:00:00.000Z", role: "a", action: "write", kind: "file", target, verdict: "denied", owners: [], ...extra });
const MIXED = [
  refused("deploy/x.yml"),                                   // logged as nobody's; b owns it now
  refused(".claude/settings.json"),                          // protected, for every role
  refused("tcp:8001", { action: "connect", kind: "network" }),
  refused("keys", { action: "read", kind: "key" }),
  refused("/definitely/not/in/the/repo/x.lock"),             // outside every territory
  refused("legacy/x.ts"),                                    // the one real hole
];

test("unowned is read from the policy as it is now, not from the log line", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { path } = await repoWithLog(TWO, MIXED);
  const f = causesOf(loadConfig(path), MIXED);
  assert.equal(f.unowned, 1, "only legacy/x.ts is nobody's");
  assert.deepEqual(
    Object.fromEntries(Object.entries(f.standing).map(([k, v]) => [k, v.paths])),
    { unowned: 1, owned: 1, protected: 1, outside: 3 });
  const deploy = f.causes.find((c) => c.target === "deploy/x.yml");
  assert.equal(deploy.standing, "owned");
  assert.deepEqual(deploy.owners, ["b"], "owners are today's");
  assert.deepEqual(deploy.ownersThen, [], "what the log said is kept, as evidence");
  const guarded = f.causes.find((c) => c.target === ".claude/settings.json");
  assert.equal(guarded.standing, "protected");
  assert.ok(guarded.why, "a protected cause says why");
});

test("`seisin review` and the console mean the same thing by unowned", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { review } = await import("../src/review.js");
  const { path } = await repoWithLog(TWO, MIXED);
  const cfg = loadConfig(path);
  // review skipped keys and ports and counted protected paths; the console
  // counted all four. One word, two numbers.
  assert.deepEqual(review(cfg).unowned.map(({ where, times }) => ({ where, times })), [{ where: "legacy", times: 1 }]);
  assert.equal(causesOf(cfg, MIXED).unowned, 1);
});

test("the MCP reads the same window as the console, not the last 4000 lines", async () => {
  const { HANDLERS } = await import("../src/mcp.js");
  const { state } = await import("../src/serve.js");
  const lines = Array.from({ length: 4500 }, (_, i) => refused(`legacy/f${i % 50}.ts`));
  const { dir, path } = await repoWithLog(TWO, lines);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const m = HANDLERS.seisin_causes({});
    assert.equal(m.total, 4500);
    assert.equal(m.total, state(path).causes.total, "an agent and a person see the same log");
    assert.equal(m.unowned, 50);
    const since = HANDLERS.seisin_causes({ since: "2026-09-29" });
    assert.equal(since.total, 0, "since narrows the window, like the console's");
  } finally { process.chdir(cwd); }
});

test("a path's standing is remembered while the policy is the same, and not after", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { standingOf } = await import("../src/owners.js");
  const { writeFileSync } = await import("node:fs");
  const { path } = await repoWithLog(TWO, MIXED);
  const e = { kind: "file", target: "legacy/x.ts" };
  const first = standingOf(loadConfig(path))(e);
  // The console reloads the config every two seconds; a new object for the
  // same file is the same policy.
  assert.equal(standingOf(loadConfig(path))(e), first, "same policy, same answer, not recomputed");
  assert.equal(first.kind, "unowned");
  writeFileSync(path, TWO + '\n[roles.c]\nwrites = ["legacy/**"]\n');
  const after = standingOf(loadConfig(path))(e);
  assert.equal(after.kind, "owned", "a grant is seen at once, not after the memory expires");
  assert.deepEqual(after.owners, ["c"]);
});
