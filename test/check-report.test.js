/**
 * What check and inspect tell a person, and what the renderer may do with it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explain } from "../src/owners.js";
import { realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { tmpdir } from "node:os";
import { inspect, sharedPaths } from "../src/inspect.js";
import { renderReport, renderVerdict } from "../src/render.js";
import { renderConfig } from "../src/commands/init.js";
import { wire, wired } from "../src/commands/wire.js";
import { loadConfig } from "../src/config.js";
import { hookEntries } from "../src/commands/wire.js";
import { TOOL_MATCHER } from "../src/hook.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

test("inspect names a path two roles claim", () => {
  // Before, this could only be checked by launching the binary and searching
  // its stdout, which tests the renderer as much as the logic.
  const shared = { ...cfg, roles: { ...cfg.roles,
    hotfix: { name: "hotfix", writes: ["src/**"], keys: [], env: [] } } };
  const r = inspect(shared, null, "seisin.toml");
  assert.ok(r.warnings.some((w) => w.kind === "shared"));
  // `src/**` does NOT appear: its root `src` is covered by a single role. What is
  // shared is the two territories that sit inside hotfix's.
  assert.deepEqual(sharedPaths(shared).sort(), ["src/api/**", "src/web/**"]);
});

test("inspect warns when the repo sits inside shared scratch", () => {
  // The most valuable warning `check` gives, and the one a test could not reach:
  // the test bench itself lived in the temp dir and made a boundary test pass
  // for the wrong reason.
  const inScratch = { ...cfg, root: join(realpathSync(tmpdir()), "algun-repo") };
  const r = inspect(inScratch, null, "seisin.toml");
  assert.ok(r.warnings.some((w) => w.kind === "scratch"));
});

test("inspect warns when keys are declared with nowhere to scope them", () => {
  const noDir = { ...cfg, keyDirs: [] };
  assert.ok(inspect(noDir, null, "x").warnings.some((w) => w.kind === "keys-unscoped"));
});

test("asking about a role that does not exist is an error, not an empty report", () => {
  // Answering a typo with silence is how a typo becomes a belief.
  assert.throws(() => inspect(cfg, "no-existe", "x"), /unknown role/);
});

test("the renderer never decides anything", () => {
  // The module's contract: same data, same text, nothing read from outside.
  const report = inspect(cfg, null, "seisin.toml");
  assert.equal(renderReport(report), renderReport(report));
  assert.match(renderReport(report), /frontend/);
});

test("a denial renders with its owner, an allow does not", () => {
  const no = renderVerdict("frontend", "write", "src/api/s.ts",
    explain(cfg, "frontend", "write", "src/api/s.ts"));
  assert.match(no, /denied/);
  assert.match(no, /belongs to backend/);
  assert.match(renderVerdict("backend", "write", "src/api/s.ts",
    explain(cfg, "backend", "write", "src/api/s.ts")), /allowed/);
});

test("the proposed config leads with the agent's own API", () => {
  // Without this the agent cannot authenticate and fails with a 403 from the
  // proxy before doing any work, which reads as a broken install rather than a
  // strict policy.
  const toml = renderConfig({ source: "prueba", roles: [{ name: "a", writes: ["x/**"], keys: [] }] });
  assert.match(toml, /api\.anthropic\.com/);
  assert.match(toml, /\[roles\.a\]/);
});

test("check says so before anything runs", () => {
  const cfg = { root: "/repo", keyDirs: [], allowedDomains: [], path: "seisin.toml",
                roles: { r: { name: "r", writes: ["src/*"], keys: [], network: null } } };
  const w = inspect(cfg, null, "seisin.toml").warnings.find((x) => x.kind === "cannot-be-enforced");
  assert.ok(w, "check does not warn about a pattern run will refuse");
  assert.match(w.headline, /src\/\*/);
});

test("check says what it cannot enforce, and exits on it", () => {
  // The label matters: it said "unenforceable-glob" for any error, so a key
  // outside its directory was reported as a glob problem and sent the reader
  // to the wrong line.
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [],
                roles: { r: { name: "r", writes: ["src/*"], keys: [], network: null } } };
  const w = inspect(cfg, null, "seisin.toml").warnings.find((x) => x.kind === "cannot-be-enforced");
  assert.ok(w);
  assert.match(w.headline, /r: /);
});

