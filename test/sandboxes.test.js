/**
 * Sandbox providers: which one a role runs under, and the rule that decides it.
 *
 * The rule (docs/decisions.md, docs/sandboxes.md): a role runs under a sandbox
 * only when that sandbox enforces every part of its settings. One that would
 * enforce less is passed over with the reason; a config that names one sandbox
 * gets that one or no run. And a declared sandbox is not taken on its word —
 * the canary runs under it, so one that ignores the policy starts nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { tartarosArgv, tartaros } from "../src/sandboxes/tartaros.js";
import { commandSandbox, assessCheck } from "../src/sandboxes/command.js";
import { weigh, chooseSandbox, sandboxesOf, DEFAULT_SANDBOX } from "../src/sandboxes/index.js";
import { runCanary } from "../src/canary.js";
import { seccompDir } from "../src/sandboxes/srt.js";
import { settingsFor } from "../src/srt.js";
import { resolveSrt } from "../src/commands/run.js";
import { scratch, repoWith, srtSkip, CLI } from "./_tmp.js";

const ROLE = '[roles.dev]\nwrites = ["src/**"]\n';
const cfg = (toml) => {
  const dir = scratch("seisin-sbx-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return loadConfig(join(dir, "seisin.toml"));
};
const fails = (toml, re) => assert.throws(() => cfg(toml), re);

/* ── [sandbox] in seisin.toml ──────────────────────────────────────────── */

test("no [sandbox] is srt, as before; a name or a list is read in order", () => {
  assert.equal(cfg(ROLE).sandbox, null);
  assert.deepEqual(sandboxesOf(cfg(ROLE)).map((s) => s.name), [DEFAULT_SANDBOX]);
  assert.deepEqual(cfg(`[sandbox]\nprovider = "tartaros"\n${ROLE}`).sandbox.provider, ["tartaros"]);
  assert.deepEqual(cfg(`[sandbox]\nprovider = ["tartaros", "srt"]\n${ROLE}`).sandbox.provider, ["tartaros", "srt"]);
});

test("an unknown sandbox is refused with the near name, never read as the default", () => {
  fails(`[sandbox]\nprovider = "tartars"\n${ROLE}`, /not a sandbox seisin knows — did you mean "tartaros"/);
  fails(`[sandbox]\nprovider = []\n${ROLE}`, /a name, or a list of names/);
  fails(`[sandbox]\nprovider = ["srt", "srt"]\n${ROLE}`, /lists a sandbox twice/);
  fails(`[sandbox]\nprovder = "srt"\n${ROLE}`, /"provder" is not a setting/);
});

test("a declared sandbox needs a command with {policy}, and cannot take a built-in name", () => {
  const ok = cfg(`[sandbox]\nprovider = "box"\n[sandbox.providers.box]\ncommand = ["box", "--policy", "{policy}", "--"]\n${ROLE}`);
  assert.deepEqual(ok.sandbox.providers.box.command, ["box", "--policy", "{policy}", "--"]);
  fails(`[sandbox]\nprovider = "box"\n[sandbox.providers.box]\ncommand = ["box", "--"]\n${ROLE}`, /no \{policy\} in its command/);
  fails(`[sandbox]\nprovider = "box"\n[sandbox.providers.box]\ncommand = []\n${ROLE}`, /needs a command/);
  fails(`[sandbox.providers.srt]\ncommand = ["x", "{policy}"]\n${ROLE}`, /"srt" is built in and cannot be redefined/);
  fails(`[sandbox.providers.box]\ncmd = ["x", "{policy}"]\n${ROLE}`, /"cmd" is not a setting/);
});

test("a declared sandbox may bring a check, which also has to see {policy}", () => {
  const box = (check) => `[sandbox]\nprovider = "box"\n[sandbox.providers.box]\ncommand = ["box", "{policy}"]\n${check}\n${ROLE}`;
  assert.equal(cfg(box("")).sandbox.providers.box.check, null);
  assert.deepEqual(cfg(box('check = ["box", "check", "{policy}"]')).sandbox.providers.box.check, ["box", "check", "{policy}"]);
  fails(box('check = ["box", "check"]'), /no \{policy\} in its check/);
  fails(box('check = "box check {policy}"'), /check must be a command, as an array of strings/);
});

