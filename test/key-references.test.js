/**
 * A key that is a reference: how it is read, spelled and refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { explain, readTarget } from "../src/owners.js";
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

/* ── 2. a reference key is explained as a key ──────────────────────────── */

const REFS =
  '[keys]\ndir = ".secrets"\n' +
  '[keys.providers.keychain]\ncommand = ["security", "find-generic-password", "-w", "-s", "{ref}"]\n' +
  '[roles.dev]\nwrites = ["src/**"]\nkeys = ["keychain://x", "TOK=file://.secrets/a.env#TOK"]\n' +
  '[roles.qa]\nwrites = ["test/**"]\n';

test("a reference is read as a key, spelled as written — not as a path", () => {
  const { cfg } = repo(REFS);
  assert.deepEqual(readTarget(cfg, "keychain://x"), { key: true, target: "keychain://x" });
});

test("the role that declares a reference is told so, and which provider resolves it", () => {
  const { cfg } = repo(REFS);
  const v = explain(cfg, "dev", "read", "keychain://x");
  assert.equal(v.allowed, true);
  assert.match(v.reason, /dev declares keychain:\/\/x/);
  assert.match(v.reason, /\[keys\.providers\.keychain\]/);
  assert.doesNotMatch(v.reason, /keychain:\/x|outside every \[keys\] dir/);
  const f = explain(cfg, "dev", "read", "file://.secrets/a.env#TOK");
  assert.equal(f.allowed, true);
  assert.match(f.reason, /built-in file:\/\/ provider/);
});

test("a role that does not declare it is denied, with the owner named", () => {
  const { cfg } = repo(REFS);
  const v = explain(cfg, "qa", "read", "keychain://x");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.owners, ["dev"]);
  const none = explain(cfg, "dev", "read", "keychain://y");
  assert.equal(none.allowed, false);
  assert.match(none.reason, /no role declares keychain:\/\/y/);
  const noProvider = explain(cfg, "dev", "read", "vault://z");
  assert.equal(noProvider.allowed, false);
  assert.match(noProvider.reason, /no \[keys\.providers\.vault\] is declared/);
});
