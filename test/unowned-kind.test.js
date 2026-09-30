/**
 * What kind of thing an unowned refused path is.
 *
 * Suggesting an owner for these was measured before it was built, on one
 * deployment's 317 unowned paths: right about one time in twenty, and wrong
 * in the widening direction the rest of the time — git's lock files, a test's
 * PID-named scratch directories, a credential. These pin the reading that
 * replaced it: the kind, and the move that fits it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kindOf, kindsOf, KINDS, GENERATED_SIBLINGS } from "../src/kinds.js";
import { causesOf } from "../src/views.js";
import { boxed } from "./_tmp.js";

// ── the pure function, one path at a time ──────────────────────────────────

const TABLE = [
  // git: a mutex or git's own bookkeeping, never territory
  ["repo/.git/index.lock", "git"],
  [".git/index.lock", "git"],
  ["repo/.git/packed-refs.lock", "git"],
  ["repo/.git/refs/heads/main.lock", "git"],
  ["repo/.git/objects/maintenance.lock", "git"],
  ["repo/.git/FETCH_HEAD", "git"],
  ["repo/.git/ORIG_HEAD", "git"],
  ["repo/.git/worktrees/w", "git"],
  ["repo/.git", "git"],

  // credential-shaped: said first, because it is the reading that never ends in a grant
  [".env", "credential"],
  ["api/.env.production", "credential"],
  ["api/.env.local", "credential"],
  ["certs/server.pem", "credential"],
  ["deploy/tls.key", "credential"],
  ["home/.ssh/id_ed25519", "credential"],
  ["id_rsa", "credential"],
  ["/Users/x/.ssh/known_hosts", "credential"],
  ["/Users/x/.npmrc", "credential"],
  ["pkg/.npmrc", "credential"],
  [".netrc", "credential"],
  [".git-credentials", "credential"],
  [".aws/credentials", "credential"],
  [".secrets/github-token.txt", "credential"],
  ["ops/api-token.txt", "credential"],
  ["ops/credentials.json", "credential"],
  [".docker/config.json", "credential"],
  [".kube/config", "credential"],
  [".env.tmp", "credential"],                    // both shapes: the safe one wins

  // temporary: scratch a tool or a test leaves while it runs
  ["tmp/out.txt", "temporary"],
  ["app/.cache/babel/x.json", "temporary"],
  ["api/.pytest_cache/v/cache/nodeids", "temporary"],
  ["pkg/__pycache__/mod.cpython-310.pyc", "temporary"],
  ["pkg/__pycache__/mod.cpython-310.pyc.4419525232", "temporary"],
  ["mod.pyc", "temporary"],
  [".hypothesis/constants/1bc864a5", "temporary"],
  ["data/app.sqlite-wal", "temporary"],
  ["data/app.sqlite-shm", "temporary"],
  ["data/app.db-journal", "temporary"],
  ["notes.md.tmp.32029.03c419358a1d", "temporary"],
  ["build.log", "temporary"],
  ["latest_logs", "temporary"],
  ["logs", "temporary"],
  [".notes.md.swp", "temporary"],
  ["notes.md~", "temporary"],
  [".!36165!BACKLOG.md", "temporary"],
  ["pytest-cache-files-uhgyk_ue", "temporary"],
  ["x/.DS_Store", "temporary"],
  ["tool/state.lock", "temporary"],
  ["x.bak", "temporary"],

  // build output and installed dependencies
  ["web/node_modules/react/index.js", "build"],
  ["web/dist/index.html", "build"],
  ["web/node_modules/.cache/x", "temporary"],    // a cache inside a build dir is still scratch
  ["web/.next/server/page.js", "build"],
  ["api/.venv/bin/python", "build"],
  ["rust/target/debug/app", "build"],
  ["coverage/lcov.info", "build"],

  // territory: a normal path nobody claims — the real decision
  ["src/auth/token.ts", "territory"],            // code ABOUT tokens is not a token
  ["docs/secrets.md", "territory"],
  [".env.example", "territory"],                 // made to be committed
  ["api/.env.sample", "territory"],
  ["yarn.lock", "territory"],                    // pins dependencies; somebody's to edit
  ["Cargo.lock", "territory"],
  ["data/app.sqlite", "territory"],              // the database, not its sidecar
  ["releases/v22", "territory"],
  ["bitacora/pruebas-datos-22359", "territory"], // alone, a run-shaped name is only a hint
  ["catalog/blog.md", "territory"],
  ["config/settings.json", "territory"],
  [".config/tool.toml", "territory"],            // `.config` is a container, not a secret
  [".docker/Dockerfile", "territory"],
  ["legacy/x.ts", "territory"],
];

for (const [path, kind] of TABLE)
  test(`kindOf ${path} → ${kind}`, () => {
    const k = kindOf(path);
    assert.equal(k.kind, kind);
    assert.ok(k.hint && typeof k.hint === "string", "every kind says what to do");
  });

test("every kind has one line of advice, and territory is the one that asks for an owner", () => {
  assert.deepEqual(Object.keys(KINDS), ["credential", "git", "temporary", "build", "territory"]);
  assert.match(KINDS.territory, /owner/);
  assert.match(KINDS.credential, /never grant a write/);
  assert.match(KINDS.credential, /key/);
  for (const k of ["credential", "git", "temporary", "build"])
    assert.doesNotMatch(KINDS[k], /give it an owner/, `${k} must not suggest an owner`);
});

test("a git lock names GIT_OPTIONAL_LOCKS and says to grant the repository, never the file", () => {
  const lock = kindOf("repo/.git/index.lock").hint;
  assert.match(lock, /GIT_OPTIONAL_LOCKS/);
  assert.match(lock, /repository/);
  assert.equal(kindOf("repo/.git/FETCH_HEAD").hint, KINDS.git, "metadata that is not a lock gets the general line");
});

test("a declared key directory makes anything inside it a credential", () => {
  assert.equal(kindOf("vault/db.txt").kind, "territory");
  assert.equal(kindOf("vault/db.txt", { keyDirs: ["vault"] }).kind, "credential");
  assert.equal(kindOf("/abs/repo/vault/db.txt", { keyDirs: ["vault/"] }).kind, "credential");
  assert.equal(kindOf("vaults/db.txt", { keyDirs: ["vault"] }).kind, "territory", "a prefix of a name is not the directory");
});

// ── the one rule that needs the set ────────────────────────────────────────

test("the same name made unique per run in several siblings is scratch, not a folder", () => {
  // Measured: a test that named its directory after its PID produced 258 of
  // 317 unowned paths. Alone, each looks like a folder somebody made.
  const runs = ["pruebas-deuda-57141-2b32ca", "pruebas-deuda-3333-5e1809", "pruebas-deuda-5017-bfaeec"];
  const targets = runs.flatMap((r) => [`bitacora/${r}`, `bitacora/${r}/BUZON.md`]);
  targets.push("bitacora/pruebas-guardia", "bitacora/pruebas-datos-22359");
  const m = kindsOf(targets);
  for (const r of runs) {
    assert.equal(m.get(`bitacora/${r}`).kind, "temporary", r);
    assert.equal(m.get(`bitacora/${r}/BUZON.md`).kind, "temporary", "what is inside a generated directory is too");
  }
  assert.equal(m.get("bitacora/pruebas-guardia").kind, "territory");
  assert.equal(m.get("bitacora/pruebas-datos-22359").kind, "territory", "one of its stem is not a generator");
});

test("fewer siblings than the threshold, or siblings under different parents, stay territory", () => {
  const two = Array.from({ length: GENERATED_SIBLINGS - 1 }, (_, i) => `work/run-${1000 + i}`);
  for (const [, k] of kindsOf(two)) assert.equal(k.kind, "territory");
  const apart = ["a/run-1001", "b/run-1002", "c/run-1003"];
  for (const [, k] of kindsOf(apart)) assert.equal(k.kind, "territory", "the siblings have to share a parent");
});

test("named things that only look numbered are not taken for runs", () => {
  // An extension is not a run, and a date is not a PID.
  const named = ["reports/report-2026.json", "reports/report-2027.json", "reports/report-2028.json",
    "img/img-0001.png", "img/img-0002.png", "img/img-0003.png",
    "days/2026-09-28", "days/2026-09-29", "days/2026-09-30"];
  for (const [t, k] of kindsOf(named)) assert.equal(k.kind, "territory", t);
});

test("the set rule never overrides a stronger reading", () => {
  const targets = ["k/.env.run-1001", "k/.env.run-1002", "k/.env.run-1003"];
  for (const [t, k] of kindsOf(targets)) assert.equal(k.kind, "credential", t);
});

// ── through causesOf and the MCP ───────────────────────────────────────────

const TOML = '[roles.a]\nwrites = ["src/**"]\n\n[roles.b]\nwrites = ["deploy/**"]\n';
const refused = (target, role = "a") =>
  ({ at: "2026-09-30T10:00:00.000Z", role, action: "write", kind: "file", target, verdict: "denied", owners: [] });
const LOG = [
  ...Array(5).fill(refused("other/.git/index.lock")),
  refused("other/.git/index.lock", "b"),
  refused("pkg/.npmrc"),
  refused("web/node_modules/x/index.js"),
  refused("bitacora/t-1001-aa11bb"), refused("bitacora/t-1002-cc22dd"), refused("bitacora/t-1003-ee33ff/x.md"),
  refused("legacy/x.ts"), refused("legacy/x.ts"),
  refused("deploy/owned.yml"),                  // owned by b: no kind, it is not unowned
];

function repo() {
  const dir = boxed("kinds-");
  writeFileSync(join(dir, "seisin.toml"), TOML);
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  writeFileSync(join(dir, ".seisin", "log.jsonl"), LOG.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

test("causesOf labels each unowned cause and counts the kinds; owned causes get no label", async () => {
  const { loadConfig } = await import("../src/config.js");
  const dir = repo();
  const f = causesOf(loadConfig(join(dir, "seisin.toml")), LOG);
  const by = Object.fromEntries(f.causes.map((c) => [c.target, c]));

  assert.equal(by["other/.git/index.lock"].kind, "git");
  assert.match(by["other/.git/index.lock"].hint, /GIT_OPTIONAL_LOCKS/);
  assert.equal(by["pkg/.npmrc"].kind, "credential");
  assert.equal(by["web/node_modules/x/index.js"].kind, "build");
  assert.equal(by["bitacora/t-1001-aa11bb"].kind, "temporary");
  assert.equal(by["bitacora/t-1003-ee33ff/x.md"].kind, "temporary");
  assert.equal(by["legacy/x.ts"].kind, "territory");
  assert.equal(by["legacy/x.ts"].hint, KINDS.territory);
  assert.equal(by["deploy/owned.yml"].standing, "owned");
  assert.ok(!("kind" in by["deploy/owned.yml"]) && !("hint" in by["deploy/owned.yml"]));

  // Additive: the old fields are where they were.
  assert.equal(f.unowned, 7);
  assert.equal(f.standing.unowned.paths, 7);
  assert.deepEqual(f.standing.unowned.kinds, {
    credential: { paths: 1, denials: 1 },
    git: { paths: 1, denials: 6 },
    temporary: { paths: 3, denials: 3 },
    build: { paths: 1, denials: 1 },
    territory: { paths: 1, denials: 2 },
  });
  const sum = Object.values(f.standing.unowned.kinds).reduce((n, k) => n + k.paths, 0);
  assert.equal(sum, f.unowned, "every unowned path has exactly one kind");
});

test("the kinds are read over every unowned cause, not only the twelve shown", async () => {
  const { loadConfig } = await import("../src/config.js");
  const dir = repo();
  // Twelve loud causes push the generated siblings out of the list shown; the
  // rule still needs all three of them to fire.
  const loud = Array.from({ length: 12 }, (_, i) => Array(10).fill(refused(`legacy/loud-${i}.ts`))).flat();
  const log = [...loud, refused("gen/r-1001-aa11bb"), refused("gen/r-1002-bb22cc"), refused("gen/r-1003-cc33dd")];
  const f = causesOf(loadConfig(join(dir, "seisin.toml")), log);
  assert.ok(!f.causes.some((c) => c.target.startsWith("gen/")), "the siblings are not in the list");
  assert.equal(f.standing.unowned.kinds.temporary.paths, 3);
  assert.equal(f.standing.unowned.kinds.territory.paths, 12);
});

test("seisin_causes carries kind and hint, and keeps every field it had", async () => {
  const { HANDLERS, TOOLS } = await import("../src/mcp.js");
  const dir = repo();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const m = HANDLERS.seisin_causes({});
    for (const k of ["total", "distinct", "unowned", "standing", "families", "causes"]) assert.ok(k in m, k);
    const lock = m.causes.find((c) => c.target === "other/.git/index.lock");
    for (const k of ["action", "target", "times", "share", "roles", "standing", "owners", "ownersThen", "stillRefused"])
      assert.ok(k in lock, `lost ${k}`);
    assert.equal(lock.kind, "git");
    assert.equal(m.causes.find((c) => c.target === "legacy/x.ts").kind, "territory");
    assert.equal(m.standing.unowned.kinds.territory.paths, 1);
  } finally { process.chdir(cwd); }
  const desc = TOOLS.find((t) => t.name === "seisin_causes").description;
  assert.match(desc, /`kind`/);
  assert.match(desc, /territory/);
});

test("seisin review splits unowned rows by kind and says each kind's advice once", async (t) => {
  const { loadConfig } = await import("../src/config.js");
  const { review } = await import("../src/review.js");
  const { reviewCommand } = await import("../src/commands/review.js");
  const dir = repo();
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const r = review(cfg);
  const row = (where) => r.unowned.find((u) => u.where === where);
  assert.equal(row("other/.git").kind, "git");
  assert.equal(row("other/.git").times, 6);
  assert.equal(row("legacy").kind, "territory");
  assert.equal(row("pkg").kind, "credential");
  assert.equal(row("bitacora").kind, "temporary", "the generated siblings, read over the whole log");
  assert.ok(r.unowned.every((u) => u.hint === KINDS[u.kind] || u.kind === "git"));

  const lines = [];
  t.mock.method(process.stdout, "write", (s) => { lines.push(String(s)); return true; });
  reviewCommand(cfg, ["--all"]);
  t.mock.restoreAll();
  const text = lines.join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /Only `territory` is a hole in the map/);
  assert.match(text, /6×\s+git\s+other\/\.git/);
  assert.match(text, /territory\s+legacy/);
  assert.equal(text.split("GIT_OPTIONAL_LOCKS").length - 1, 1, "the advice is said once per kind, not per row");
  assert.match(text, /credential: credential-shaped: never grant a write/);
});
