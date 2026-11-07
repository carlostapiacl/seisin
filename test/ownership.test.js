/**
 * Who owns a path: globs, denials that name an owner, and the paths nobody owns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { covers, ownersOf, keyHolders, explain, readTarget } from "../src/owners.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, twoRoles as cfg, policyFrom as policy } from "./_tmp.js";
import { decide } from "../src/hook.js";
import { generalise } from "../src/log.js";
import { discover } from "../src/commands/init.js";
import { mkdirSync, existsSync } from "node:fs";
import { inspect, sharedPaths } from "../src/inspect.js";
import { toRepoRelative } from "../src/paths.js";
import { realOrSelf } from "../src/grants.js";

test("a subtree glob covers the directory it was granted", () => {
  assert.ok(covers("src/web/**", "src/web"));
  assert.ok(covers("src/web/**", "src/web/deep/a.ts"));
  assert.ok(!covers("src/web/**", "src/webx/a.ts"));
});

test("a star does not cross a slash, and a dotfile is not special", () => {
  assert.ok(covers("*.md", "README.md"));
  assert.ok(!covers("*.md", "docs/README.md"));
  // Deliberate: shell globs hide dotfiles, a permission tool must not.
  assert.ok(covers("*.env", ".env"));
});

test("a denial names the owner", () => {
  const v = explain(cfg, "frontend", "write", "src/api/server.ts");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.owners, ["backend"]);
  assert.match(v.reason, /belongs to backend/);
});

test("an unowned path is reported as a hole, not as a denial", () => {
  const v = explain(cfg, "frontend", "write", "scripts/deploy.sh");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.owners, []);
  assert.match(v.reason, /no owner/);
});

test("a key matches with or without its extension", () => {
  assert.deepEqual(keyHolders(cfg, "netlify"), ["frontend"]);
  assert.deepEqual(keyHolders(cfg, "netlify.txt"), ["frontend"]);
});

test("two roles may claim the same path, and both are named", () => {
  const shared = { ...cfg, roles: { ...cfg.roles, hotfix: { name: "hotfix", writes: ["src/**"], keys: [], network: null } } };
  assert.deepEqual(ownersOf(shared, "src/api/server.ts").sort(), ["backend", "hotfix"]);
});

test("a territory can reach outside the config's own directory", () => {
  // The adapter emits `../` when the territory leaves the team's directory, and
  // that is only correct if it holds here. A role owns its working tree inside
  // and its handoff one level up; without this the generator would have to pick
  // between two relative bases in one file, which was the bug that brought it.
  const cfg = {
    root: "/repo", keyDirs: [], allowedDomains: [],
    roles: { dev: { name: "dev", writes: ["src/**", "../data/shared/lab/dev.md"], keys: [], network: null } },
  };
  assert.ok(explain(cfg, "dev", "write", "src/a.py").allowed);
  assert.ok(explain(cfg, "dev", "write", "../data/shared/lab/dev.md").allowed);
  // and the escape does not open the whole directory
  assert.ok(!explain(cfg, "dev", "write", "../data/shared/lab/qa.md").allowed);
});

test("a path is canonical before anyone decides who owns it", () => {
  // src/web/../api/orders.ts belongs to backend. Unresolved, it matched
  // src/web/**: `whose` named the wrong owner, the hook raised no request, and
  // the log recorded allowed for a write the kernel then denied. The boundary
  // held; everything seisin said about it was false.
  assert.deepEqual(ownersOf(shared2, "src/web/../api/orders.ts"), ["backend"]);
  assert.ok(!explain(shared2, "frontend", "write", "src/web/../api/orders.ts").allowed);

  assert.deepEqual(ownersOf(shared2, "src/web//./a.tsx"), ["frontend"]);
  // Outside the repo it belongs to no one, and no pattern reaches it.
  assert.deepEqual(ownersOf(shared2, "../fuera.txt"), []);
  assert.ok(!explain(shared2, "frontend", "write", "../../etc/passwd").allowed);
});

const shared2 = {
  root: "/repo", keyDirs: [], allowedDomains: [],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: [], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: [], network: null },
  },
};

test("a directory that merely shares a key dir's name is not a key", () => {
  // `includes` made src/web/.secrets/readme.md count as a credential and be
  // denied with a message about keys, for a file that is not one. The reason a
  // denial gives is the whole product.
  const cfg = { root: "/repo", keyDirs: [".secrets"], allowedDomains: [],
                roles: { f: { name: "f", writes: ["src/web/**"], keys: ["k.txt"], network: null } } };
  const readAs = (p) => decide(cfg, "f", { tool_name: "Read", tool_input: { file_path: p } },
                             { now: () => true, ask: () => true });
  assert.ok(!readAs("src/web/.secrets/readme.md")?.hookSpecificOutput, "it treated it as a key");
  assert.ok(readAs(".secrets/otra.txt")?.hookSpecificOutput, "a real key stopped being denied");
});

test("a file at the root is a file, not a directory that does not exist", () => {
  // Observing a write to NOTAS.md proposed `NOTAS.md/**` — the children of a
  // directory that does not exist, so the observed policy allowed nothing on
  // the file that was actually written.
  assert.deepEqual(generalise(["NOTAS.md"]), ["NOTAS.md"]);
  assert.deepEqual(generalise(["src/web/App.tsx", "src/web/a.css"]), ["src/web/**"]);
  assert.deepEqual(generalise(["NOTAS.md", "src/web/App.tsx"]), ["NOTAS.md", "src/web/**"]);
  // a root file already covered by a directory does not need naming
  assert.deepEqual(generalise(["src/a.ts", "src/b/c.ts"]), ["src/**"]);
});

test("a path outside the repo has no owner, even for writes = [\"**\"]", () => {
  // The kernel logged a refused write to ~/.claude/plugins as "owned by dev,
  // wide": `**` matched the absolute path as if it were inside the repo.
  const config = { root: "/repo", roles: { dev: { name: "dev", writes: ["**"] } } };
  assert.deepEqual(ownersOf(config, "/Users/x/.claude/plugins/lock"), []);
  assert.deepEqual(ownersOf(config, "/repo/src/a.ts"), ["dev"]);
  assert.deepEqual(ownersOf(config, "src/a.ts"), ["dev"]);
});

/**
 * A time budget that follows the machine: `ms` on an idle one, and under load
 * `factor` times what a linear pass takes right now — measured here, so load
 * moves both. Anything super-linear still blows through it; a busy CI runner
 * no longer fails a parser that is fine.
 */
