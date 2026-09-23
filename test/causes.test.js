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

test("every MCP tool says it is read-only, because approving never happens here", () => {
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
  const box = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
  mkdirSync(box, { recursive: true });
  const dir = mkdtempSync(join(box, "window-"));
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
