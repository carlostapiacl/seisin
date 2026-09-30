/**
 * Fixes from the code review of 2026-09-30, core modules: owners, redact,
 * scan, config, surface and inspect. One test per finding, each written to
 * fail on the code as it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { covers, ownersOf, keyHolders, explain } from "../src/owners.js";
import { loadConfig } from "../src/config.js";
import { redactor } from "../src/redact.js";
import { scan } from "../src/scan.js";
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

// ── scan: the cap never hides a certain finding ─────────────────────────────

test("certain findings after the review cap are still reported, and the cap says so", () => {
  const box = scratch("seisin-scan-");
  // Sorted first by readdir on every filesystem this runs on: "a" < "z".
  writeFileSync(join(box, "a-noise.py"),
    Array.from({ length: 30 }, (_, i) => `DB_PASSWORD_${i} = "literal-value-${i}-xxxx"`).join("\n"));
  writeFileSync(join(box, "z-token.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const { hits, truncated, omitted } = scan(box, [], [], 10);
  assert.equal(hits.filter((h) => h.level === "certain").length, 1);
  assert.equal(hits.filter((h) => h.level === "review").length, 10);
  assert.equal(truncated, true);
  assert.equal(omitted, 20);
});

test("a key directory written with a trailing slash is still not scanned", () => {
  const box = scratch("seisin-scan-");
  mkdirSync(join(box, ".secrets"));
  writeFileSync(join(box, ".secrets", "gh.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const { hits, skipped } = scan(box, [".secrets/"]);
  assert.deepEqual(hits, []);
  assert.equal(skipped.protectedDirs, 1);
});

test("scan resolves its root, so a link inside a linked root is not 'out of the repo'", () => {
  const real = scratch("seisin-scan-");
  mkdirSync(join(real, "tree"));
  writeFileSync(join(real, "tree", "a.txt"), "nada\n");
  symlinkSync(join(real, "tree", "a.txt"), join(real, "tree", "link"));
  const alias = join(scratch("seisin-scan-"), "alias");
  symlinkSync(join(real, "tree"), alias);
  const { hits } = scan(alias, []);
  assert.deepEqual(hits.filter((h) => h.level === "link"), []);
});

test("scan skips compiled python and nested checkouts, and counts the checkouts", () => {
  const box = scratch("seisin-scan-");
  writeFileSync(join(box, "mod.pyc"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  mkdirSync(join(box, "otro", ".git"), { recursive: true });
  writeFileSync(join(box, "otro", "k.txt"), "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n");
  // A worktree: `.git` is a file, and it is still another checkout.
  mkdirSync(join(box, "wt"));
  writeFileSync(join(box, "wt", ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(box, "wt", "k.txt"), "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n");
  // The root's own .git is not a reason to skip the root.
  mkdirSync(join(box, ".git"));
  writeFileSync(join(box, "own.txt"), "ghp_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\n");
  const { hits, skipped } = scan(box, []);
  assert.deepEqual(hits.map((h) => h.file), ["own.txt"]);
  assert.equal(skipped.nested, 2);
});

// ── config: nothing outside the roles is ignored silently ───────────────────

test("a misspelt [runtime] setting is refused with its line", () => {
  assert.throws(() => policy(`[runtime]\nisolaet = true\n\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:2: \[runtime\] "isolaet" is not a setting .*did you mean "isolate"/);
});

test("an unknown table or root key is refused with its line", () => {
  assert.throws(() => policy(`[roles.a]\nwrites = ["a/**"]\n\n[netwrok]\nallow = []\n`),
    /seisin\.toml:4: "netwrok" is not a setting or a table .*did you mean "network"/);
  assert.throws(() => policy(`isolate = true\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:1: "isolate" is not a setting/);
  assert.throws(() => policy(`[keys.providers.k]\ncommand = ["x", "{ref}"]\nmodo = "env"\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:3: \[keys\.providers\.k\] "modo"/);
  assert.throws(() => policy(`[notify]\nurl_fiel = ".secrets/x"\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:2: \[notify\] "url_fiel"/);
  assert.throws(() => policy(`[runtime.isolate]\nx = true\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:1: \[runtime\.isolate\] is a table/);
});

test("every setting the docs name still loads", () => {
  const cfg = policy(`
[keys]
dir = ".secrets/"
[keys.providers.k]
command = ["x", "{ref}"]
mode = "env"
[network]
allow = "github.com"
[runtime]
writes = []
isolate = "credentials"
redact = false
[scan]
ignore = ["fixtures/**"]
[protect]
instructions = true
[notify]
format = "text"
[roles.a]
writes = ["a/**"]
`);
  assert.deepEqual(cfg.allowedDomains, ["github.com"]);   // not ["g","i","t",…]
  assert.deepEqual(cfg.keyDirs, [".secrets"]);
  assert.equal(cfg.redact, false);
});

test("runtime.redact must be a boolean", () => {
  assert.throws(() => policy(`[runtime]\nredact = "no"\n[roles.a]\nwrites = ["a/**"]\n`),
    /runtime\.redact must be true or false/);
});

test("a ] inside a quoted item does not end a multi-line array", () => {
  const cfg = policy(`[roles.a]\nwrites = ["a]b/**",\n  "c/**"]\n`);
  assert.deepEqual(cfg.roles.a.writesDeclared, ["a]b/**", "c/**"]);
});

test("a key directory with a trailing slash matches its keys", () => {
  const cfg = policy(`[keys]\ndir = ".secrets/"\n[roles.a]\nwrites = ["a/**"]\nkeys = ["x.txt"]\n`);
  assert.deepEqual(keyHolders(cfg, ".secrets/x.txt"), ["a"]);
});