test("a declared sandbox gets the policy where {policy} is, and the command after", () => {
  const box = commandSandbox("box", ["box", "run", "--policy={policy}", "--"]);
  assert.deepEqual(box.wrap("/bin/box", "/run/settings.json", {}, ["sh", "-c", "x"]),
    ["/bin/box", "run", "--policy=/run/settings.json", "--", "sh", "-c", "x"]);
  assert.deepEqual(box.unmet({}), []);
});

test("whether a declared sandbox tags its denials is declared, and false unless it says so", () => {
  const box = (extra) => `[sandbox]\nprovider = "box"\n[sandbox.providers.box]\ncommand = ["box", "{policy}"]\n${extra}\n${ROLE}`;
  assert.equal(cfg(box("")).sandbox.providers.box.tagsDenials, false);
  assert.equal(cfg(box("tags_denials = true")).sandbox.providers.box.tagsDenials, true);
  assert.equal(sandboxesOf(cfg(box("tags_denials = true")))[0].tagsDenials, true);
  fails(box('tags_denials = "yes"'), /tags_denials is true or false/);
  // tartaros tags them (measured with ad85515), so its refusals are recorded like srt's.
  assert.equal(tartaros.tagsDenials, true);
});

/* ── tartaros, and any sandbox that answers for itself ────────────────── */

const settings = ({ fs = {}, net = {} } = {}) => ({
  network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [], allowLocalBinding: false, ...net },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [], ...fs },
});

/**
 * A stand-in `tartaros` on PATH, with tartaros's own shape of answer: `explain
 * --settings <file>` exits 78 with a reason when the file asks for a domain, and
 * `run … --settings <file> -- cmd` hands the file to srt, so a run under it is
 * really held. It notes every file it was asked about.
 */
function fakeTartaros() {
  const dir = scratch("seisin-fake-tt-");
  const asked = join(dir, "asked");
  writeFileSync(join(dir, "tartaros"), `#!/bin/sh
verb="$1"; shift
while [ "$1" != "--settings" ]; do shift; done
file="$2"; shift 2
echo "$file" >> "${asked}"
if [ "$verb" = explain ]; then
  if grep -q github.com "$file"; then
    echo "tartaros: --settings: cannot guarantee per-domain egress on this backend; refusing to run (apply-fully-or-refuse)." >&2
    exit 78
  fi
  echo "fine"; exit 0
fi
[ "$1" = "--" ] && shift
exec "${resolveSrt() ?? "srt"}" --settings "$file" -- "$@"
`);
  chmodSync(join(dir, "tartaros"), 0o755);
  return { dir, asked: () => (existsSync(asked) ? readFileSync(asked, "utf8").trim().split("\n") : []) };
}
const onPath = (dir, fn) => {
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  try { return fn(); } finally { process.env.PATH = was; }
};

test("tartaros is handed the settings file as it is, the role as a label", () => {
  assert.deepEqual(tartarosArgv("/bin/tartaros", "/run/settings.json", ["sh", "-c", "x"], { role: "dev" }),
    ["/bin/tartaros", "run", "--role", "dev", "--inherit-env", "--settings", "/run/settings.json", "--", "sh", "-c", "x"]);
  assert.deepEqual(tartarosArgv("t", "/f", ["sh"]), ["t", "run", "--inherit-env", "--settings", "/f", "--", "sh"]);
});

test("tartaros is asked, not second-guessed: what it refuses is passed over with its own reason", () => {
  const tt = fakeTartaros();
  const box = cfg(`[sandbox]\nprovider = ["tartaros", "srt"]\n${ROLE}`);
  onPath(tt.dir, () => {
    const { chosen, options } = weigh(box, settings({ net: { allowedDomains: ["github.com"] } }), { platform: "linux" });
    assert.notEqual(chosen?.sandbox.name, "tartaros");
    assert.match(options[0].unmet[0], /^tartaros says it cannot hold this policy: --settings: cannot guarantee per-domain egress/);
    assert.equal(weigh(box, settings(), { platform: "linux" }).chosen.sandbox.name, "tartaros");
  });
  // Asked about a copy of the settings, which is gone once the answer is in.
  const asked = tt.asked();
  assert.equal(asked.length, 2);
  for (const f of asked) assert.ok(!existsSync(f), `the settings copy ${f} was left behind`);
});

