/**
 * `browsers = ["chromium"]`: a headless Chromium inside the sandbox, with the
 * two Mach rules it needs and nothing wider (src/browsers.js).
 *
 * The end-to-end half needs Playwright and its Chromium headless shell. They
 * are not a dependency of seisin, so the tests look for them where
 * SEISIN_TEST_PLAYWRIGHT points — a directory whose node_modules has
 * `playwright` — and skip without it:
 *
 *   SEISIN_TEST_PLAYWRIGHT=~/some/project node --test test/browsers.test.js
 *
 * and SEISIN_TEST_CHROMIUM, when that Playwright's own build of the headless
 * shell is not the one installed, to the executable to launch instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { machOf, browserFor, BROWSERS } from "../src/browsers.js";
import { withRules } from "../src/sandboxes/mach-profile.js";
import { srt, withMachPreload, resolveSrt } from "../src/sandboxes/srt.js";
import { weigh, settingsOf } from "../src/sandboxes/index.js";
import { tartaros, tartarosSettings } from "../src/sandboxes/tartaros.js";
import { parseChunk } from "../src/violations.js";
import { intake } from "../src/intake.js";
import { pending, requestsPath } from "../src/requests.js";
import { scratch, repoWith, srtSkip, CLI } from "./_tmp.js";

const PREFIX = "org.chromium.Chromium.MachPortRendezvousServer.";
const cfg = (role) => {
  const dir = scratch("seisin-browsers-");
  writeFileSync(join(dir, "seisin.toml"), `[roles.agent]\nwrites = ["src/**"]\n${role}\n`);
  return loadConfig(join(dir, "seisin.toml"));
};

/* ── the declaration ───────────────────────────────────────────────────── */

test("browsers is a list of presets; a name without one is refused with the near name", () => {
  assert.deepEqual(cfg("").roles.agent.browsers, []);
  assert.deepEqual(cfg('browsers = ["chromium", "chromium"]').roles.agent.browsers, ["chromium"]);
  assert.throws(() => cfg('browsers = ["chromum"]'), /not a browser seisin has a preset for — did you mean "chromium"/);
  assert.throws(() => cfg('browsers = "chromium"'), /is a list of browser names/);
});

test("the preset is the rendezvous prefix, registered and looked up, and nothing else", () => {
  assert.deepEqual(machOf({ browsers: ["chromium"] }), { register: [PREFIX], lookup: [PREFIX] });
  assert.deepEqual(machOf({ browsers: [] }), { register: [], lookup: [] });
  assert.equal(browserFor(`${PREFIX}7354`), "chromium");
  assert.equal(browserFor("com.apple.windowserver.active"), null);
  for (const b of Object.values(BROWSERS)) for (const p of [...b.register, ...b.lookup]) assert.ok(p.endsWith("."), p);
});

test("the lookup goes to the runtime as allowMachLookup, only for a role that asked", () => {
  const on = settingsFor(cfg('browsers = ["chromium"]'), "agent");
  assert.deepEqual(on.network.allowMachLookup, [`${PREFIX}*`]);
  const off = settingsFor(cfg(""), "agent");
  assert.equal(off.network.allowMachLookup, undefined);
});

/* ── the register rule, spliced into srt's profile ─────────────────────── */

const LINE = (profile) =>
  `env HTTP_PROXY=http://x /usr/bin/sandbox-exec -p '${profile}' /bin/zsh -c 'node probe.cjs'`;
const PROFILE = `(version 1)\n(deny default (with message "t"))\n; doesn'"'"'t allow network access\n(allow file-read*)`;

test("the register rule goes at the end of the profile, past a quote srt escaped inside it", () => {
  const out = withRules(LINE(PROFILE), [PREFIX]);
  const rule = `(allow mach-register (global-name-prefix "${PREFIX}"))`;
  assert.ok(out.includes(`(allow file-read*)\n; seisin: browsers (src/browsers.js)\n${rule}\n' /bin/zsh -c`), out);
  // Everything else is as it was: the profile before, the command after.
  assert.ok(out.startsWith(`env HTTP_PROXY=http://x /usr/bin/sandbox-exec -p '${PROFILE}`));
  assert.ok(out.endsWith(" /bin/zsh -c 'node probe.cjs'"));
});

test("a profile not shaped as expected, or a name that is not a prefix, fails closed", () => {
  assert.throws(() => withRules("bwrap --ro-bind / / sh", [PREFIX]), /no longer runs sandbox-exec/);
  assert.throws(() => withRules(LINE(PROFILE) + " " + LINE(PROFILE), [PREFIX]), /more than one profile/);
  assert.throws(() => withRules(LINE("(deny default)"), [PREFIX]), /does not start with \(version 1\)/);
  assert.throws(() => withRules(LINE(PROFILE), ['x") (allow default) ("']), /not a Mach name prefix/);
  assert.throws(() => withRules(LINE(PROFILE), ["org.chromium"]), /not a Mach name prefix/);
});

