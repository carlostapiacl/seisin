/**
 * Keys that are references, and how they are delivered.
 *
 * No provider is ever really spawned here: `resolveRef` takes its runner, so
 * these exercise the decisions — what is a reference, what is refused, what
 * reaches the child — without a keychain prompt in the middle of the suite.
 * The one thing a fake runner cannot check is that the parent is the one
 * spawning, and that is asserted structurally instead: `settingsFor` never
 * sees a reference at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseKey, defaultName, modeOf, resolveRef, resolveKeys, entriesOf, MODES } from "../src/keys.js";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { inspect } from "../src/inspect.js";

/** A repo with a seisin.toml in it, and a .secrets to hold path-keys. */
function repo(toml) {
  const dir = mkdtempSync(join(tmpdir(), "seisin-keys-"));
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  writeFileSync(join(dir, ".secrets", "netlify-token.txt"), "nfp_aaaaaaaaaaaaaaaa\n");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

/** A provider runner that answers from a table instead of a vault. */
const fake = (answers, { status = 0, stderr = "" } = {}) => (cmd, args) => {
  const ref = args.join(" ");
  return { status, stdout: answers[ref] ?? answers["*"] ?? "", stderr, error: undefined };
};

// ── what an entry IS ────────────────────────────────────────────────────────

test("a path is still a path, which is the whole backwards-compatibility story", () => {
  const e = parseKey("netlify-token.txt");
  assert.equal(e.kind, "file");
  assert.equal(e.raw, "netlify-token.txt");
});

test("a scheme makes it a reference, and the rest is one reference and not three", () => {
  const e = parseKey("op://vault/item/field");
  assert.equal(e.kind, "ref");
  assert.equal(e.scheme, "op");
  assert.equal(e.ref, "vault/item/field");
});

test("a Windows path and a relative path with a colon do not read as references", () => {
  assert.equal(parseKey("C:\\secrets\\token.txt").kind, "file");
  assert.equal(parseKey("./weird:name.txt").kind, "file");
});

test("the derived name is the last segment, and it is printable before a run", () => {
  assert.equal(defaultName("netlify-token"), "NETLIFY_TOKEN");
  assert.equal(defaultName("vault/item/field"), "FIELD");
  assert.equal(parseKey("keychain://netlify-token").name, "NETLIFY_TOKEN");
});

test("a derivation that would produce an unsettable variable gets a prefix instead", () => {
  // Not reachable from a sane vault name. It is here because a failure at
  // spawn time, on a name nobody wrote, is the worst place to find this out.
  assert.match(defaultName("123"), /^KEY_/);
  assert.match(defaultName("--"), /^KEY_/);
});

test("NAME= in front says which variable, so nothing has to be guessed", () => {
  const e = parseKey("NETLIFY_AUTH_TOKEN=keychain://netlify-token");
  assert.equal(e.name, "NETLIFY_AUTH_TOKEN");
  assert.equal(e.ref, "netlify-token");
});

test("NAME= in front of a PATH is refused, because it asks for something that will not happen", () => {
  assert.throws(() => parseKey("TOKEN=netlify-token.txt"), /is a path, not a reference/);
});

// ── what the config refuses ─────────────────────────────────────────────────

test("an unknown scheme is refused, not ignored", () => {
  // The alternative — a key that quietly never arrives — is a policy that
  // reads as protecting something it is not.
  const dir = repo(`[keys]\ndir = [".secrets"]\n\n[roles.frontend]\nkeys = ["vault://x"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /no \[keys.providers.vault\] is declared/);
  rmSync(dir, { recursive: true, force: true });
});

test("the refusal names the providers that DO exist, so the typo is visible", () => {
  const dir = repo(
    `[keys.providers.keychain]\ncommand = ["security", "-w", "{ref}"]\n\n` +
    `[roles.frontend]\nkeys = ["keychan://x"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /Declared providers: keychain/);
  rmSync(dir, { recursive: true, force: true });
});

test("a provider with no {ref} is refused: every key would resolve to the same value", () => {
  const dir = repo(`[keys.providers.op]\ncommand = ["op", "read"]\n\n[roles.frontend]\nkeys = []\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /no \{ref\}/);
  rmSync(dir, { recursive: true, force: true });
});

test("a provider without a command is refused", () => {
  const dir = repo(`[keys.providers.op]\nmode = "env"\n\n[roles.frontend]\nkeys = []\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /needs a command/);
  rmSync(dir, { recursive: true, force: true });
});

test("references need no [keys] dir — a config whose secrets are all in a vault is fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-keys-"));
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.keychain]\ncommand = ["security", "{ref}"]\nmode = "env"\n\n` +
    `[roles.frontend]\nwrites = ["src/**"]\nkeys = ["keychain://t"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(cfg.roles.frontend.keyEntries[0].kind, "ref");
  rmSync(dir, { recursive: true, force: true });
});