test("a run's own settings file is the one asked about, when there is one", () => {
  const tt = fakeTartaros();
  const box = cfg(`[sandbox]\nprovider = "tartaros"\n${ROLE}`);
  const file = join(scratch("seisin-sbx-file-"), "settings.json");
  writeFileSync(file, JSON.stringify(settings()));
  onPath(tt.dir, () => assert.equal(chooseSandbox(box, settings(), { platform: "linux", file }).sandbox.name, "tartaros"));
  assert.deepEqual(tt.asked(), [file]);
});

test("tartaros not installed is passed over as missing, without asking anything", () => {
  const box = cfg(`[sandbox]\nprovider = ["tartaros", "srt"]\n${ROLE}`);
  const was = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const { options } = weigh(box, settings(), { platform: "linux" });
    assert.match(options[0].missing, /tartaros not found on PATH/);
    assert.deepEqual(options[0].unmet, []);
  } finally { process.env.PATH = was; }
});

test("a declared sandbox's check decides like tartaros's, and silence or a hang is a no", () => {
  const dir = scratch("seisin-sbx-check-");
  const script = (name, body) => { const f = join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
  const no = script("no", 'echo "no: no domains here" >&2; exit 1');
  const mute = script("mute", "exit 3");
  const warns = script("warns", 'echo "warns: applying the built-in set for one pattern" >&2; echo "warns: cannot hold another, refusing" >&2; exit 2');
  const yes = script("yes", 'test -s "$1"');
  const unmet = (check) => commandSandbox("box", ["box", "{policy}"], [check, "{policy}"]).unmet({}, { file: join(dir, "no-such-file") });
  assert.deepEqual(unmet(no), ["its check (" + no + ") says it cannot hold this policy: no domains here"]);
  assert.match(unmet(mute)[0], /exited 3 without saying why/);
  assert.match(unmet(warns)[0], /says it cannot hold this policy: cannot hold another, refusing$/, "a warning was shown instead of the refusal");
  assert.match(unmet(yes)[0], /exited 1/, "a check on a file that is not there passed");
  assert.match(unmet(join(dir, "absent"))[0], /ENOENT/);
  assert.deepEqual(commandSandbox("box", ["box", "{policy}"]).unmet({}, {}), [], "no check, nothing to say");
  const f = join(dir, "s.json"); writeFileSync(f, "{}");
  assert.deepEqual(commandSandbox("box", ["box", "{policy}"], [yes, "{policy}"]).unmet({}, { file: f }), []);
});

test("a yes can carry warnings, and so can a no; only lines that say warning: count", () => {
  const dir = scratch("seisin-sbx-warn-");
  const f = join(dir, "warn"); writeFileSync(f, '#!/bin/sh\necho "warn: warning: new entries cannot be created directly in /r"\necho "warn: covered by the built-in set" >&2\nexit ${CODE:-0}\n'); chmodSync(f, 0o755);
  const yes = assessCheck([f, "{policy}"], "/p", "warn");
  assert.deepEqual(yes, { unmet: [], warnings: ["new entries cannot be created directly in /r"] });
  const box = cfg(`[sandbox]\nprovider = "box"\n[sandbox.providers.box]\ncommand = ["${f}", "{policy}"]\ncheck = ["${f}", "{policy}"]\n${ROLE}`);
  const { chosen } = weigh(box, settings(), { platform: "linux" });
  assert.deepEqual(chosen.warnings, ["new entries cannot be created directly in /r"]);
});

/* ── the choice ────────────────────────────────────────────────────────── */

test("one name means that one: a role it cannot hold is refused, not moved", () => {
  const tt = fakeTartaros();
  const only = cfg(`[sandbox]\nprovider = "tartaros"\n${ROLE}`);
  const r = onPath(tt.dir, () => chooseSandbox(only, settings({ net: { allowedDomains: ["github.com"] } }), { platform: "linux", role: "dev" }));
  assert.ok(r.error, "a role tartaros cannot hold ran anyway");
  assert.match(r.error.message, /no sandbox in \[sandbox\] provider can hold role dev/);
  assert.match(r.error.message, /per-domain egress/);
  assert.match(r.error.message, /never used in its place/);
});

test("a sandbox that is not installed is passed over, and says so", () => {
  const box = cfg(`[sandbox]\nprovider = ["gone", "srt"]\n[sandbox.providers.gone]\ncommand = ["/nonexistent/box", "{policy}"]\n${ROLE}`);
  const { chosen, options } = weigh(box, settings(), { platform: "linux" });
  assert.match(options[0].missing, /\/nonexistent\/box .*was not found/);
  assert.equal(chosen?.sandbox.name ?? "srt-missing", resolveSrt() ? "srt" : "srt-missing");
});

/* ── end to end: the contract, held to it by the canary ────────────────── */

const run = (cwd, ...args) => {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.SEISIN_ROLE; delete env.SEISIN_CONFIG;
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
};

test("srt declared as a command is a sandbox like any other: the territory holds under it", { skip: srtSkip() }, () => {
  const dir = repoWith("sbx-cmd-",
    `[sandbox]\nprovider = "viacommand"\n[sandbox.providers.viacommand]\ncommand = ["${resolveSrt()}", "--settings", "{policy}", "--"]\n` +
    '[roles.dev]\nwrites = ["src/**"]\n', ["src/", "web/"]);
  const r = run(dir, "run", "dev", "--agent", "none", "--", "sh", "-c", "echo ok > src/a; echo no > web/b 2>/dev/null; true");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /dev runs under viacommand/);
  // srt tags its denials, but declared without saying so, seisin cannot know it: said, not assumed.
  if (process.platform === "darwin") assert.match(r.stderr, /viacommand does not tag its denials/);
  assert.ok(existsSync(join(dir, "src/a")), "a write inside the territory did not go through");
  assert.ok(!existsSync(join(dir, "web/b")), "a write outside the territory went through under a declared sandbox");
});