test("check is loud about the two ways around the key model", () => {
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [".secrets"], allowedDomains: [],
                roles: { a: { name: "a", writes: ["src/**", "../otro/**"], keys: [],
                              env: ["GITHUB_TOKEN", "LANG"], network: null } } };
  const kinds = inspect(cfg, null, "x").warnings.map((w) => w.kind);
  assert.ok(kinds.includes("territory-outside-repo"));
  assert.ok(kinds.includes("secret-through-env"));
});

test("check says when nothing is recording", (t) => {
  // The hook is what writes the log, and the README described it as something
  // that happens without ever saying it has to be installed. So `seisin log`
  // came back empty after twelve real runs, and with it watch, requests, grant
  // and review — the story the README opens with.
  const box = scratch("seisin-w-");
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const cfg = { root: box, path: join(box, "seisin.toml"), keyDirs: [], allowedDomains: [],
                roles: { dev: { name: "dev", writes: ["src/**"], keys: [], network: null } } };

  assert.ok(inspect(cfg, null, "x").warnings.some((w) => w.kind === "hook-not-wired"));
  assert.equal(wire(cfg).changed, true);
  assert.ok(wired(box));
  assert.ok(!inspect(cfg, null, "x").warnings.some((w) => w.kind === "hook-not-wired"));
  // idempotent: running it twice does not add the hook again
  assert.equal(wire(cfg).changed, false);
});

test("wiring merges into settings that already exist", (t) => {
  // Someone's hooks are theirs. A tool that overwrites them to install itself
  // does not get a second chance.
  const box = scratch("seisin-w2-");
  t.after(() => rmSync(box, { recursive: true, force: true }));
  mkdirSync(join(box, ".claude"), { recursive: true });
  writeFileSync(join(box, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "mio" }] }] } }));

  const cfg = { root: box, path: join(box, "seisin.toml"), keyDirs: [], allowedDomains: [], roles: {} };
  wire(cfg);
  const after = JSON.parse(readFileSync(join(box, ".claude", "settings.json"), "utf8"));
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.ok(JSON.stringify(after).includes("mio"), "it ran over someone else's hook");
});

test("check asks when a role cannot reach any model", () => {
  // The same defect three times, reported by three people: a list of what the
  // agents need, written in a place that does not know which agent will run.
  // The last time it cost six runs of a benchmark that ended in eight seconds
  // with a 403 — which in a results table reads as "this model cannot do the
  // task".
  const mk = (domains) => ({ root: "/repo", path: "/repo/seisin.toml", keyDirs: [],
    allowedDomains: domains,
    roles: { dev: { name: "dev", writes: ["src/**"], keys: [], network: null } } });
  const warns = (c) => inspect(c, null, "x").warnings.some((w) => w.kind === "no-model-endpoint");

  assert.ok(warns(mk(["opencode.ai", "*.opencode.ai", "pypi.org"])), "the benchmark's list passed");
  assert.ok(warns(mk([])), "an empty list passed");
  assert.ok(!warns(mk(["api.anthropic.com", "github.com"])), "it warned about a correct list");
  // per-role wins over the global list
  const perRole = mk([]);
  perRole.roles.dev.network = ["openrouter.ai"];
  assert.ok(!warns(perRole));
});

test("check states the gap it does not cover, every time", () => {
  // The README said it in three places and `check` said it in none, and
  // `check` is the one place someone looks before trusting the map. Pinned here
  // because a limit that can be deleted without anything complaining turns back
  // into a promise.
  const { limits } = inspect(cfg, null, "seisin.toml");
  const unlink = limits.find((l) => l.kind === "unlink-uncovered");
  assert.ok(unlink, "check no longer says a role can delete inside its territory");
  assert.match(unlink.detail, /denyUnlink/);   // and where the upstream ask went

  // Key isolation covers what was declared, not every secret in the repo.
  const keysLimit = limits.find((l) => l.kind === "keys-only-what-you-declared");
  assert.ok(keysLimit, "check does not say keys outside [keys] are readable");
  assert.match(keysLimit.detail, /seisin scan/);
});

