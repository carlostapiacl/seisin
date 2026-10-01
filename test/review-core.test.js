/**
 * Fixes from the code review of 2026-09-30, core modules: owners, redact,
 * scan, config, surface and inspect. One test per finding, each written to
 * fail on the code as it was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { covers, ownersOf, keyHolders, explain } from "../src/owners.js";
import { loadConfig } from "../src/config.js";
import { redactor } from "../src/redact.js";
import { scan } from "../src/scan.js";
import { inspect, sharedPaths } from "../src/inspect.js";
import { parentInputs, denyFor, protections, writableRoots, protectedBy } from "../src/surface.js";
import { review } from "../src/review.js";
import { toRepoRelative } from "../src/paths.js";
import { realOrSelf } from "../src/grants.js";
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

test("key directories and the policy are protected by a field, not by their wording", () => {
  const cfg = policy(`
[keys]
dir = ".secrets"
[roles.a]
writes = ["a/**"]
`);
  const inputs = parentInputs(cfg);
  assert.ok(inputs.filter((e) => e.always).some((e) => e.why === "a key directory"));
  assert.ok(inputs.filter((e) => e.always).some((e) => e.why === "the policy"));
  // Outside a's territory, and still in its profile.
  const denies = denyFor(cfg, cfg.roles.a, { platform: "darwin" });
  assert.ok(denies.some((e) => e.path.endsWith("/.secrets")));
  assert.ok(denies.some((e) => e.path.endsWith("/seisin.toml")));
  // Never shown by check: closed since the first release.
  assert.ok(!protections(cfg).some((e) => e.always || e.why === "a key directory"));
  // Memoised per config, not per call.
  assert.equal(writableRoots(cfg), writableRoots(cfg));
  assert.equal(parentInputs(cfg), parentInputs(cfg));
});

test("a project's .codex is protected whole, as .claude is: config, hooks and rules", () => {
  // Codex reads all three from any project the user has trusted, and keeps
  // `.codex` read-only inside its own writable roots. Measured 2026-09-30.
  const cfg = policy(`[roles.a]\nwrites = ["**"]\n`);
  for (const f of ["p/.codex/config.toml", "p/.codex/hooks.json", ".codex/rules/default.rules", "p/.codex"]) {
    const hit = protectedBy(cfg, f, { platform: "darwin" });
    assert.ok(hit, f);
    assert.match(hit.why, /Codex runs outside the sandbox/, f);
  }
  const globs = denyFor(cfg, cfg.roles.a, { platform: "darwin" }).map((e) => e.path);
  assert.ok(globs.some((g) => g.endsWith("/**/.codex")), "creating one is refused too");
  assert.ok(globs.some((g) => g.endsWith("/**/.codex/**")));
});

test("Codex's home: what it runs or obeys is denied, what it writes every turn is not", () => {
  // The default runtime grants ~/.codex, because Codex keeps its sessions and
  // state databases there. Inside it, the control files are taken back one by one.
  const cfg = policy(`[roles.a]\nwrites = ["a/**"]\n`);
  const paths = denyFor(cfg, cfg.roles.a, { platform: "darwin" }).map((e) => e.path);
  const home = join(homedir(), ".codex");
  for (const f of ["config.toml", "hooks.json", "rules", "skills", "plugins", "managed_config.toml"])
    assert.ok(paths.includes(join(home, f)), f);
  assert.ok(paths.includes(`${home}/*.config.toml`), "a profile created later");
  for (const f of ["", "sessions", "log", "cache", "history.jsonl", "auth.json"])
    assert.ok(!paths.includes(join(home, f).replace(/\/$/, "")), `${f || "~/.codex"} must stay writable`);
  // And explain says the same, entry by entry: a session file is not protected.
  assert.match(protectedBy(cfg, join(home, "plugins", "cache", "x"), { platform: "darwin" }).why, /^\.codex\/plugins,/);
  assert.match(protectedBy(cfg, join(home, "work.config.toml"), { platform: "darwin" }).why, /^\.codex\/work\.config\.toml,/);
  for (const f of ["sessions/2026/09/30/rollout.jsonl", "history.jsonl", "auth.json"])
    assert.equal(protectedBy(cfg, join(home, f), { platform: "darwin" }), null, f);
  // Without ~/.codex in the runtime, nothing of it is in the profile.
  const narrow = policy(`[runtime]\nwrites = ["$TMPDIR"]\n[roles.a]\nwrites = ["a/**"]\n`);
  assert.ok(!denyFor(narrow, narrow.roles.a, { platform: "darwin" }).some((e) => e.path.startsWith(home)));
});

test("protectedBy still names every control file, case-folded, and only whole segments", () => {
  const cfg = policy(`[roles.a]\nwrites = ["**"]\n`);
  for (const f of [".git/hooks/pre-commit", "x/.mcp.json", ".envrc", "p/.codex/config.toml", ".CLAUDE/settings.json"])
    assert.ok(protectedBy(cfg, f, { platform: "darwin" }), f);
  for (const f of ["xmcpxjson", "a.mcp.json", "x/.envrc.bak", "p/.codexx/config.toml", "p/x.codex"])
    assert.equal(protectedBy(cfg, f, { platform: "darwin" }), null, f);
  assert.ok(protectedBy(cfg, ".VSCODE/tasks.json", { platform: "darwin" }));
  assert.equal(protectedBy(cfg, ".VSCODE/tasks.json", { platform: "linux" }), null);
});

test("review counts a write as use of its own role's territory only", () => {
  const cfg = policy(`
[roles.a]
writes = ["src/**", "docs/**"]
[roles.b]
writes = ["src/**"]
`);
  mkdirSync(join(cfg.root, ".seisin"));
  const line = (role, target) => JSON.stringify({ at: new Date().toISOString(), role, action: "write", target, verdict: "allowed" });
  writeFileSync(join(cfg.root, ".seisin", "log.jsonl"),
    [line("a", "src/x.ts"), line("a", "src/x.ts"), line("ghost", "docs/y.md")].join("\n") + "\n");
  const { unused } = review(cfg);
  assert.deepEqual(unused.map((u) => `${u.role} ${u.glob}`).sort(), ["a docs/**", "b src/**"]);
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

test("check does not call a provider missing when it is only where a role writes", () => {
  const dir = scratch("seisin-prov-");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "miprov"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.p]\ncommand = ["miprov", "{ref}"]\n[roles.a]\nwrites = ["**"]\nkeys = ["p://x"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const before = process.env.PATH;
  process.env.PATH = `${join(dir, "bin")}:${before}`;
  try {
    const kinds = inspect(cfg).warnings.map((w) => w.kind);
    assert.ok(kinds.includes("provider-in-territory"));
    assert.ok(!kinds.includes("provider-missing"));
  } finally {
    process.env.PATH = before;
  }
});
