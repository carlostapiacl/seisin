/**
 * Five small answers that were not true after 0.5.0.
 *
 * Each test states what a person reads and what it now says. They are about
 * sentences rather than boundaries: none of these changed what the kernel
 * allows, and every one of them told the reader something the policy did not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "../src/inspect.js";
import { loadConfig } from "../src/config.js";
import { explain, readTarget } from "../src/owners.js";
import { wallsCommand, renderForPerson } from "../src/commands/walls.js";
import { scratch } from "./_tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/* ── 3. `check <role>` names the files the warning points at ───────────── */

test("the individual-files warning points at check <role>, and check <role> names them", () => {
  const two = '[roles.dev]\nwrites = ["data/app.sqlite", "src/a.js"]\n[roles.qa]\nwrites = ["test/**"]\n';
  const { cfg } = repo(two, ["data/app.sqlite", "src/a.js", "test/x"]);
  const all = warnings(cfg).find((x) => x.kind === "siblings-uncovered");
  assert.match(all.detail, /`seisin check <role>` names the files/);
  const one = warnings(cfg, "dev").find((x) => x.kind === "siblings-uncovered");
  assert.match(one.detail, /The files: data\/app\.sqlite src\/a\.js\./);
});

/* ── 4. `seisin walls` says what kind of thing an unowned path is ─────── */

test("walls in the terminal gives an unowned path the console's kind and hint", () => {
  const { root, cfg } = repo('[roles.dev]\nwrites = ["src/**"]\n[roles.ops]\nwrites = ["deploy/**"]\n');
  mkdirSync(join(root, ".seisin"), { recursive: true });
  const line = (t) => JSON.stringify({ at: "2026-09-30T10:00:00.000Z", role: "dev", action: "write", target: t, verdict: "denied" });
  writeFileSync(join(root, ".seisin", "log.jsonl"),
    ["dist/app.js", "dist/app.js", ".env", ".env", "notes/plan.md", "notes/plan.md", "deploy/x.yml", "deploy/x.yml"]
      .map(line).join("\n") + "\n");
  const shown = wallsCommand(cfg, ["dev"]);
  const said = renderForPerson("dev", shown).replace(/\x1b\[[0-9;]*m/g, "");
  assert.doesNotMatch(said, /no role can write it until one claims it/);
  assert.match(said, /\.env {2}unowned · credential: credential-shaped: never grant a write/);
  assert.match(said, /dist\/app\.js {2}unowned · build: build output/);
  assert.match(said, /notes\/plan\.md {2}unowned · ownable: an ownable path no role claims/);
  assert.match(said, /deploy\/x\.yml {2}belongs to ops/);
});

/* ── 5. the comment says where the Linux limit is said ─────────────────── */

test("violations.js does not claim `run` announces the Linux limit", () => {
  const src = readFileSync(join(ROOT, "src", "violations.js"), "utf8");
  assert.doesNotMatch(src, /`seisin run` says so once/);
  assert.match(src, /`seisin check` says it/);
});
