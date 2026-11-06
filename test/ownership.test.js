/**
 * Who owns a path: globs, denials that name an owner, and the paths nobody owns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { covers, ownersOf, keyHolders, explain } from "../src/owners.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { decide } from "../src/hook.js";
import { generalise } from "../src/log.js";
import { discover } from "../src/commands/init.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

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
