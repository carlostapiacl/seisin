/**
 * A SQLite database is four files, declared once.
 *
 * The property that makes this safe to do implicitly is that it grants nothing
 * new — so the tests are mostly about where the expansion is VISIBLE, not just
 * that it happens. A boundary the kernel enforces and the sentence does not
 * know about is the failure this repo keeps finding in other people's tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, withSidecars } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { ownersOf, explain } from "../src/owners.js";
import { scratch } from "./_tmp.js";

function repo(writes) {
  const dir = scratch("seisin-side-");
  mkdirSync(join(dir, "data"), { recursive: true });
  writeFileSync(join(dir, "seisin.toml"),
    `[roles.dev]\nwrites = [${writes.map((w) => `"${w}"`).join(", ")}]\n`);
  return { dir, cfg: loadConfig(join(dir, "seisin.toml")) };
}

test("a declared database carries its three sidecars", () => {
  assert.deepEqual(withSidecars(["data/x.sqlite"]),
    ["data/x.sqlite", "data/x.sqlite-wal", "data/x.sqlite-shm", "data/x.sqlite-journal"]);
});

test("the expansion reaches the kernel as literal paths, not as a glob", () => {
  // `x.sqlite*` is unenforceable — the kernel grants a path and everything
  // under it — so these have to arrive spelled out, exactly as if typed.
  const { dir, cfg } = repo(["data/x.sqlite"]);
  const w = settingsFor(cfg, "dev").filesystem.allowWrite.join(" ");
  for (const s of ["-wal", "-shm", "-journal"]) assert.ok(w.includes("x.sqlite" + s), s);
  assert.ok(!w.includes("*"));
  rmSync(dir, { recursive: true, force: true });
});

test("and it reaches the SENTENCE too — the owner of a database owns its -wal", () => {
  // The half that matters. Expanding only at emit time would have the kernel
  // allow the write while `seisin whose` answered "nobody", which is the exact
  // divergence between the document and the boundary this repo hunts for.
  const { dir, cfg } = repo(["data/x.sqlite"]);
  assert.deepEqual(ownersOf(cfg, "data/x.sqlite-wal"), ["dev"]);
  assert.ok(explain(cfg, "dev", "write", "data/x.sqlite-shm").allowed);
  rmSync(dir, { recursive: true, force: true });
});

test("a policy that already lists them does not grow, and keeps its order", () => {
  // 744 of them exist in the wild; re-expanding must be a no-op.
  const before = ["data/x.sqlite", "data/x.sqlite-wal", "data/x.sqlite-shm", "data/x.sqlite-journal"];
  assert.deepEqual(withSidecars(before), before);
});

test(".sqlite3 counts; .db deliberately does not", () => {
  // `.db` is used by plenty of things that are not SQLite, and granting the
  // creation of `whatever.db-wal` inside somebody else's directory would be
  // new authority arriving quietly. That case declares its sidecars by hand.
  assert.equal(withSidecars(["a.sqlite3"]).length, 4);
  assert.deepEqual(withSidecars(["a.db"]), ["a.db"]);
  assert.deepEqual(withSidecars(["notes.md"]), ["notes.md"]);
  assert.deepEqual(withSidecars(["src/**"]), ["src/**"]);
});

test("what a person wrote is kept apart from what was granted", () => {
  // So that regenerating a config writes back the four lines somebody typed as
  // one, rather than the expansion.
  const { dir, cfg } = repo(["data/x.sqlite", "src/**"]);
  assert.deepEqual(cfg.roles.dev.writesDeclared, ["data/x.sqlite", "src/**"]);
  assert.equal(cfg.roles.dev.writes.length, 5);
  rmSync(dir, { recursive: true, force: true });
});