test("a declared sandbox that tags its denials has them recorded, and is not warned about", { skip: srtSkip() || (process.platform !== "darwin" && "macOS only: no denial stream elsewhere") }, () => {
  const dir = repoWith("sbx-tagged-",
    `[sandbox]\nprovider = "viacommand"\n[sandbox.providers.viacommand]\ncommand = ["${resolveSrt()}", "--settings", "{policy}", "--"]\n` +
    'tags_denials = true\n[roles.dev]\nwrites = ["src/**"]\n', ["src/", "web/"]);
  const r = run(dir, "run", "dev", "--agent", "none", "--", "sh", "-c", "echo no > web/b; sleep 1; true");
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /does not tag its denials/);
  const log = readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8");
  assert.match(log, /"source":"kernel","action":"write","kind":"file","target":"web\/b","verdict":"denied"/);
});

test("a declared sandbox that ignores the policy starts nothing: the canary stops it", { skip: srtSkip() }, () => {
  const dir = repoWith("sbx-naive-", "", ["src/", "web/"]);
  const naive = join(dir, "naive.sh");
  writeFileSync(naive, '#!/bin/sh\nshift 2\nexec "$@"\n');
  chmodSync(naive, 0o755);
  writeFileSync(join(dir, "seisin.toml"),
    `[sandbox]\nprovider = "naive"\n[sandbox.providers.naive]\ncommand = ["${naive}", "--policy", "{policy}"]\n` +
    '[roles.dev]\nwrites = ["src/**"]\n');
  const r = run(dir, "run", "dev", "--agent", "none", "--", "sh", "-c", "echo PWNED > web/z");
  assert.equal(r.status, 86, r.stderr);
  assert.match(r.stderr, /failed its canary/);
  assert.ok(!existsSync(join(dir, "web/z")), "the agent ran under a sandbox that failed its canary");
});