test("srt is run with the preload only for a role that registers something", { skip: srtSkip() }, () => {
  const bin = resolveSrt();
  assert.deepEqual(srt.wrap(bin, "/r/settings.json", {}, ["sh"]), [bin, "--settings", "/r/settings.json", "--", "sh"]);
  const argv = srt.wrap(bin, "/r/settings.json", {}, ["sh"], { machRegister: [PREFIX] });
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], "--import");
  assert.match(argv[2], /srt-mach\.mjs$/);
  assert.deepEqual(argv.slice(-4), ["--settings", "/r/settings.json", "--", "sh"]);
  assert.deepEqual(withMachPreload(bin, "/f", ["x"]).slice(-3), ["/f", "--", "x"]);
});

test("a sandbox other than srt is passed over for a role with browsers, and says why", () => {
  const dir = scratch("seisin-browsers-sbx-");
  writeFileSync(join(dir, "seisin.toml"),
    '[sandbox]\nprovider = ["mybox", "srt"]\n[sandbox.providers.mybox]\ncommand = ["/bin/sh", "{policy}"]\n' +
    '[roles.agent]\nwrites = ["src/**"]\nbrowsers = ["chromium"]\n[roles.plain]\nwrites = ["web/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const { options } = weigh(config, settingsFor(config, "agent"), { role: "agent", locate: false });
  assert.match(options[0].unmet.join("\n"), /a Mach service to register \(org\.chromium.*for browsers\): mybox is not given it, only srt and tartaros are/);
  assert.deepEqual(options[1].unmet, []);
  // A role without browsers is not affected.
  assert.deepEqual(weigh(config, settingsFor(config, "plain"), { role: "plain", locate: false }).options[0].unmet, []);
});

test("tartaros is handed the register names in its own field, and only when there are any", () => {
  const config = cfg('browsers = ["chromium"]');
  const base = settingsFor(config, "agent");
  const own = tartarosSettings(base, { machRegister: [PREFIX] });
  assert.deepEqual(own.network.allowMachRegister, [`${PREFIX}*`]);
  assert.equal(base.network.allowMachRegister, undefined, "the generated settings were changed in place");
  assert.equal(tartarosSettings(base, { machRegister: [] }), base, "a role without browsers got a different file");
  assert.equal(tartaros.machRegister, true);
  // srt's schema is strict: it is never handed the field.
  assert.equal(settingsOf(srt, base, { machRegister: [PREFIX] }), base);
});

test("a browser role runs under tartaros with a private TMPDIR, the only place its sockets may be", () => {
  assert.deepEqual(tartaros.wrap("/bin/tartaros", "/r/s.json", {}, ["sh"], { role: "agent", machRegister: [PREFIX] }),
    ["/bin/tartaros", "run", "--role", "agent", "--private-tmp", "--settings", "/r/s.json", "--", "sh"]);
  assert.ok(!tartaros.wrap("/bin/tartaros", "/r/s.json", {}, ["sh"], { role: "agent" }).includes("--private-tmp"));
});

test("tartaros is asked about the file it would be handed, with the field in it", () => {
  const dir = scratch("seisin-browsers-tt-");
  const bin = join(dir, "tartaros");
  const seen = join(dir, "seen.json");
  writeFileSync(bin, `#!/bin/sh\nwhile [ "$1" != "--settings" ]; do shift; done\ncp "$2" ${JSON.stringify(seen)}\nexit 0\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, "seisin.toml"), '[sandbox]\nprovider = "tartaros"\n[roles.agent]\nwrites = ["src/**"]\nbrowsers = ["chromium"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  try {
    const { chosen } = weigh(config, settingsFor(config, "agent"), { role: "agent", platform: "darwin" });
    assert.equal(chosen?.sandbox.name, "tartaros");
  } finally { process.env.PATH = was; }
  assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")).network.allowMachRegister, [`${PREFIX}*`]);
});

/* ── the record ────────────────────────────────────────────────────────── */

const REGISTER =
  "2026-10-13 23:16:22.853 E  kernel[0:1da7096] (Sandbox) Sandbox: chrome-headless-shell(7354) deny(1) " +
  `mach-register ${PREFIX}7354\n` +
  "CMD64_c2g=_END__qlvxb5sax_SBX";

test("a refused mach-register parses into its operation and its name", () => {
  const d = parseChunk(REGISTER);
  assert.equal(d.action, "system");
  assert.equal(d.operation, "mach-register");
  assert.equal(d.path, `${PREFIX}7354`);
  assert.equal(d.suffix, "_qlvxb5sax_SBX");
});

test("a system denial is logged once per operation and name, pid folded, and never queued", () => {
  const dir = scratch("seisin-browsers-intake-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.agent]\nwrites = ["src/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const take = intake({ config, role: "agent", runId: "abcd1234-0000", settings: settingsFor(config, "agent") });
  const sys = (operation, path) => take.fromKernel({ action: "system", operation, path, pid: 1, proc: "chrome" });
  sys("mach-register", `${PREFIX}7354`);
  sys("mach-lookup", `${PREFIX}7354`);
  for (let i = 0; i < 50; i++) sys("mach-lookup", `${PREFIX}${8000 + i}`);
  sys("mach-lookup", "com.apple.windowserver.active");
  const lines = readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => `${l.action} ${l.target}`), [
    `mach-register ${PREFIX}7354`, `mach-lookup ${PREFIX}7354`, "mach-lookup com.apple.windowserver.active"]);
  for (const l of lines) {
    assert.equal(l.kind, "system");
    assert.equal(l.source, "kernel");
    assert.equal(l.verdict, "denied");
  }
  assert.equal(pending(requestsPath(dir)).length, 0, "a Mach service was queued as a request");
  assert.deepEqual(take.stats.browsers, ["chromium"]);
});

/* ── end to end: a real Chromium in a real sandbox ─────────────────────── */

function playwright() {
  const from = process.env.SEISIN_TEST_PLAYWRIGHT;
  if (!from) return null;
  try { return createRequire(join(from, "noop.js")).resolve("playwright"); } catch { return null; }
}
const PW = playwright();
const browserSkip = process.platform !== "darwin" ? "macOS only: the Mach rules are Seatbelt's"
  : srtSkip() || (PW ? false : "no Playwright: set SEISIN_TEST_PLAYWRIGHT to a directory that has it installed");

const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library", "Caches", "ms-playwright");

/**
 * The probe from the report that led to this, with the proxy credentials
 * taken out of the URL: Playwright hands Chromium `--proxy-server` without
 * them, and seisin's proxy answers that with 407 (measured with curl).
 */
const PROBE = (pw) => `
const { chromium } = require(${JSON.stringify(pw)});
(async () => {
  const u = new URL(process.env.HTTP_PROXY);
  const proxy = { server: u.protocol + "//" + u.host, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  const b = await chromium.launch({ proxy, executablePath: process.env.SEISIN_TEST_CHROMIUM || undefined });
  const pg = await b.newPage();
  const r = await pg.goto(process.env.URL, { timeout: 20000 });
  console.log("GOTO", r && r.status(), await pg.title());
  await b.close();
})().catch((e) => { console.log("FAIL", e.message.split("\\n")[0]); process.exit(2); });
`;

function browserRepo(role) {
  const dir = repoWith("browsers-", "", ["src/"]);
  const home = join(dir, "home");
  mkdirSync(home);
  writeFileSync(join(dir, "probe.cjs"), PROBE(PW));
  writeFileSync(join(dir, "seisin.toml"),
    `[runtime]\nwrites = [${JSON.stringify(home)}]\n[network]\nallow = ["example.com"]\n` +
    `[roles.agent]\nwrites = ["src/**"]\nenv = ["HOME", "PATH", "TMPDIR", "URL", "PLAYWRIGHT_BROWSERS_PATH", "SEISIN_TEST_CHROMIUM"]\n${role}\n`);
  const run = (url) => {
    const env = { ...process.env, HOME: home, URL: url, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_PATH, NO_COLOR: "1" };
    delete env.SEISIN_ROLE; delete env.SEISIN_CONFIG;
    return spawnSync(process.execPath, [CLI, "run", "agent", "--agent", "none", "--", process.execPath, "probe.cjs"],
      { cwd: dir, env, encoding: "utf8", timeout: 120_000 });
  };
  const log = () => readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8");
  return { dir, run, log };
}

test("with browsers = [\"chromium\"], Chromium starts and navigates through seisin's proxy", { skip: browserSkip }, () => {
  const { run } = browserRepo('browsers = ["chromium"]');
  const r = run("https://example.com");
  assert.match(r.stdout, /GOTO 200 Example Domain/, r.stdout + r.stderr);
  assert.equal(r.status, 0, r.stderr);
});

test("a host off the network list still does not load, browser or not", { skip: browserSkip }, () => {
  const { run } = browserRepo('browsers = ["chromium"]');
  const r = run("https://www.iana.org");
  assert.match(r.stdout, /FAIL .*ERR_TUNNEL_CONNECTION_FAILED/, r.stdout + r.stderr);
  assert.notEqual(r.status, 0);
});

test("without the opt-in Chromium is still denied, and the log and the run say why", { skip: browserSkip }, () => {
  const { run, log } = browserRepo("");
  const r = run("https://example.com");
  assert.doesNotMatch(r.stdout, /GOTO/);
  assert.notEqual(r.status, 0);
  assert.match(log(), new RegExp(`"action":"mach-register","kind":"system","target":"${PREFIX.replace(/\./g, "\\.")}\\d+","verdict":"denied"`));
  assert.match(r.stderr, /agent started chromium and the sandbox denied the Mach service it registers at start/);
  assert.match(r.stderr, /Add browsers = \["chromium"\] to \[roles\.agent\]/);
});