function repo(toml, files = []) {
  const root = scratch("seisin-fix051-");
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  writeFileSync(join(root, "seisin.toml"), toml);
  return { root, cfg: loadConfig(join(root, "seisin.toml")) };
}

const warnings = (cfg, only = null) => inspect(cfg, only, "seisin.toml").warnings;

/* ── 3. `check <role>` names the files the warning points at ───────────── */

test("the individual-files warning points at check <role>, and check <role> names them", () => {
  const two = '[roles.dev]\nwrites = ["data/app.sqlite", "src/a.js"]\n[roles.qa]\nwrites = ["test/**"]\n';
  const { cfg } = repo(two, ["data/app.sqlite", "src/a.js", "test/x"]);
  const all = warnings(cfg).find((x) => x.kind === "siblings-uncovered");
  assert.match(all.detail, /`seisin check <role>` names the files/);
  const one = warnings(cfg, "dev").find((x) => x.kind === "siblings-uncovered");
  assert.match(one.detail, /The files: data\/app\.sqlite src\/a\.js\./);
});

const silently = (fn) => {
  const w = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
};

function repoWith(settings) {
  const root = scratch("seisin-rs-");
  if (settings) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  }
  return {
    root, path: join(root, "seisin.toml"), keyDirs: [], allowedDomains: [],
    roles: { dev: { name: "dev", writes: ["src/**"], keys: [], network: null } },
  };
}

const kinds = (cfg) => inspect(cfg, null, "x").warnings.map((w) => w.kind);

test("check says when the hook was wired with the pre-0.5.0 matcher \"*\"", () => {
  // Wired before 0.5.0: every event is there, PreToolUse just runs on every tool.
  const old = hookEntries();
  old.PreToolUse[0].matcher = "*";
  const cfg = repoWith({ hooks: old });

  assert.ok(kinds(cfg).includes("hook-matcher-broad"));
  assert.ok(!kinds(cfg).includes("hook-not-wired"), "it is wired — only broadly");
  const w = inspect(cfg, null, "x").warnings.find((x) => x.kind === "hook-matcher-broad");
  assert.match(w.detail, /seisin wire/);

  // and `seisin wire` is what makes it go away
  assert.equal(silently(() => wire(cfg)).changed, true);
  const pre = JSON.parse(readFileSync(join(cfg.root, ".claude", "settings.json"), "utf8")).hooks.PreToolUse;
  assert.equal(pre[0].matcher, TOOL_MATCHER);
  assert.ok(!kinds(cfg).includes("hook-matcher-broad"));
});

test("check stays quiet about the matcher when it is narrow, missing, or not only ours", () => {
  // freshly wired
  assert.ok(!kinds(repoWith({ hooks: hookEntries() })).includes("hook-matcher-broad"));
  // not wired at all: that is hook-not-wired's to say, not this one's
  const bare = kinds(repoWith(null));
  assert.ok(bare.includes("hook-not-wired") && !bare.includes("hook-matcher-broad"));
  // a "*" entry that also runs somebody else's command: `wire` will not narrow
  // it, so check must not tell anyone to run `wire` for it
  const shared = hookEntries();
  shared.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: "seisin hook" }, { type: "command", command: "their-linter" }] }];
  assert.ok(!kinds(repoWith({ hooks: shared })).includes("hook-matcher-broad"));
});

test("check does not call a provider missing when it is only where a role writes", () => {
  const dir = scratch("seisin-prov-");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "miprov"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.p]\ncommand = ["miprov", "{ref}"]\n[roles.a]\nwrites = ["**"]\nkeys = ["p://x"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const before = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${before}`;
  try {
    const kinds = inspect(cfg).warnings.map((w) => w.kind);
    assert.ok(kinds.includes("provider-in-territory"));
    assert.ok(!kinds.includes("provider-missing"));
  } finally {
    process.env.PATH = before;
  }
});