test("a PATH key with no [keys] dir is still refused, which was the rule before", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-keys-"));
  writeFileSync(join(dir, "seisin.toml"), `[roles.frontend]\nkeys = ["token.txt"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /\[keys\] dir is not set/);
  rmSync(dir, { recursive: true, force: true });
});

// ── delivery mode ───────────────────────────────────────────────────────────

const cfgWith = (roleLine, providerLine = 'command = ["security", "{ref}"]') => {
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.keychain]\n${providerLine}\n\n` +
    `[roles.frontend]\nwrites = ["src/**"]\n${roleLine}\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  return { cfg, dir };
};

test("a reference with no mode anywhere is an error, because the two answers differ", () => {
  const { cfg, dir } = cfgWith('keys = ["keychain://t"]');
  assert.throws(() => modeOf(cfg, cfg.roles.frontend, cfg.roles.frontend.keyEntries[0]),
    /has no delivery mode/);
  rmSync(dir, { recursive: true, force: true });
});

test("the provider can carry the default, and the role overrides it", () => {
  const a = cfgWith('keys = ["keychain://t"]', 'command = ["security", "{ref}"]\nmode = "env"');
  assert.equal(modeOf(a.cfg, a.cfg.roles.frontend, a.cfg.roles.frontend.keyEntries[0]), "env");
  const b = cfgWith('keys = ["keychain://t"]\nkey_mode = "scratch"',
    'command = ["security", "{ref}"]\nmode = "env"');
  assert.equal(modeOf(b.cfg, b.cfg.roles.frontend, b.cfg.roles.frontend.keyEntries[0]), "scratch");
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

test("inject is refused by name, and the refusal says what it would cost", () => {
  // Not "not supported": the mode where the agent never sees the value is the
  // one people will reach for, and it is not free. Refused rather than
  // half-available, with the price in the message and not in a doc.
  const { cfg, dir } = cfgWith('keys = ["keychain://t"]\nkey_mode = "inject"');
  assert.throws(() => modeOf(cfg, cfg.roles.frontend, cfg.roles.frontend.keyEntries[0]),
    /not implemented[\s\S]*TLS[\s\S]*MITM/);
  rmSync(dir, { recursive: true, force: true });
});

test('"file" is not a mode, and the error says why, because it is the word everybody reaches for', () => {
  // The runtime has a `credentials.files` that takes paths and, on macOS,
  // makes them unreadable instead of masking — so a mode called `file` next to
  // it is a trap. Guessing costs a debugging session; the message costs a line.
  assert.ok(!MODES.includes("file"));
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.keychain]\ncommand = ["security", "{ref}"]\n\n` +
    `[roles.frontend]\nkeys = ["keychain://t"]\nkey_mode = "file"\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /is not a delivery mode/);
  rmSync(dir, { recursive: true, force: true });
});

// ── resolving ───────────────────────────────────────────────────────────────

const refOf = (raw) => parseKey(raw);
const provider = { name: "keychain", command: ["security", "find", "-s", "{ref}"], mode: "env" };

test("{ref} is substituted wherever it appears, and the value comes back", () => {
  let seen;
  const run = (cmd, args) => { seen = [cmd, ...args]; return { status: 0, stdout: "s3cr3t-value\n" }; };
  const v = resolveRef(refOf("keychain://netlify-token"), provider, { run });
  assert.deepEqual(seen, ["security", "find", "-s", "netlify-token"]);
  assert.equal(v, "s3cr3t-value");
});

test("exactly one trailing newline is the shell's, and it is dropped", () => {
  // A token with a newline welded to it fails authentication in a way that
  // looks like a wrong token.
  assert.equal(resolveRef(refOf("keychain://t"), provider,
    { run: () => ({ status: 0, stdout: "abc\n" }) }), "abc");
  // Two is not the shell's, so the second is the value's and stays.
  assert.equal(resolveRef(refOf("keychain://t"), provider,
    { run: () => ({ status: 0, stdout: "abc\n\n" }) }), "abc\n");
});

test("a provider that fails stops the run — it does not degrade to anything", () => {
  assert.throws(() => resolveRef(refOf("keychain://t"), provider,
    { run: () => ({ status: 1, stdout: "", stderr: "not signed in" }) }),
    /exited 1[\s\S]*not signed in/);
});

test("a provider that succeeds and prints nothing is a failure, not an empty key", () => {
  assert.throws(() => resolveRef(refOf("keychain://t"), provider,
    { run: () => ({ status: 0, stdout: "" }) }), /printed nothing/);
});

test("a provider that cannot be started says so, naming the binary", () => {
  assert.throws(() => resolveRef(refOf("keychain://t"), provider,
    { run: () => ({ error: new Error("spawn ENOENT") }) }), /could not run the keychain provider \(security\)/);
});

test("what the provider printed on stdout never reaches the error message", () => {
  // A provider that prints the secret and then exits non-zero would otherwise
  // put it in the terminal and in the log — a second plaintext copy with worse
  // access control than the first.
  let msg = "";
  try {
    resolveRef(refOf("keychain://t"), provider,
      { run: () => ({ status: 2, stdout: "SUPER-SECRET-VALUE", stderr: "auth required" }) });
  } catch (e) { msg = e.message; }
  assert.ok(msg.includes("auth required"));
  assert.ok(!msg.includes("SUPER-SECRET-VALUE"));
});

test("every mode is checked before any provider runs", () => {
  // A config with a bad second key should say so without asking anyone's
  // keychain for a password to find out about the first.
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.keychain]\ncommand = ["security", "{ref}"]\nmode = "env"\n\n` +
    `[keys.providers.op]\ncommand = ["op", "read", "{ref}"]\n\n` +
    `[roles.frontend]\nkeys = ["keychain://a", "op://b"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  let ran = 0;
  assert.throws(() => resolveKeys(cfg, cfg.roles.frontend, { run: () => { ran++; return { status: 0, stdout: "x" }; } }),
    /has no delivery mode/);
  assert.equal(ran, 0, "no provider should have been spawned");
  rmSync(dir, { recursive: true, force: true });
});

test("resolveKeys ignores path keys — they are the filesystem's problem, not a provider's", () => {
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.keychain]\ncommand = ["security", "{ref}"]\nmode = "env"\n\n` +
    `[roles.frontend]\nkeys = ["netlify-token.txt", "keychain://a"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const got = resolveKeys(cfg, cfg.roles.frontend, { run: fake({ a: "value-a" }) });
  assert.equal(got.length, 1);
  assert.equal(got[0].entry.scheme, "keychain");
  assert.equal(got[0].value, "value-a");
  rmSync(dir, { recursive: true, force: true });
});

// ── what reaches the kernel ─────────────────────────────────────────────────

test("a reference never becomes a read grant, because there is no path to grant", () => {
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.keychain]\ncommand = ["security", "{ref}"]\nmode = "env"\n\n` +
    `[roles.frontend]\nwrites = ["src/**"]\nkeys = ["keychain://netlify-token", "netlify-token.txt"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const s = settingsFor(cfg, "frontend");
  const reads = s.filesystem.allowRead.join(" ");
  assert.ok(reads.includes("netlify-token.txt"), "the path key is still granted");
  assert.ok(!reads.includes("keychain"), "the reference is not a path and is not in the settings");
  assert.equal(s.filesystem.allowRead.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("a role object built by hand, with only `keys`, still works", () => {
  // The shape that shipped. An embedder holding seisin as a library has it.
  assert.deepEqual(entriesOf({ keys: ["a.txt"] }).map((e) => e.kind), ["file"]);
  assert.deepEqual(entriesOf({ keys: [] }), []);
  assert.deepEqual(entriesOf({}), []);
});

// ── what check can say without resolving anything ───────────────────────────

test("check warns when a provider's command is not on PATH, and asks nobody for a password", () => {
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.vault]\ncommand = ["definitely-not-installed-xyz", "{ref}"]\nmode = "env"\n\n` +
    `[roles.frontend]\nwrites = ["src/**"]\nkeys = ["vault://t"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const w = inspect(cfg, null, "seisin.toml").warnings;
  assert.ok(w.some((x) => x.kind === "provider-missing"));
  rmSync(dir, { recursive: true, force: true });
});

test("a config with only references does not get told its [keys] dir is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-keys-"));
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.keychain]\ncommand = ["sh", "{ref}"]\nmode = "env"\n\n` +
    `[roles.frontend]\nwrites = ["src/**"]\nkeys = ["keychain://t"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const w = inspect(cfg, null, "seisin.toml").warnings;
  assert.ok(!w.some((x) => x.kind === "keys-unscoped"));
  rmSync(dir, { recursive: true, force: true });
});

// ── names that would collide ────────────────────────────────────────────────

test("a key that would arrive as PATH is refused when the config loads", () => {
  // Measured before this check existed: the sandbox started with PATH set to
  // the secret and died with `env: node: No such file or directory` — a config
  // mistake that reads exactly like a broken installation.
  const dir = repo(
    `[keys.providers.k]\ncommand = ["printf", "%s", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["k://path"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /would arrive as PATH/);
  rmSync(dir, { recursive: true, force: true });
});

test("a key may not be called SEISIN_ROLE, which is how the hook knows who it is", () => {
  // A policy that could set it could tell the hook inside the box that it is
  // another role. Privilege confusion written in the file meant to prevent it.
  const dir = repo(
    `[keys.providers.k]\ncommand = ["printf", "%s", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["SEISIN_ROLE=k://x"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /would arrive as SEISIN_ROLE/);
  rmSync(dir, { recursive: true, force: true });
});

test("the scratch companion name is reserved too, not just the variable", () => {
  const dir = repo(
    `[keys.providers.k]\ncommand = ["printf", "%s", "{ref}"]\nmode = "scratch"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["HOME=k://x"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /would arrive as HOME/);
  rmSync(dir, { recursive: true, force: true });
});

test("two keys arriving under one name are refused, not silently collapsed", () => {
  // It used to deliver the second and drop the first, in silence, in a
  // credential list. The run printed `T=b` and said nothing about `a`.
  const dir = repo(
    `[keys.providers.k]\ncommand = ["printf", "%s", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=k://a", "T=k://b"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /both arrive as T/);
  rmSync(dir, { recursive: true, force: true });
});

test("a path key is not subject to any of this — it delivers no variable", () => {
  const dir = repo(`[keys]\ndir = [".secrets"]\n\n[roles.dev]\nwrites = ["src/**"]\nkeys = ["netlify-token.txt"]\n`);
  assert.doesNotThrow(() => loadConfig(join(dir, "seisin.toml")));
  rmSync(dir, { recursive: true, force: true });
});

test("check lists the provider commands, because they are the part that executes", () => {
  const dir = repo(
    `[keys.providers.k]\ncommand = ["some-cli", "read", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=k://x"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const report = inspect(cfg, null, "seisin.toml");
  assert.deepEqual(report.providers, [{ name: "k", command: ["some-cli", "read", "{ref}"], mode: "env" }]);
  rmSync(dir, { recursive: true, force: true });
});

// ── the provider command is code, so it gets the policy file's treatment ────

test("a provider script inside the repo is denied to every role, like seisin.toml is", () => {
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.p]\ncommand = ["./bin/open.sh", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["bin/**"]\nkeys = ["T=p://x"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const denied = settingsFor(cfg, "dev").filesystem.denyWrite;
  assert.ok(denied.some((p) => p.endsWith("/bin/open.sh")), "the executed script is writable");
  rmSync(dir, { recursive: true, force: true });
});

test("a provider found on PATH is not denied — that is a machine, not a repo", () => {
  // Denying "wherever gpg happens to live" would be a rule about somebody's
  // installation. The repo has nothing to say about it.
  const dir = repo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.p]\ncommand = ["security", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://x"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.ok(!settingsFor(cfg, "dev").filesystem.denyWrite.some((p) => p.endsWith("security")));
  rmSync(dir, { recursive: true, force: true });
});

test('an escaped quote names its own cause, not "missing comma"', () => {
  // Every attempt at a one-line shell provider lands here, and the error used
  // to point at a spot in the middle of the pipeline.
  const dir = mkdtempSync(join(tmpdir(), "seisin-keys-"));
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.g]\ncommand = ["sh", "-c", "gpg --passphrase \\"$(x)\\" -d {ref}"]\n\n[roles.dev]\nkeys = []\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /there are no escapes in this format/);
  rmSync(dir, { recursive: true, force: true });
});

// ── file://, the one provider that ships ────────────────────────────────────

/** A repo whose secrets are plain files, which is how most repos look. */
function fileRepo(toml, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seisin-file-"));
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, ".secrets", name), body);
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

const POLICY = `[keys]\ndir = [".secrets"]\n\n[roles.dev]\nwrites = ["src/**"]\nkey_mode = "env"\n`;

test("file:// needs no provider declared — that is the whole point of it being built in", () => {
  const dir = fileRepo(POLICY + `keys = ["T=file://.secrets/t.txt"]\n`, { "t.txt": "abc-123-value\n" });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(resolveKeys(cfg, cfg.roles.dev)[0].value, "abc-123-value");
  rmSync(dir, { recursive: true, force: true });
});

test("a fragment takes ONE key out of a file that holds several, and only that one", () => {
  // The thing `keys = ["all.env"]` cannot do: that grants the file, so the
  // role gets every variable in it.
  const dir = fileRepo(POLICY + `keys = ["B=file://.secrets/all.env#B"]\n`,
    { "all.env": "# note\nA=first-value\nexport B=\"second-value\"\nC=third\n" });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const got = resolveKeys(cfg, cfg.roles.dev);
  assert.equal(got.length, 1);
  assert.equal(got[0].value, "second-value");            // export and quotes come off
  assert.equal(got[0].entry.name, "B");
  rmSync(dir, { recursive: true, force: true });
});

test("a fragment naming a key the file does not have is an error, not an empty value", () => {
  const dir = fileRepo(POLICY + `keys = ["Z=file://.secrets/all.env#Z"]\n`, { "all.env": "A=1\n" });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.throws(() => resolveKeys(cfg, cfg.roles.dev), /has NAME=value lines, but no Z=/);
  rmSync(dir, { recursive: true, force: true });
});

test("a fragment pointed at a document says so, instead of hunting for a typo", () => {
  // Found in the field: the only real credential declaration in the deployment
  // turned out to be a 146-line Markdown runbook with the passwords in a
  // table. "the file has no TOKEN=" sends somebody looking for a typo in a
  // file where the answer is that the secrets are in prose.
  //
  // The fix is the message, not a parser. A generic tool does not learn to
  // read one user's file, and that file is not a format.
  const dir = fileRepo(POLICY + `keys = ["T=file://.secrets/runbook.md#T"]\n`,
    { "runbook.md": "# QA users\n\n| Alias | Password |\n|---|---|\n| QA | hunter2 |\n" });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.throws(() => resolveKeys(cfg, cfg.roles.dev),
    /nothing in that file looks like NAME=value[\s\S]*move the secret out of the document/);
  rmSync(dir, { recursive: true, force: true });
});

test("the path is relative to the policy, not to where you were standing", () => {
  // A key that resolves differently depending on the current directory is a
  // key that works in your shell and fails in the agent's.
  const dir = fileRepo(POLICY + `keys = ["T=file://.secrets/t.txt"]\n`, { "t.txt": "from-the-policy\n" });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const before = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.equal(resolveKeys(cfg, cfg.roles.dev)[0].value, "from-the-policy");
  } finally {
    process.chdir(before);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("redefining file:// is refused — one scheme cannot mean two things", () => {
  const dir = fileRepo(
    `[keys]\ndir = [".secrets"]\n\n[keys.providers.file]\ncommand = ["cat", "{ref}"]\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = []\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /built in and cannot be redefined/);
  rmSync(dir, { recursive: true, force: true });
});

// ── the credential floor, or its absence ───────────────────────────────────

test("a repo with secrets and no [keys] dir is warned — the emitted policy denies no reads", () => {
  // The dangerous shape is a policy a script generated. Drop the one `[keys]
  // dir` line and every role reads the credential tree, with a clean `check`.
  // Verified before this existed: keyDirs [], denyRead [], and not one warning
  // about it among the four that did fire.
  const dir = mkdtempSync(join(tmpdir(), "seisin-floor-"));
  writeFileSync(join(dir, ".env"), "TOKEN=x\n");
  writeFileSync(join(dir, "seisin.toml"), `[roles.dev]\nwrites = ["src/**"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.deepEqual(settingsFor(cfg, "dev").filesystem.denyRead, [], "this is what it costs");
  assert.ok(inspect(cfg, null, "x").warnings.some((w) => w.kind === "no-key-floor"));
  rmSync(dir, { recursive: true, force: true });
});

test("a repo with no secrets in it is not nagged", () => {
  // The whole reason this is a shallow look and not `scan`: warning a project
  // that has no credentials is the noise that teaches people to skip warnings.
  const dir = mkdtempSync(join(tmpdir(), "seisin-floor-"));
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "seisin.toml"), `[roles.dev]\nwrites = ["src/**"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.ok(!inspect(cfg, null, "x").warnings.some((w) => w.kind === "no-key-floor"));
  rmSync(dir, { recursive: true, force: true });
});

test("and once a key directory is declared, the warning goes away", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-floor-"));
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  writeFileSync(join(dir, ".env"), "TOKEN=x\n");
  writeFileSync(join(dir, "seisin.toml"), `[keys]\ndir = [".secrets"]\n\n[roles.dev]\nwrites = ["src/**"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.ok(!inspect(cfg, null, "x").warnings.some((w) => w.kind === "no-key-floor"));
  rmSync(dir, { recursive: true, force: true });
});

// ── JSON, because it is a format ───────────────────────────────────────────

test("a fragment reads one value out of a JSON file", () => {
  // The shape a cloud CLI writes: a service-account key, a credentials.json.
  const dir = fileRepo(POLICY + `keys = ["K=file://.secrets/sa.json#private_key"]\n`,
    { "sa.json": JSON.stringify({ type: "service_account", private_key: "abc-123-key" }) });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(resolveKeys(cfg, cfg.roles.dev)[0].value, "abc-123-key");
  rmSync(dir, { recursive: true, force: true });
});

test("a dotted fragment reaches a nested one, and a literal dot wins over it", () => {
  const dir = fileRepo(POLICY + `keys = ["K=file://.secrets/c.json#a.b"]\n`,
    { "c.json": JSON.stringify({ "a.b": "literal", a: { b: "nested" } }) });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(resolveKeys(cfg, cfg.roles.dev)[0].value, "literal", "the real key beats the path");
  rmSync(dir, { recursive: true, force: true });
});

test("an object is not a credential and is refused, not stringified", () => {
  // Returning it would put `[object Object]` in a variable and call it a token.
  const dir = fileRepo(POLICY + `keys = ["K=file://.secrets/c.json#creds"]\n`,
    { "c.json": JSON.stringify({ creds: { token: "x" } }) });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.throws(() => resolveKeys(cfg, cfg.roles.dev), /is an object, not a value/);
  rmSync(dir, { recursive: true, force: true });
});

test("the format is sniffed from the content, because the name lied", () => {
  // The file that motivated all of this was JSON-shaped data in a `.txt`, and
  // the one before it was `.env`. The extension is a hint; the content is the
  // fact.
  const dir = fileRepo(POLICY + `keys = ["K=file://.secrets/creds.txt#tok"]\n`,
    { "creds.txt": '{"tok": "from-json-in-a-txt"}' });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.equal(resolveKeys(cfg, cfg.roles.dev)[0].value, "from-json-in-a-txt");
  rmSync(dir, { recursive: true, force: true });
});

test("a JSON array at the top level is not an object, so it reads as env and says so", () => {
  const dir = fileRepo(POLICY + `keys = ["K=file://.secrets/a.json#x"]\n`, { "a.json": '["a","b"]' });
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.throws(() => resolveKeys(cfg, cfg.roles.dev), /nothing in that file looks like NAME=value/);
  rmSync(dir, { recursive: true, force: true });
});

test("a credential in a file whose name gives nothing away is still caught", () => {
  // The name test misses `credentials.txt`, `tokens.conf`, `config.local`.
  // Found in the field by writing a test file this did not catch — the test
  // was fine, the detector was name-only.
  const dir = mkdtempSync(join(tmpdir(), "seisin-floor-"));
  writeFileSync(join(dir, "notas.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(dir, "seisin.toml"), `[roles.dev]\nwrites = ["src/**"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const w = inspect(cfg, null, "x").warnings.find((x) => x.kind === "no-key-floor");
  assert.ok(w && w.headline.includes("notas.txt"));
  rmSync(dir, { recursive: true, force: true });
});

test("and ordinary prose in the root is still not a credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-floor-"));
  writeFileSync(join(dir, "NOTES.md"), "# how we deploy\n\nRun the thing, then the other thing.\n");
  writeFileSync(join(dir, "seisin.toml"), `[roles.dev]\nwrites = ["src/**"]\n`);
  const cfg = loadConfig(join(dir, "seisin.toml"));
  assert.ok(!inspect(cfg, null, "x").warnings.some((x) => x.kind === "no-key-floor"));
  rmSync(dir, { recursive: true, force: true });
});