test("a role runs under tartaros through its own --settings, and the territory holds", { skip: srtSkip() }, () => {
  const tt = fakeTartaros();
  const dir = repoWith("sbx-tt-", `[sandbox]\nprovider = "tartaros"\n[roles.dev]\nwrites = ["src/**"]\n`, ["src/", "web/"]);
  const r = onPath(tt.dir, () => run(dir, "run", "dev", "--agent", "none", "--", "sh", "-c", "echo ok > src/a; echo no > web/b 2>/dev/null; true"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /dev runs under tartaros/);
  assert.ok(existsSync(join(dir, "src/a")), "a write inside the territory did not go through");
  assert.ok(!existsSync(join(dir, "web/b")), "a write outside the territory went through under tartaros");
});

test("a declared sandbox whose check says no falls back to the next, instead of stopping at the canary", { skip: srtSkip() }, () => {
  const dir = repoWith("sbx-fallback-", "", ["src/", "web/"]);
  const no = join(dir, "no.sh");
  writeFileSync(no, '#!/bin/sh\necho "cannot do this one" >&2\nexit 1\n');
  chmodSync(no, 0o755);
  writeFileSync(join(dir, "seisin.toml"),
    `[sandbox]\nprovider = ["mybox", "srt"]\n[sandbox.providers.mybox]\ncommand = ["/bin/sh", "-c", "exit 99", "{policy}"]\n` +
    `check = ["${no}", "{policy}"]\n[roles.dev]\nwrites = ["src/**"]\n`);
  const r = run(dir, "run", "dev", "--agent", "none", "--", "sh", "-c", "echo ok > src/a");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dir, "src/a")));
  const c = run(dir, "check");
  assert.match(c.stdout, /dev: srt/);
  assert.match(c.stdout, /mybox: its check .* says it cannot hold this policy: cannot do this one/);
});

test("runCanary takes the sandbox's own command line", { skip: srtSkip() }, async () => {
  const d = scratch("seisin-sbx-canary-");
  mkdirSync(join(d, "runs", "r"), { recursive: true });
  // No sandbox at all: everything the canary checks for goes through.
  const r = await runCanary({
    wrap: (inner) => inner, settingsFile: join(d, "settings.json"), settings: settings(),
    env: { PATH: process.env.PATH }, cwd: d, runDir: join(d, "runs", "r"), runsRoot: join(d, "runs"),
    role: { localBinding: true }, granted: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => /write outside the territory went through/.test(f)), r.failed.join("\n"));
  assert.ok(r.failed.some((f) => /planted secret was readable/.test(f)), r.failed.join("\n"));
});

test("seccompDir: from the srt that runs, through its links, to the runtime's vendor/seccomp", () => {
  const dir = scratch("seccomp-");
  const pkg = join(dir, "lib", "node_modules", "@anthropic-ai", "sandbox-runtime");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(join(pkg, "vendor", "seccomp", "x64"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/sandbox-runtime" }));
  writeFileSync(join(pkg, "dist", "cli.js"), "");
  mkdirSync(join(dir, "bin"));
  symlinkSync(join(pkg, "dist", "cli.js"), join(dir, "bin", "srt"));
  assert.equal(seccompDir(join(dir, "bin", "srt")), realpathSync(join(pkg, "vendor", "seccomp")));
  // A package with no vendor directory, or an srt that is not the runtime's: nothing to keep.
  rmSync(join(pkg, "vendor"), { recursive: true });
  assert.equal(seccompDir(join(dir, "bin", "srt")), null);
  assert.equal(seccompDir(null), null);
});

test("on Linux, read = \"territory\" keeps the runtime's apply-seccomp readable", { skip: process.platform !== "linux" || srtSkip() }, () => {
  const root = repoWith("seccomp-territory-", `[runtime]\nread = "territory"\nwrites = []\n\n[roles.dev]\nwrites = ["src/**"]\n`);
  const fs = settingsFor(loadConfig(join(root, "seisin.toml")), "dev").filesystem;
  const seccomp = seccompDir();
  assert.ok(seccomp, "the runtime that runs has a vendor/seccomp");
  const shut = fs.denyRead.some((d) => seccomp.startsWith(d + "/")) && !fs.allowRead.some((a) => seccomp === a || seccomp.startsWith(a + "/"));
  assert.ok(!shut, `${seccomp} is shut by ${JSON.stringify(fs.denyRead)}`);
});
