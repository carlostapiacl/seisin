/**
 * Three things a caller that runs roles needs from seisin, and did not have:
 *
 *   1. A denial it asked for is not a request. An orchestrator that probes the
 *      sandbox with a write it expects to be denied got that probe back as a
 *      request — queued, notified, and routed to whichever role owns the root.
 *   2. A role that is a pipeline phase, not a worker, is never handed work.
 *   3. `check` says when a repo, or part of a territory, sits inside the
 *      scratch every role is given — before a run shows it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { intake } from "../src/intake.js";
import { pending, requestsPath, record, queueOf } from "../src/requests.js";
import { decideHandoff, toAgent, describeHandoff } from "../src/handoff.js";
import { expectedDenials, handoffOf, resolveSrt } from "../src/commands/run.js";
import { samePath } from "../src/paths.js";
import { inspect } from "../src/inspect.js";
import { walls } from "../src/walls.js";
import { causesOf } from "../src/views.js";
import { scratch, boxed, repoWith, CLI } from "./_tmp.js";

const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };

function setup(toml = '[roles.prepare]\nwrites = ["**"]\nhandoff = false\n\n[roles.web]\nwrites = ["web/**"]\n') {
  const dir = scratch("seisin-expect-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  const config = loadConfig(join(dir, "seisin.toml"));
  const log = join(dir, ".seisin", "log.jsonl");
  const lines = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const queue = () => pending(requestsPath(dir));
  return { dir, config, lines, queue };
}

const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

/* ── 1. a denial the caller expects ────────────────────────────────────── */

test("an expected kernel denial is logged as expected and files no request", () => {
  const { config, lines, queue } = setup('[roles.web]\nwrites = ["web/**"]\n');
  let notified = 0;
  const take = intake({ config, role: "web", runId: "r", settings, notify: { maybe: () => notified++ },
    expectDenied: [".canary-1f2e"] });
  take.fromKernel({ action: "write", path: join(config.root, ".canary-1f2e"), operation: "file-write-create" });
  assert.deepEqual(queue(), []);
  assert.equal(notified, 0);
  const [line] = lines();
  assert.equal(line.verdict, "denied");
  assert.equal(line.target, ".canary-1f2e");
  assert.equal(line.expected, true);
  assert.equal(take.stats.probes, 1);
});

test("an expected path is not a wildcard: a denial on any other path is still a request", () => {
  const { config, lines, queue } = setup('[roles.web]\nwrites = ["web/**"]\n');
  const take = intake({ config, role: "web", runId: "r", settings, expectDenied: [".canary-1f2e"] });
  // Same directory, a neighbour, a child, and the directory itself.
  for (const p of [".canary-1f2f", "notes.md", ".canary-1f2e/x", "."])
    take.fromKernel({ action: "write", path: join(config.root, p), operation: "file-write-create" });
  // Every one of the four was asked (the child under its own directory's id).
  assert.equal(queue().reduce((n, q) => n + q.times, 0), 4);
  assert.ok(lines().every((l) => l.expected === undefined));
  assert.equal(take.stats.probes, 0);
});

test("an expected path is matched however it is spelled: relative, ./, absolute, through the symlinked root", () => {
  const { config } = setup('[roles.web]\nwrites = ["web/**"]\n');
  const want = samePath(config, "probe/x.txt");
  for (const p of ["./probe/x.txt", "probe/./x.txt", "probe/x.txt/", join(config.root, "probe", "x.txt"),
    join(realpathSync(config.root), "probe", "x.txt")])
    assert.equal(samePath(config, p), want, p);
  assert.notEqual(samePath(config, "probe/x.txt2"), want);
});

test("the hook's request for an expected path is dropped by the parent, and its log line marked", () => {
  // The hook runs inside and never suppresses anything; the parent, which holds
  // the list, does — the same check on both of intake's sources.
  const { config, lines, queue } = setup('[roles.web]\nwrites = ["web/**"]\n');
  const take = intake({ config, role: "web", runId: "r", settings, expectDenied: [join(config.root, "probe.txt")] });
  take.fromHook("log", { tool: "Write", action: "write", target: "probe.txt", verdict: "denied" });
  take.fromHook("requests", { action: "write", target: "probe.txt" });
  assert.deepEqual(queue(), []);
  assert.equal(lines()[0].expected, true);
  // A line the hook calls denied for a path the parent says is allowed is not
  // marked: the hook's word alone does not make a line expected.
  const take2 = intake({ config, role: "web", runId: "r", settings, expectDenied: ["web/a.ts"] });
  take2.fromHook("log", { tool: "Write", action: "write", target: "web/a.ts", verdict: "denied" });
  assert.equal(lines()[1].expected, undefined);
  assert.equal(lines()[1].disputed, "allowed");
  take.fromHook("requests", { action: "write", target: "other.txt" });
  assert.equal(queue().length, 1);
});

