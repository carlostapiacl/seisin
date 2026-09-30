/**
 * Fixes from the code review of 2026-09-30, core modules: owners, redact,
 * scan, config, surface and inspect. One test per finding, each written to
 * fail on the code as it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { covers, ownersOf, keyHolders, explain } from "../src/owners.js";
import { loadConfig } from "../src/config.js";
import { redactor } from "../src/redact.js";
import { scratch } from "./_tmp.js";

/** A policy on disk, loaded. */
function policy(toml) {
  const dir = scratch("seisin-review-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return loadConfig(join(dir, "seisin.toml"));
}

/** Everything a redactor emits for these chunks, as one string. */
function through(r, chunks) {
  let out = "";
  r.setEncoding("utf8");
  r.on("data", (d) => (out += d));
  for (const c of chunks) r.write(c);
  r.end();
  return new Promise((done) => r.on("end", () => done(out)));
}

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
  // The shape a real cell policy uses: its log lives beside its directory.
  assert.equal(covers("../bitacora/lab/dev.md", "../bitacora/lab/dev.md"), true);
  assert.equal(covers("../bitacora/**", "../bitacora/lab/dev.md"), true);
  assert.equal(covers("../bitacora/lab/dev.md", "../otra/dev.md"), false);
});

test("explain does not call a path outside the repo 'inside territory'", () => {
  const cfg = policy(`
[roles.dev]
writes = ["**"]
[roles.lab]
writes = ["../bitacora/lab/dev.md"]
`);
  const out = explain(cfg, "dev", "write", "../../etc/passwd");
  assert.equal(out.allowed, false);
  assert.deepEqual(ownersOf(cfg, "../../etc/passwd"), []);
  assert.equal(explain(cfg, "lab", "write", "../bitacora/lab/dev.md").allowed, true);
  assert.deepEqual(ownersOf(cfg, "../bitacora/lab/dev.md"), ["lab"]);
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

// ── redact: a chunk boundary inside a character ─────────────────────────────

test("a multibyte character split across chunks passes through intact", async () => {
  const bytes = Buffer.from("el año\n");
  const at = bytes.indexOf(0xc3) + 1;             // between the two bytes of ñ
  const out = await through(redactor(["no-aparece-nunca-1234"]), [bytes.subarray(0, at), bytes.subarray(at)]);
  assert.equal(out, "el año\n");
});

test("'año' split at byte 2 comes out whole", async () => {
  const bytes = Buffer.from("año");
  const out = await through(redactor(["otro-secreto-largo"]), [bytes.subarray(0, 2), bytes.subarray(2)]);
  assert.equal(out, "año");
});

test("a secret with a multibyte character, split inside it, is still masked", async () => {
  const secret = "contraseña-muy-larga-99";
  const bytes = Buffer.from(`la clave es ${secret} y nada más\n`);
  const at = bytes.indexOf(0xc3) + 1;
  const out = await through(redactor([secret]), [bytes.subarray(0, at), bytes.subarray(at)]);
  assert.ok(!out.includes(secret), out);
  assert.match(out, /‹redacted›/);
  assert.match(out, /nada más/);
});

test("an emoji at the cut is not split into two halves", async () => {
  const text = "x".repeat(40) + "😀" + "y".repeat(40);
  const chunks = [...Buffer.from(text)].map((b) => Buffer.from([b]));
  const out = await through(redactor(["s".repeat(30)]), chunks);
  assert.equal(out, text);
});
