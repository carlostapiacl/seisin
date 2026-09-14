/**
 * Where seisin said one thing and the kernel did another.
 *
 * Two defects, one shape: the document was tighter than the boundary, which
 * `decisions.md` names as the one direction a permission tool must never fail
 * in. Both told a reader a path was protected while a role could write it, and
 * neither looked wrong from the outside — which is why they are pinned here
 * rather than left to the commands' own tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { covers, ownersOf } from "../src/owners.js";
import { settingsFor } from "../src/srt.js";

const policy = (writes) => ({
  root: "/repo",
  path: "/repo/seisin.toml",
  keyDirs: [".secrets"],
  runtimeWrites: [],
  roles: { dev: { name: "dev", writes, keys: [] } },
});

test("a folder granted without a glob covers what is under it", () => {
  // Because that is what the kernel is handed: `allowWrite` is a prefix, so
  // `src/api`, `src/api/` and `src/api/**` are one grant to the OS.
  assert.ok(covers("src/api", "src/api/orders.ts"));
  assert.ok(covers("src/api", "src/api/deep/nested.ts"));
  assert.ok(covers("src/api", "src/api"));
});

test("covering stops at the path boundary, not at the characters", () => {
  // `src/apifoo.ts` starts with `src/api` as text and is a different place on
  // disk. The kernel knows that; so must this.
  assert.equal(covers("src/api", "src/apifoo.ts"), false);
  assert.equal(covers("data/base.sqlite", "data/base.sqlite-journal"), false);
});

test("a literal file still covers only itself", () => {
  assert.ok(covers("notes/later.md", "notes/later.md"));
  assert.equal(covers("notes/later.md", "notes/other.md"), false);
});

test("what seisin says about a bare folder is what it hands the kernel", () => {
  // The two halves of the same claim, asserted against each other rather than
  // each against its own idea of the answer. If a future change moves one of
  // them, this fails rather than going quiet.
  const config = policy(["src/api"]);
  const granted = settingsFor(config, "dev").filesystem.allowWrite;

  assert.ok(granted.includes("/repo/src/api"), "the kernel is given the folder as a prefix");
  assert.deepEqual(ownersOf(config, "src/api/orders.ts"), ["dev"],
    "and seisin names the same owner for anything under it");
});

test("a path outside the folder is still owned by nobody", () => {
  const config = policy(["src/api"]);
  assert.deepEqual(ownersOf(config, "src/web/app.ts"), []);
});

/* ── an absolute path is the same question as the relative one ────────── */

test("explain strips the repo root, the way whose and the hook already did", async (t) => {
  // It did not, so `seisin explain dev write /abs/repo/src/api/x.ts` answered
  // "has no owner" for a file that role could write — while `whose`, asked
  // about the very same path, named the owner. The command people run to check
  // a boundary was the one disagreeing with the boundary.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { loadConfig } = await import("../src/config.js");
  const { explainCommand } = await import("../src/commands/explain.js");
  const { whose } = await import("../src/commands/whose.js");

  const root = mkdtempSync(join(tmpdir(), "seisin-abs-"));
  mkdirSync(join(root, "src", "api"), { recursive: true });
  writeFileSync(join(root, "seisin.toml"),
    '[keys]\ndir = [".secrets"]\n\n[roles.dev]\nwrites = ["src/api/**"]\nkeys = []\n');
  const config = loadConfig(join(root, "seisin.toml"));
  const abs = join(config.root, "src/api/orders.ts");

  const silent = () => {};                       // these commands print
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = silent;
  t.after(() => { process.stdout.write = write; });

  assert.ok(explainCommand(config, ["dev", "write", abs]).allowed,
    "the absolute spelling is allowed, like the relative one");
  assert.ok(explainCommand(config, ["dev", "write", "src/api/orders.ts"]).allowed);
  assert.deepEqual(whose(config, [abs]).owners, ["dev"],
    "and both commands name the same owner for the same file");
});

test("a path outside the repo keeps its honest answer", () => {
  // Stripping must not turn "somewhere else entirely" into a repo-relative
  // guess: /etc/hosts is owned by nobody and saying so is correct.
  const config = policy(["src/api"]);
  assert.deepEqual(ownersOf(config, "/etc/hosts"), []);
});
