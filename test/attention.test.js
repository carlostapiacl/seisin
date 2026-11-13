/**
 * Attention: what across the runs needs a person (runs.js attentionOf, the
 * console's first screen and `seisin attention`), the end of `seisin run` in
 * the same words (attention.js runSummary), and the canary's own network probe
 * no longer read as a denial of the agent's.
 *
 * Runs made by hand, each with a denial in one of the five classes, so every
 * class is asserted against a path whose standing is known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

import { loadConfig } from "../src/config.js";
import { runsView, filtersOf, attentionOf } from "../src/runs.js";
import { classOf } from "../src/views.js";
import { expectedOf } from "../src/kinds.js";
import { intake } from "../src/intake.js";
import { runSummary } from "../src/commands/attention.js";
import { boxed, CLI } from "./_tmp.js";

const POLICY = '[roles.web]\nwrites = ["web/**"]\n\n[roles.api]\nwrites = ["api/**"]\n';
const NOW = Date.parse("2026-10-26T12:00:00Z");

function line(e) { return JSON.stringify({ at: "2026-10-26T10:00:00.000Z", ...e }) + "\n"; }
const denied = (target, extra = {}) => ({ role: "web", source: "kernel", action: "write", kind: "file", target, verdict: "denied", owners: [], ...extra });
const canary = (confined = true) => ({ event: "canary", role: "web", confined, reasons: confined ? [] : ["a write outside the territory went through"] });

function run(dir, id, { meta = {}, log = [] } = {}) {
  const root = join(dir, id);
  mkdirSync(join(root, ".seisin"), { recursive: true });
  writeFileSync(join(root, "seisin.toml"), POLICY);
  writeFileSync(join(root, "run.json"), JSON.stringify({ run_id: id, started_at: "2026-10-26T10:00:00Z", ...meta }));
  writeFileSync(join(root, ".seisin", "log.jsonl"), log.map((e) => line({ run: id, ...e })).join(""));
  return root;
}

const PREFS = `${homedir()}/Library/Preferences/.GlobalPreferences.plist`;

function fiveClasses() {
  const dir = boxed("attention-");
  run(dir, "r1", {
    meta: { team: "shop", work_item: "WI-1", role: "executor" },
    log: [
      canary(),
      denied("docs/notes.md"),                                                        // decide: no role owns docs/
      denied("api/server.js"), denied("api/server.js"),                               // handoff: api's territory
      { ...denied("tcp:5432"), action: "connect", kind: "network" },                  // outside: a port
      denied(".git/hooks/pre-commit"),                                                // protected
      { ...denied(PREFS), action: "read" },                                           // expected: macOS preferences
    ],
  });
  run(dir, "r2", {
    meta: { team: "shop", work_item: "WI-1", role: "reviewer" },
    log: [canary(), denied("api/server.js"), { ...denied("tcp:61234"), action: "connect", kind: "network" }],
  });
  run(dir, "r3", {
    meta: { team: "blog", work_item: "WI-2", role: "executor", started_at: "2026-10-20T10:00:00Z" },
    log: [canary(), { ...denied("tcp:50001"), action: "connect", kind: "network" },
      denied("api/a/__pycache__"), denied("api/b/__pycache__"), denied("api/c/__pycache__")],
  });
  return dir;
}

test("every denial lands in one of five classes, and only three are listed as needing a person", () => {
  const v = runsView(fiveClasses(), {});
  const a = v.attention;
  assert.equal(a.piles.decide.denials, 1, "docs/notes.md: no role owns it");
  assert.equal(a.piles.handoff.denials, 6, "api/server.js three times, and three __pycache__ under api/");
  assert.equal(a.piles.outside.denials, 3, "three ports");
  assert.equal(a.piles.protected.denials, 1, ".git/hooks");
  assert.equal(a.piles.expected.denials, 1, "the global preferences");
  const listed = new Set(a.top.map((c) => c.class));
  assert.deepEqual([...listed].sort(), ["decide", "handoff", "outside"]);
  assert.ok(!a.top.some((c) => c.target.includes(".git/hooks") || c.target.includes("GlobalPreferences")));
  // Every run's own summary carries the same split.
  const r1 = v.runs.find((r) => r.id === "r1");
  assert.deepEqual(r1.byClass, { decide: 1, outside: 1, handoff: 2, protected: 1, expected: 1 });
});

test("the same name in many places is one line, with its runs counted once", () => {
  const a = runsView(fiveClasses(), {}).attention;
  const pyc = a.top.find((c) => c.target === "…/__pycache__");
  assert.ok(pyc, "the three __pycache__ are one line");
  assert.equal(pyc.places, 3);
  assert.equal(pyc.runs, 1, "all three in one run");
  assert.equal(a.paths, a.top.reduce((n, c) => n + (c.places ?? 1), 0));
});

test("a port the system hands out is one cause across runs, said for what it is", () => {
  const a = runsView(fiveClasses(), {}).attention;
  const eph = a.top.find((c) => c.target === "tcp:<ephemeral>");
  assert.ok(eph);
  assert.equal(eph.runs, 2, "tcp:61234 and tcp:50001, in two runs");
  assert.match(eph.why, /canary probe/);
  assert.ok(a.top.some((c) => c.target === "tcp:5432"), "a fixed port stays itself");
});

test("a window keeps the runs that started in it, and a filter by work item is that work item whole", () => {
  const dir = fiveClasses();
  const recent = runsView(dir, filtersOf("since=2026-10-25"));
  assert.equal(recent.totals.runs, 2);
  assert.equal(filtersOf("since=nonsense").since, undefined, "a window that does not parse is no filter");
  assert.match(filtersOf("since=7d").since, /:00\.000Z$/, "to the minute, so the poll is remembered");
  const wi = runsView(dir, filtersOf("work_item=WI-1"));
  assert.equal(wi.totals.runs, 2);
  assert.equal(wi.attention.top.find((c) => c.target === "api/server.js").runs, 2);
});

test("new is first seen in the last day; the days are local and oldest first", () => {
  const dir = fiveClasses();
  const v = runsView(dir, {});
  const shown = v.runs.map((r) => ({ ...r, byClass: r.byClass }));
  const a = attentionOf(shown, v.causes.map((c) => ({ ...c, ids: [] })), { now: NOW });
  assert.equal(a.days.length, 14);
  assert.ok(a.days[0].day < a.days[13].day);
  const today = a.days[13];
  assert.equal(today.runs, 2, "r1 and r2 started this day");
  assert.ok(a.top.find((c) => c.target === "docs/notes.md").new, "seen first 2 hours before now");
  const old = attentionOf(shown, v.causes.map((c) => ({ ...c, ids: [] })), { now: NOW + 3 * 86_400_000 });
  assert.ok(!old.top.some((c) => c.new));
});

test("the run's health: a failed canary, a dropped record, and a run with no record are counted apart", () => {
  const dir = boxed("attention-health-");
  run(dir, "ok", { log: [canary()] });
  run(dir, "bad", { log: [canary(false)] });
  run(dir, "lost", { log: [canary(), { event: "log-dropped", role: "web", batches: 3 }] });
  run(dir, "none", { log: [] });
  const h = runsView(dir, {}).attention.health;
  assert.deepEqual({ refused: h.refused, incomplete: h.incomplete, noRecord: h.noRecord, clean: h.clean },
    { refused: 1, incomplete: 1, noRecord: 1, clean: 2 });
});

test("classOf: the word for each standing, and expected wins over all of them", () => {
  assert.equal(classOf({ standing: "unowned" }), "decide");
  assert.equal(classOf({ standing: "outside" }), "outside");
  assert.equal(classOf({ standing: "owned" }), "handoff");
  assert.equal(classOf({ standing: "protected" }), "protected");
  assert.equal(classOf({ standing: "owned", expected: { kind: "plugins" } }), "expected");
});

test("macOS's global preferences, read at every program's start, are expected", () => {
  for (const p of [
    "/Users/x/Library/Preferences/.GlobalPreferences.plist",
    "/Users/x/Library/Preferences/.GlobalPreferences_m.plist",
    "/Users/x/Library/Preferences/ByHost/.GlobalPreferences.27AD91D7-2247-5C34-87A9-188831181885.plist",
  ]) assert.equal(expectedOf(p)?.kind, "os-background", p);
  assert.equal(expectedOf("/Users/x/Library/Preferences/com.example.app.plist"), null, "an app's own preferences are not");
});

test("the canary's own loopback probe is logged as expected, and another port is still a denial", () => {
  const box = boxed("attention-canary-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const take = intake({ config, role: "web", runId: "r", settings: {}, notify: { maybe() {} }, write: () => {} });
  take.expectCanary("tcp:61234");
  take.expectCanary("not a port");
  take.fromKernel({ action: "connect", path: "tcp:61234", operation: "network-outbound" });
  take.fromKernel({ action: "connect", path: "tcp:3306", operation: "network-outbound" });
  assert.equal(take.stats.canaryProbes, 1);
  assert.equal(take.stats.probes, 0, "not the caller's probe");
  const read = readFileSync(join(config.root, ".seisin", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ours = read.find((e) => e.target === "tcp:61234");
  assert.equal(ours.expected, true);
  assert.equal(ours.probe, "canary");
  assert.equal(read.find((e) => e.target === "tcp:3306").expected, undefined);
});

test("the end of a run: the boundary working said in one line, what needs a person spelled out", () => {
  const box = boxed("attention-summary-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const entries = [
    denied("api/server.js", { run: "r" }), denied("api/server.js", { run: "r" }),
    denied(".git/hooks/pre-commit", { run: "r" }),
    { ...denied(PREFS, { run: "r" }), action: "read" },
    denied("docs/other-run.md", { run: "someone-else" }),
  ];
  const text = runSummary(config, "web", "r", entries);
  assert.match(text, /4 denials in this run/);
  assert.match(text, /1 expected, 1 protected on purpose, 2 to look at/);
  assert.match(text, /other role\s+write api\/server\.js \(2×\)/);
  assert.match(text, /seisin explain web write api\/server\.js/);
  assert.doesNotMatch(text, /other-run/, "only this run's lines");
  const quiet = runSummary(config, "web", "r", [{ ...denied(PREFS, { run: "r" }), action: "read" }]);
  assert.match(quiet, /all of it the boundary working .* nothing to do/);
  assert.equal(runSummary(config, "web", "r", []), null);
});

test("seisin attention over a directory: what needs a person, exit 1 when a canary failed", () => {
  const dir = fiveClasses();
  const cli = (args) => spawnSync(process.execPath, [CLI, "attention", ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const ok = cli(["--runs", dir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /3 runs/);
  assert.match(ok.stdout, /held in every run/);
  assert.match(ok.stdout, /Needs a person/);
  assert.match(ok.stdout, /api\/server\.js/);
  assert.doesNotMatch(ok.stdout, /GlobalPreferences/);
  const json = JSON.parse(cli(["--runs", dir, "--work-item", "WI-2", "--json"]).stdout);
  assert.equal(json.totals.runs, 1);
  assert.ok(json.attention.top.length);
  assert.match(cli(["--runs", dir, "--since", "whenever"]).stderr, /--since takes a date/);
  run(dir, "r4", { log: [canary(false)] });
  const bad = cli(["--runs", dir]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /stopped at its canary/);
});

/* ── by role: the unit the console is read by ───────────────────────────── */

