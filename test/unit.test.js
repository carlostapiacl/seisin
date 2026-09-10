/**
 * The parts that can be checked without touching the operating system.
 * The sandbox itself is exercised by test/sandbox.test.js, which is slower and
 * skips where the runtime is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "../src/config.js";
import { covers, ownersOf, keyHolders, explain } from "../src/owners.js";
import { settingsFor } from "../src/srt.js";

const cfg = {
  root: "/repo",
  keyDir: ".secrets",
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

test("a quoted value keeps its first character", () => {
  // Regression. The first parser chained two slices and turned ".secrets" into
  // "secrets". Nothing failed loudly: denyRead pointed at a path that did not
  // exist, so every key stayed readable by every role. A permission tool that
  // is wrong in this direction is worse than no tool, so this test exists.
  assert.equal(parseToml('[keys]\ndir = ".secrets"').keys.dir, ".secrets");
  assert.equal(parseToml('[keys]\ndir = "..hidden"').keys.dir, "..hidden");
});

test("a comment inside a string is not a comment", () => {
  assert.deepEqual(parseToml('[roles.a]\nwrites = ["a#b.ts"]').roles.a.writes, ["a#b.ts"]);
});

test("an array may span several lines", () => {
  const t = parseToml('[roles.a]\nwrites = [\n  "one",\n  "two"\n]');
  assert.deepEqual(t.roles.a.writes, ["one", "two"]);
});

test("unreadable input names its line", () => {
  assert.throws(() => parseToml("[roles.a]\nwrites = one"), /:2:/);
});

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

test("the emitted settings carry every field the runtime requires", () => {
  // The runtime refuses to start on a partial settings file rather than falling
  // back to its defaults. Emitting the whole object is what makes that safe.
  const s = settingsFor(cfg, "frontend");
  assert.deepEqual(Object.keys(s.network).sort(), ["allowLocalBinding", "allowUnixSockets", "allowedDomains", "deniedDomains"]);
  assert.deepEqual(Object.keys(s.filesystem).sort(), ["allowRead", "allowWrite", "denyRead", "denyWrite"]);
});

test("the key directory is denied wholesale and re-allowed one file at a time", () => {
  const s = settingsFor(cfg, "frontend");
  assert.deepEqual(s.filesystem.denyRead, ["/repo/.secrets"]);
  assert.deepEqual(s.filesystem.allowRead, ["/repo/.secrets/netlify.txt"]);
});

test("a write glob becomes a directory, because the kernel grants subtrees", () => {
  // Passing `src/web/**` straight through would ask the OS for a directory
  // literally named `**`, which grants nothing and says nothing.
  assert.deepEqual(settingsFor(cfg, "frontend").filesystem.allowWrite, ["/repo/src/web"]);
});

test("an unknown role fails loudly", () => {
  assert.throws(() => settingsFor(cfg, "nope"), /unknown role/);
});
