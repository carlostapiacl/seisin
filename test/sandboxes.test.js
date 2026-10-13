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
import { writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { tartarosUnmet, tartarosArgv, portsOf } from "../src/sandboxes/tartaros.js";
import { commandSandbox } from "../src/sandboxes/command.js";
import { weigh, chooseSandbox, sandboxesOf, DEFAULT_SANDBOX } from "../src/sandboxes/index.js";
import { runCanary } from "../src/canary.js";
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

test("a declared sandbox gets the policy where {policy} is, and the command after", () => {
  const box = commandSandbox("box", ["box", "run", "--policy={policy}", "--"]);
  assert.deepEqual(box.wrap("/bin/box", "/run/settings.json", {}, ["sh", "-c", "x"]),
    ["/bin/box", "run", "--policy=/run/settings.json", "--", "sh", "-c", "x"]);
  assert.deepEqual(box.unmet({}), []);
});

/* ── tartaros: what it can say, and what it cannot ─────────────────────── */

const settings = ({ fs = {}, net = {} } = {}) => ({
  network: { allowedDomains: [], deniedDomains: [], allowUnixSockets: [], allowLocalBinding: false, ...net },
  filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [], ...fs },
});
const dirs = () => {
  const d = scratch("seisin-tt-");
  for (const s of ["repo/src", "repo/.git", "keys", "out"]) mkdirSync(join(d, s), { recursive: true });
  return d;
};

test("tartaros holds a role of plain paths, loopback ports and nothing re-opened", () => {
  const d = dirs();
  const s = settings({
    fs: { allowWrite: [join(d, "repo/src")], denyRead: [join(d, "keys")], denyWrite: [join(d, "repo/.git"), join(d, "out")] },
    net: { allowedDomains: ["localhost:8001", "127.0.0.1:8001", "[::1]:8001"] },
  });
  assert.deepEqual(tartarosUnmet(s, { platform: "linux" }), []);
  assert.deepEqual(tartarosArgv("/bin/tartaros", s, ["sh"], { role: "dev", platform: "linux" }), [
    "/bin/tartaros", "run", "--role", "dev", "--write", join(d, "repo/src"), "--read-deny", join(d, "keys"),
    "--port", "8001", "--deny-unix", "--", "sh"]);
  // macOS: no --deny-unix there; the audit channel question is unmet's, not argv's.
  assert.ok(!tartarosArgv("/bin/tartaros", s, ["sh"], { platform: "darwin" }).includes("--deny-unix"));
});

test("a writable root that does not exist is dropped, never passed on", () => {
  const d = dirs();
  const s = settings({ fs: { allowWrite: [join(d, "repo/src"), join(d, "nope")] } });
  assert.deepEqual(tartarosUnmet(s, { platform: "linux" }), []);
  assert.ok(!tartarosArgv("t", s, ["sh"]).includes(join(d, "nope")));
});

test("tartaros is passed over for each thing it cannot enforce, with the thing named", () => {
  const d = dirs();
  const one = (part, platform = "linux") => {
    const u = tartarosUnmet(settings(part), { platform });
    assert.equal(u.length, 1, `expected one unmet part, got ${JSON.stringify(u)}`);
    return u[0];
  };
  assert.match(one({ fs: { denyWrite: [join(d, "repo/**/.git/hooks/**")] } }), /path pattern .*not globs/);
  assert.match(one({ fs: { allowWrite: [join(d, "repo")], denyWrite: [join(d, "repo/.git")] } }),
    /write denied inside a writable path .*repo\/\.git in .*repo\)/);
  assert.match(one({ fs: { denyRead: [join(d, "keys")], allowRead: [join(d, "keys/a.txt")] } }),
    /read re-opened inside a denied path .*keys\/a\.txt in .*keys\)/);
  assert.match(one({ net: { allowedDomains: ["github.com"] } }), /network by domain \(github\.com\)/);
  assert.match(one({ net: { allowLocalBinding: true } }), /listening on localhost/);
  assert.match(one({ net: { allowUnixSockets: ["/r/s.sock"] } }, "darwin"), /one unix socket/);
  assert.deepEqual(tartarosUnmet(settings({ net: { allowUnixSockets: ["/r/s.sock"] } }), { platform: "linux" }), []);
  assert.match(tartarosUnmet(settings(), { platform: "win32" })[0], /macOS and Linux, not win32/);
});

test("a denied write under /dev is unmet: tartaros grants /dev to every run", () => {
  assert.match(tartarosUnmet(settings({ fs: { denyWrite: ["/dev/fd/9"] } }), { platform: "linux" })[0], /inside a writable path/);
});

test("loopback spellings are ports; anything else is a domain", () => {
  assert.deepEqual(portsOf(["localhost:80", "127.0.0.1:80", "[::1]:443", "api.x.com", "localhost"]),
    { ports: [80, 443], others: ["api.x.com", "localhost"] });
});

/* ── the choice ────────────────────────────────────────────────────────── */

test("each role gets the first sandbox that holds all of it; the others say why not", () => {
  const box = cfg(`[sandbox]\nprovider = ["tartaros", "srt"]\n${ROLE}`);
  const d = dirs();
  const reopened = settings({ fs: { denyRead: [join(d, "keys")], allowRead: [join(d, "keys/a")] } });
  const { chosen, options } = weigh(box, reopened, { platform: "linux", locate: false });
  assert.equal(chosen.sandbox.name, "srt");
  assert.match(options[0].unmet[0], /re-opened/);
  const plain = settings({ fs: { allowWrite: [join(d, "repo/src")] } });
  assert.equal(weigh(box, plain, { platform: "linux", locate: false }).chosen.sandbox.name, "tartaros");
});

test("one name means that one: a role it cannot hold is refused, not moved", () => {
  const only = cfg(`[sandbox]\nprovider = "tartaros"\n${ROLE}`);
  const r = chooseSandbox(only, settings({ net: { allowedDomains: ["github.com"] } }), { platform: "linux", role: "dev" });
  // Found or not on this machine, it is refused: missing, or unable.
  assert.ok(r.error, "a role tartaros cannot hold ran anyway");
  assert.match(r.error.message, /no sandbox in \[sandbox\] provider can hold role dev/);
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
  assert.ok(existsSync(join(dir, "src/a")), "a write inside the territory did not go through");
  assert.ok(!existsSync(join(dir, "web/b")), "a write outside the territory went through under a declared sandbox");
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