test("every role of the policy across the runs: its runs, what needs a person, and what it may do", () => {
  const dir = boxed("attention-roles-");
  run(dir, "a", { log: [canary(), denied("api/server.js"), { ...canary(), role: "api" }, { ...denied("docs/x.md"), role: "api" }] });
  run(dir, "b", { meta: { started_at: "2026-10-26T11:00:00Z" }, log: [canary(), denied("api/server.js")] });
  const v = runsView(dir, {});
  const web = v.roles.find((r) => r.name === "web");
  const api = v.roles.find((r) => r.name === "api");
  assert.equal(web.runs, 2);
  assert.equal(api.runs, 1);
  assert.equal(web.top.target, "api/server.js");
  assert.equal(web.top.class, "handoff");
  assert.deepEqual(web.def.writes, ["web/**"], "what the policy says it may write");
  assert.equal(v.roles[0].name, "web", "worst first");
});

test("a role's view cuts every run to what that role did in it", () => {
  const dir = boxed("attention-srole-");
  run(dir, "a", { log: [canary(), denied("api/server.js"), { ...canary(false), role: "api" }] });
  const web = runsView(dir, filtersOf("srole=web"));
  assert.equal(web.totals.runs, 1);
  assert.equal(web.runs[0].outcome, "denied", "web's own outcome, not the run's");
  assert.equal(web.attention.health.refused, 0, "api's failed canary is api's");
  const api = runsView(dir, filtersOf("srole=api"));
  assert.equal(api.runs[0].outcome, "refused");
  assert.equal(runsView(dir, filtersOf("srole=nobody")).totals.runs, 0);
});