function budget(ms, factor, linear) {
  const t0 = performance.now();
  linear();
  return Math.max(ms, factor * (performance.now() - t0));
}

test("SEC-09 a leading-slash CODEOWNERS path maps to a repo-relative territory", () => {
  const dir = scratch("seisin-codeowners-");
  writeFileSync(join(dir, "CODEOWNERS"), "/apps/ @team\nlib/ @team\n");
  const found = discover(dir);
  const apps = found.roles.find((r) => r.writes[0].includes("apps"));
  assert.ok(apps.writes.includes("apps/**"), "leading slash must be stripped");
  assert.ok(!found.roles.some((r) => r.writes.some((w) => w.startsWith("/"))), "no absolute territory");
});

test("SEC-22a covers() does not backtrack catastrophically on a crafted glob", () => {
  const glob = "**/a/".repeat(15) + "**/*.zz";
  const path = "a/".repeat(40) + "b.ts";
  // Baseline: the same path against a glob of the same length that cannot
  // backtrack, 2000 times. Exponential matching is minutes, not a factor.
  const flat = "src/".repeat(15) + "**/*.zz";
  const limit = budget(500, 50, () => { for (let i = 0; i < 2000; i++) covers(flat, path); });
  const t0 = performance.now();
  assert.equal(covers(glob, path), false);
  const took = performance.now() - t0;
  assert.ok(took < limit, `took ${Math.round(took)} ms, budget ${Math.round(limit)} ms`);
});

test("SEC-15b/09 a territory cannot be absolute, but .. is allowed (used for sibling dirs)", () => {
  const dir = scratch("seisin-terr-");
  const load = (toml) => { writeFileSync(join(dir, "seisin.toml"), toml); return () => loadConfig(join(dir, "seisin.toml")); };
  assert.throws(load('[roles.a]\nwrites = ["/etc/**"]\n'), /absolute/);
  // .. stays legal: a policy writes ../data/shared/... on purpose
  assert.ok(load('[roles.a]\nwrites = ["../data/shared/**"]\n')());
});

// ── owners: `**` does not reach above the repo ──────────────────────────────

test("a glob that does not climb covers nothing above the repo root", () => {
  assert.equal(covers("**", "../../etc/passwd"), false);
  assert.equal(covers("**", ".."), false);
  assert.equal(covers("src/**", "src/../../x"), false);
  assert.equal(covers("*", "../x"), false);
  // Inside the repo nothing changed.
  assert.equal(covers("**", "src/x.ts"), true);
  assert.equal(covers("src/**", "src/a/../b.ts"), true);
});

test("a territory that names a place above the root still covers it", () => {
  // The shape a policy with 32 roles uses: a shared log lives beside the role's directory.
  assert.equal(covers("../data/shared/lab/dev.md", "../data/shared/lab/dev.md"), true);
  assert.equal(covers("../data/shared/**", "../data/shared/lab/dev.md"), true);
  assert.equal(covers("../data/shared/lab/dev.md", "../other/dev.md"), false);
});

test("explain does not call a path outside the repo 'inside territory'", () => {
  const cfg = policy(`
[roles.dev]
writes = ["**"]
[roles.lab]
writes = ["../data/shared/lab/dev.md"]
`);
  const out = explain(cfg, "dev", "write", "../../etc/passwd");
  assert.equal(out.allowed, false);
  assert.deepEqual(ownersOf(cfg, "../../etc/passwd"), []);
  assert.equal(explain(cfg, "lab", "write", "../data/shared/lab/dev.md").allowed, true);
  assert.deepEqual(ownersOf(cfg, "../data/shared/lab/dev.md"), ["lab"]);
});

