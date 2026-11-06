/**
 * A database and its sidecars, as a role is told about them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "../src/inspect.js";
import { loadConfig } from "../src/config.js";
import { scratch } from "./_tmp.js";

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

/* ── 1. a database's implicit sidecars are part of it ───────────────────── */

test("a granted database does not warn about its sidecars, nor count them as files", () => {
  // Before: two "matches nothing" lines (-shm, -journal — the -wal happened to
  // exist) and "dev (3 of 5)" for a role that wrote two files.
  const { cfg } = repo('[roles.dev]\nwrites = ["data/app.sqlite", "src/a.js"]\n',
    ["data/app.sqlite", "data/app.sqlite-wal", "src/a.js"]);
  const w = warnings(cfg);
  const nothing = w.filter((x) => x.kind === "writes-match-nothing").map((x) => x.headline);
  assert.deepEqual(nothing, [], nothing.join("\n"));
  const loose = w.find((x) => x.kind === "siblings-uncovered");
  assert.match(loose.headline, /dev \(2 of 2\)/);
});

test("a sidecar declared without its database is still the role's own, and still reported", () => {
  const { cfg } = repo('[roles.dev]\nwrites = ["data/other.sqlite-wal"]\n', []);
  const nothing = warnings(cfg).filter((x) => x.kind === "writes-match-nothing").map((x) => x.headline);
  assert.equal(nothing.length, 1);
  assert.match(nothing[0], /other\.sqlite-wal/);
});