test("a role that only past runs remember is listed last, and says so by having no policy", () => {
  const dir = boxed("attention-past-");
  run(dir, "old", { meta: { started_at: "2026-10-20T10:00:00Z" }, log: [{ ...canary(), role: "gone" }, { ...denied("x/y.md"), role: "gone" }] });
  run(dir, "new", { log: [canary()] });
  const roles = runsView(dir, {}).roles;
  assert.equal(roles[roles.length - 1].name, "gone");
  assert.equal(roles[roles.length - 1].def, null);
});

test("a run as one role lived it: in order, each denial once with its count and class, the old canary probe named", async () => {
  const { timelineOf } = await import("../src/runs.js");
  const box = boxed("attention-timeline-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const at = (s) => `2026-10-26T10:00:0${s}.000Z`;
  const all = [
    { at: at(0), run: "r", event: "canary", role: "web", confined: true, reasons: [], sandbox: "tartaros" },
    { at: at(1), run: "r", ...denied("tcp:61234"), action: "connect", kind: "network" },
    { at: at(2), run: "r", ...denied("api/server.js") },
    { at: at(3), run: "r", ...denied("api/server.js") },
    { at: at(4), run: "r", role: "web", verdict: "allowed", action: "write", target: "web/a.js" },
    { at: at(5), run: "r", ...denied("api/other.js"), role: "api" },
    { at: at(6), run: "other", ...denied("web/z.js") },
  ];
  const t = timelineOf(all, "r", "web", config);
  assert.deepEqual(t.events.map((e) => e.type), ["canary", "denied", "denied"]);
  assert.equal(t.events[1].likely?.includes("canary"), true, "a system port two seconds after the canary");
  assert.equal(t.events[2].times, 2);
  assert.equal(t.events[2].class, "handoff");
  assert.equal(t.allowed, 1);
  assert.equal(timelineOf(all, "r", null, config).events.length, 4, "every role of the run without a role");
});

test("a run's timeline says the policy it held under, and what --only and --deny took away", async () => {
  const { timelineOf } = await import("../src/runs.js");
  const box = boxed("attention-held-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const all = [
    { at: "2026-10-26T10:00:00.000Z", run: "r", event: "narrowed", role: "web", only: ["web/a/**"], deny: ["web/a/held.ts"], vars: ["RUN"] },
    { at: "2026-10-26T10:00:01.000Z", run: "r", event: "canary", role: "web", confined: true, reasons: [] },
  ];
  const t = timelineOf(all, "r", "web", config);
  assert.deepEqual(t.held.writes, config.roles.web.writesDeclared ?? config.roles.web.writes);
  assert.deepEqual(t.narrowed, { only: ["web/a/**"], deny: ["web/a/held.ts"], vars: ["RUN"] });
  assert.equal(timelineOf(all, "r", null, config).held, null, "no role, no one policy to say");
});

test("the example opened as a file is the server's own answer, for the example's own roles", () => {
  const src = readFileSync(new URL("../ui/src/demo-runs.js", import.meta.url), "utf8");
  const D = new Function(`${src}; return DEMO_RUNS;`)();
  const console_ = readFileSync(new URL("../ui/src/console.js", import.meta.url), "utf8");
  const names = [...console_.matchAll(/\{name:"(\w+)",\s+writes:/g)].map((m) => m[1]).sort();
  assert.deepEqual(D.views[""].roles.map((r) => r.name).sort(), names, "the same roles as DEMO.roles");
  for (const n of names) assert.equal(D.views[n].filters.srole, n, `a cut for ${n}'s page`);
  for (const k of Object.keys(D.timelines)) assert.ok(D.timelines[k].events.length, k);
  assert.ok(!/seisin-demo-|\/Users\/|\/private\//.test(src), "no path of the machine it was made on");
});

test("review --runs still answers, and says on stderr where it went", () => {
  const dir = boxed("attention-deprecated-");
  mkdirSync(join(dir, "r-1", ".seisin"), { recursive: true });
  writeFileSync(join(dir, "r-1", "seisin.toml"), POLICY);
  const r = spawnSync(process.execPath, [CLI, "review", "--runs", dir, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).runs.length, 1);
  assert.match(r.stderr, /deprecated.*seisin attention --runs <dir> --json/);
});

// ── What an adversarial review of 0.9.0 found ─────────────────────────────────

test("the canary's port is the canary's once: a later dial of it is the agent's, and recorded", () => {
  const box = boxed("attention-canary-once-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const take = intake({ config, role: "web", runId: "r", settings: {}, notify: { maybe() {} }, write: () => {} });
  take.expectCanary("tcp:61234");
  take.fromKernel({ action: "connect", path: "tcp:61234", operation: "network-outbound" });
  take.fromKernel({ action: "connect", path: "tcp:61234", operation: "network-outbound" });
  const lines = readFileSync(join(config.root, ".seisin", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.target === "tcp:61234");
  assert.equal(lines.length, 2, "the second dial is not folded into the canary's");
  assert.equal(lines[0].probe, "canary");
  assert.equal(lines[1].expected, undefined, "the agent's dial is a denial like any other");
});

test("the global preferences are expected only in a home, not a file of that name in the repository", () => {
  assert.equal(expectedOf("/Users/x/repo/fixtures/Library/Preferences/.GlobalPreferences.plist"), null);
  assert.equal(expectedOf("fixtures/Library/Preferences/.GlobalPreferences.plist"), null);
  assert.equal(expectedOf("/runs/r1/home/Library/Preferences/.GlobalPreferences.plist", { home: "/runs/r1/home" })?.kind, "os-background");
});

test("the end of a run counts the broker's times and the caller's expected probes", () => {
  const box = boxed("attention-summary-times-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const text = runSummary(config, "web", "r", [
    { ...denied("api.example.com:443", { run: "r" }), action: "connect", kind: "network", source: "srt", times: 20 },
    { ...denied("tcp:61234", { run: "r" }), action: "connect", kind: "network", expected: true, probe: "canary" },
  ]);
  assert.match(text, /21 denials in this run/);
  assert.match(text, /1 expected/);
});

test("a path granted since to one role still needs a person while another role is denied it", async () => {
  const { runsInLog, logRunsView } = await import("../src/runs.js");
  const box = boxed("attention-shared-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  // api owns api/server.js today; web was denied it too in the same run.
  for (const order of [["api", "web"], ["web", "api"]]) {
    const all = order.map((role) => denied("api/server.js", { role, run: "r" }));
    const [r] = runsInLog(all, ["web", "api"], config);
    assert.equal(r.byClass.handoff, 2, `${order}: web is still denied another role's path`);
    assert.ok(logRunsView(config.path, all, {}, ["web", "api"], config).attention.needs >= 1);
  }
});

test("one run with two system-assigned ports is one run of tcp:<ephemeral>", async () => {
  const { logRunsView } = await import("../src/runs.js");
  const box = boxed("attention-eph-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const all = ["tcp:40000", "tcp:50000"].map((t) => ({ ...denied(t, { run: "r" }), action: "connect", kind: "network" }));
  const v = logRunsView(config.path, all, {}, ["web", "api"], config);
  assert.equal(v.causes.find((c) => c.target === "tcp:<ephemeral>").runs, 1);
});

test("a window compares instants, not strings: a start with an offset is in it", async () => {
  const { runsView } = await import("../src/runs.js");
  const dir = boxed("attention-offset-");
  run(dir, "r1", { meta: { started_at: "2026-11-13T00:00:00-03:00" }, log: [canary()] });
  assert.equal(runsView(dir, { since: "2026-11-13T00:00:00.000Z" }).totals.runs, 1);
});

test("fourteen calendar days across a change of daylight saving time", () => {
  const prev = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    for (const now of ["2026-03-09T04:30:00Z", "2026-11-02T04:30:00Z"]) {
      const days = attentionOf([], [], { now: Date.parse(now) }).days.map((d) => d.day);
      assert.equal(new Set(days).size, 14, `${now}: ${days.join(" ")}`);
    }
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

test("a role named like a property of Object is a role like any other", async () => {
  const { runsView } = await import("../src/runs.js");
  const dir = fiveClasses();
  for (const r of ["constructor", "__proto__", "toString"])
    assert.equal(runsView(dir, filtersOf(`srole=${r}`)).totals.runs, 0, r);
});

test("a timeline holds only lines that name its run, and says when the policy is today's", async () => {
  const { timelineOf } = await import("../src/runs.js");
  const box = boxed("attention-orphans-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  const config = loadConfig(join(box, "seisin.toml"));
  const all = [denied("docs/no-run.md"), { ...denied("docs/a.md"), run: "r", policy: "0123456789ab" }];
  const t = timelineOf(all, "r", "web", config);
  assert.deepEqual(t.events.map((e) => e.target), ["docs/a.md"]);
  assert.equal(t.held_from, "today", "the file changed since: today's, said so");
});