// ── owners: only a path key grants a read ───────────────────────────────────

test("a reference key does not make explain(read) say the role declares the file", () => {
  const cfg = policy(`
[keys]
dir = ".secrets"
[keys.providers.keychain]
command = ["security", "find-generic-password", "-w", "-s", "{ref}"]
[roles.a]
writes = ["a/**"]
keys = ["keychain://deploy", "TOKEN=file://.secrets/all.env#TOKEN"]
[roles.b]
writes = ["b/**"]
keys = ["all.env"]
`);
  // `all.env` is b's file; a only has one value out of it, delivered by the parent.
  assert.deepEqual(keyHolders(cfg, "all.env"), ["b"]);
  assert.deepEqual(keyHolders(cfg, ".secrets/all.env"), ["b"]);
  assert.equal(explain(cfg, "a", "read", ".secrets/all.env").allowed, false);
  // `deploy` is a keychain item's name, not a file anybody can read.
  assert.deepEqual(keyHolders(cfg, "deploy"), []);
  assert.equal(explain(cfg, "b", "read", "all.env").allowed, true);
});

test("a key directory with a trailing slash matches its keys", () => {
  const cfg = policy(`[keys]\ndir = ".secrets/"\n[roles.a]\nwrites = ["a/**"]\nkeys = ["x.txt"]\n`);
  assert.deepEqual(keyHolders(cfg, ".secrets/x.txt"), ["a"]);
});

// ── performance work that must not change an answer ─────────────────────────

test("the literal-head prefilter keeps every shape the matcher accepts", () => {
  assert.equal(covers("src/api/**", "src/api"), true);
  assert.equal(covers("a/**/b", "a/b"), true);
  assert.equal(covers("a/**/b", "a/x/y/b"), true);
  assert.equal(covers("**/.env", ".env"), true);
  assert.equal(covers("src/*.ts", "src/a.ts"), true);
  assert.equal(covers("src/*.ts", "srcx/a.ts"), false);
  assert.equal(covers("src/[x]/**", "src/[x]/a"), true);
  // A long pair past the shared buffer, then a short one reusing it.
  const deep = "d/".repeat(800) + "f";
  assert.equal(covers("**/f", deep), true);
  assert.equal(covers("d/*/f", "d/e/f"), true);
});

test("sharedPaths answers the same when globs repeat across roles", () => {
  const cfg = policy(`
[roles.a]
writes = ["src/**", "docs/**"]
[roles.b]
writes = ["src/**"]
[roles.c]
writes = ["docs/x.md", "lib/**"]
`);
  assert.deepEqual(sharedPaths(cfg).sort(), ["docs/x.md", "src/**"]);
  const report = inspect(cfg);
  assert.deepEqual(report.shared.sort(), ["docs/x.md", "src/**"]);
  assert.equal(report.warnings.filter((w) => w.kind === "shared").length, 1);
});

// ── one realpath, the disk's own case ───────────────────────────────────────

test("an absolute path spelled in another case is inside the repo on a case-folding disk", (t) => {
  const base = scratch("seisin-case-");
  const repo = join(base, "Repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  if (!existsSync(join(base, "repo"))) return t.skip("case-sensitive filesystem");
  writeFileSync(join(repo, "seisin.toml"), `[roles.a]\nwrites = ["src/**"]\n`);
  const cfg = loadConfig(join(repo, "seisin.toml"));
  assert.equal(toRepoRelative(cfg, join(base, "repo", "src", "x.ts")), "src/x.ts");
  assert.equal(realOrSelf(join(base, "repo")), realOrSelf(repo));
  assert.ok(realOrSelf(join(base, "repo")).endsWith("/Repo"));
});

test("a read outside every key directory is allowed, and says why", () => {
  const config = policy('[keys]\ndir = ".secrets"\n\n[roles.a]\nwrites = ["src/**"]\n');
  const v = explain(config, "a", "read", "docs/readme.md");
  assert.equal(v.allowed, true);
  assert.equal(v.open, true);
});

test("a bare name is a key when it is a file in a key directory, and a path when it is not", () => {
  const dir = scratch("seisin-readtarget-");
  mkdirSync(join(dir, ".secrets"));
  writeFileSync(join(dir, ".secrets", "db.txt"), "x\n");
  writeFileSync(join(dir, "seisin.toml"), '[keys]\ndir = ".secrets"\n\n[roles.a]\nwrites = ["src/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  assert.deepEqual(readTarget(config, "db.txt", dir), { key: true, target: "db.txt" });
  assert.deepEqual(readTarget(config, "db", dir), { key: true, target: "db" });
  assert.equal(readTarget(config, "notes.txt", dir).key, false);
});

test("a port the role lists and the kernel still refused is marked as listed", () => {
  const config = policy('[roles.a]\nwrites = ["src/**"]\nlocal_ports = [3306]\n');
  const listed = explain(config, "a", "connect", "tcp:3306");
  assert.equal(listed.listed, true);
  assert.equal(listed.network, true);
  assert.equal(listed.allowed, false);
  assert.notEqual(explain(config, "a", "connect", "tcp:5432").listed, true);
});