test("walls, causes and review leave the caller's probes out", () => {
  const { config } = setup('[roles.web]\nwrites = ["web/**"]\n');
  const at = new Date().toISOString();
  const probe = { at, role: "web", action: "write", target: "probe.txt", verdict: "denied", expected: true };
  const real = { at, role: "web", action: "write", target: "api/x.ts", verdict: "denied" };
  const entries = [probe, probe, probe, real, real];
  assert.deepEqual(walls(config, "web", { entries }).map((w) => w.target), ["api/x.ts"]);
  assert.deepEqual(causesOf(config, entries).causes.map((c) => c.target), ["api/x.ts"]);
});

test("--expect-denied: repeatable, a path and not a pattern, and it needs a value", () => {
  assert.deepEqual(expectedDenials(["--expect-denied", "a", "--observe", "--expect-denied", "/abs/b"]), ["a", "/abs/b"]);
  assert.deepEqual(expectedDenials(["--observe"]), []);
  assert.throws(() => expectedDenials(["--expect-denied", "*.canary"]), /a path, not a pattern/);
  assert.throws(() => expectedDenials(["--expect-denied", "probe/**"]), /a path, not a pattern/);
  assert.throws(() => expectedDenials(["--expect-denied"]), /usage: .*--expect-denied <path>/);
  assert.throws(() => expectedDenials(["--expect-denied", "--observe"]), /usage/);
});

test("CLI: run --help names --expect-denied, and a pattern is refused before anything starts", () => {
  const { dir } = setup('[roles.web]\nwrites = ["web/**"]\n');
  const help = cli(["run", "--help"], dir);
  assert.match(help.stdout, /--expect-denied <path>/);
  // Without `--`: the value is taken as the flag's, not as the command.
  const r = cli(["run", "web", "--expect-denied", "probe*", "true"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /a path, not a pattern/);
  assert.ok(!existsSync(join(dir, ".seisin", "log.jsonl")));
});

const kernelSkip = resolveSrt() === null ? "sandbox runtime not installed"
  : process.platform !== "darwin" ? "kernel denials are read on macOS only" : false;

test("kernel: a run probing an expected path queues only the other denial", { skip: kernelSkip }, () => {
  // Under the home (test/.sandbox-box), never the temp dir: every role writes
  // scratch, and a repo there would let the probe through.
  const dir = repoWith("expect-", '[roles.web]\nwrites = ["web/**"]\n', ["web/"]);
  const r = spawnSync(process.execPath, [CLI, "run", "web", "--expect-denied", "probe-a.txt", "--",
    "sh", "-c", "echo x > probe-a.txt; echo y > probe-b.txt; true"], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(dir, "probe-a.txt")) && !existsSync(join(dir, "probe-b.txt")), "both writes were denied");
  const denied = readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l)).filter((e) => e.verdict === "denied");
  const a = denied.find((e) => e.target === "probe-a.txt");
  const b = denied.find((e) => e.target === "probe-b.txt");
  assert.ok(a && b, JSON.stringify(denied));
  assert.equal(a.expected, true);
  assert.equal(b.expected, undefined);
  // One request, and it is the other path's: the probe filed nothing.
  const q = pending(requestsPath(dir));
  assert.equal(q.length, 1);
  assert.equal(q[0].times, 1);
  assert.equal(q[0].firstTarget ?? q[0].target, "probe-b.txt");
  assert.match(r.stderr, /1 of them expected by the caller \(--expect-denied\)/);
});

/* ── 2. a role that is not handed work ─────────────────────────────────── */

test("handoff = false: validated like every other role key", () => {
  const dir = scratch("seisin-handoff-key-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.prepare]\nwrites = ["**"]\nhandoff = "no"\n');
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /roles\.prepare\.handoff must be true or false/);
  writeFileSync(join(dir, "seisin.toml"), '[roles.prepare]\nwrites = ["**"]\nhandoff = false\n\n[roles.web]\nwrites = ["web/**"]\n');
  const c = loadConfig(join(dir, "seisin.toml"));
  assert.equal(c.roles.prepare.handoff, false);
  assert.equal(c.roles.web.handoff, true);
  assert.deepEqual(c.roles.prepare.unknownKeys, []);
});

test("the only owner takes no handed work: a person decides, and says why", () => {
  const { config } = setup();
  const d = decideHandoff({ request: { role: "web", action: "write", target: ".canary" }, config });
  assert.equal(d.type, "human");
  assert.equal(d.reason, "no-receiver");
  assert.deepEqual(d.owners, ["prepare"]);
  assert.match(describeHandoff(d), /a person decides: prepare owns this and takes no handed work \(handoff = false\)/);
  const told = toAgent(d, { target: ".canary", role: "web" });
  assert.match(told, /\.canary belongs to prepare\. It is not web's to change\./);
  assert.match(told, /prepare does not take handed work, so a person decides who takes it/);
});

test("with other owners, the choice is made among them by the existing rule", () => {
  const { config } = setup('[roles.prepare]\nwrites = ["**"]\nhandoff = false\n\n[roles.api]\nwrites = ["api/**"]\n\n' +
    '[roles.docs]\nwrites = ["api/**", "docs/**"]\n\n[roles.web]\nwrites = ["web/**"]\n');
  // One receiver left: routed to it, with every owner still named.
  const one = decideHandoff({ request: { role: "web", action: "write", target: "docs/x.md" }, config });
  assert.equal(one.type, "route");
  assert.equal(one.role, "docs");
  assert.deepEqual(one.owners.sort(), ["docs", "prepare"]);
  assert.deepEqual(one.receivers, ["docs"]);
  // Two receivers left: a person decides between them, as before.
  const two = decideHandoff({ request: { role: "web", action: "write", target: "api/x.ts" }, config });
  assert.equal(two.type, "human");
  assert.equal(two.reason, "ambiguous");
  assert.deepEqual(two.receivers.sort(), ["api", "docs"]);
  assert.match(describeHandoff(two), /more than one role owns this \(api, docs\)/);
  // Without any handoff = false the decision is unchanged and carries no receivers.
  const { config: plain } = setup('[roles.api]\nwrites = ["api/**"]\n\n[roles.web]\nwrites = ["web/**"]\n');
  const route = decideHandoff({ request: { role: "web", action: "write", target: "api/x.ts" }, config: plain });
  assert.equal(route.type, "route");
  assert.equal(route.receivers, undefined);
});

test("seisin requests says it, and run --handoff to the marked role is refused", () => {
  const { dir, config } = setup();
  record(requestsPath(dir), { role: "web", action: "write", target: ".canary", owners: ["prepare"] });
  const [q] = queueOf(config);
  assert.equal(q.handoff.reason, "no-receiver");
  const shown = cli(["requests"], dir);
  assert.match(shown.stdout, /a person decides: prepare owns this and takes no handed work/);
  assert.throws(() => handoffOf(config, "prepare", ["--handoff", q.key]), /prepare does not take handed work \(handoff = false/);
  const r = cli(["run", "prepare", "--handoff", q.key, "--", "true"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not take handed work/);
});

/* ── 3. check: a root, or a territory, inside the scratch every role gets ─ */

test("check: a repo inside the temp dir is writable by every role, said with the fix", () => {
  const root = join(realpathSync(tmpdir()), "algun-repo");
  const cfg = { root, path: "x", keyDirs: [], roles: { web: { name: "web", writes: ["web/**"], keys: [], env: [] } } };
  const w = inspect(cfg, null, "x").warnings.find((x) => x.kind === "scratch");
  assert.ok(w);
  assert.match(w.headline, /every role can write the whole repo/);
  assert.match(w.detail, /Move it out of .*, or set \[runtime\] writes/);
});

test("check: the scratch is the policy's, not the default list", () => {
  const root = join(realpathSync(tmpdir()), "algun-repo");
  const base = { root, path: "x", keyDirs: [], roles: { web: { name: "web", writes: ["web/**"], keys: [], env: [] } } };
  // `[runtime] writes` that leaves the temp dirs out: nothing to say.
  assert.ok(!inspect({ ...base, runtimeWrites: ["~/.cache"] }, null, "x").warnings.some((x) => x.kind === "scratch"));
  // `isolate = "home"`: each role gets its own home, not the shared temp dir.
  assert.ok(!inspect({ ...base, isolate: "home" }, null, "x").warnings.some((x) => x.kind === "scratch"));
});

test("check: a writes entry that resolves into scratch is every role's", () => {
  const dir = boxed("scratch-link-");
  const out = scratch("seisin-out-");
  symlinkSync(out, join(dir, "out"));
  writeFileSync(join(dir, "seisin.toml"), '[roles.build]\nwrites = ["out/**"]\n\n[roles.web]\nwrites = ["web/**"]\n');
  const w = inspect(loadConfig(join(dir, "seisin.toml")), null, "x").warnings.filter((x) => x.kind === "territory-in-scratch");
  assert.equal(w.length, 1);
  assert.match(w[0].headline, /every role can write build's out\/\*\*: it resolves to .*seisin-out-/);
  // The repo itself is not in scratch, so the whole-repo warning is not given.
  assert.ok(!inspect(loadConfig(join(dir, "seisin.toml")), null, "x").warnings.some((x) => x.kind === "scratch"));
  // CLI: the same, on screen.
  const r = cli(["check"], dir);
  assert.match(r.stdout + r.stderr, /every role can write build's out\/\*\*/);
});
