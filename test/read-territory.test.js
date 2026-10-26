/**
 * `[runtime] read = "territory"`, the canary, and the run's settings kept from
 * the run.
 *
 * Asked for by an orchestrator that confines the agents it evaluates and could
 * not use seisin for it: measured on 2026-10-06, a role under `isolate =
 * "credentials"` could still list `~/.claude`, list the whole project tree of
 * the person running it, and read an evaluation check kept outside its
 * worktree. With this mode the same 14 cases pass on macOS, positive controls
 * included (2026-10-09).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { territoryReads, outlastAllows, readPath, dataRoots, shutByTerritory, MAX_CARVE } from "../src/territory.js";
import { loadConfig, readReadMode } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { inspect } from "../src/inspect.js";
import { mkdtempSync, rmSync } from "node:fs";
import { srtSkip } from "./_tmp.js";

// Under the home, not /tmp: /tmp is writable scratch and would make an
// out-of-territory write appear allowed. Keep this fixture outside scratch.
const made = [];
process.on("exit", () => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {} });
const scratch = (prefix) => { const d = mkdtempSync(join(homedir(), prefix)); made.push(d); return d; };

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/* ── the rules, against a fake disk ───────────────────────────────────── */

const disk = (tree) => {
  const kind = (p) => {
    if (p === "/") return "dir";
    let n = tree;
    for (const part of p.split("/").filter(Boolean)) {
      if (n === null || typeof n !== "object" || !(part in n)) return null;
      n = n[part];
    }
    return n === "link" ? "link" : n && typeof n === "object" ? "dir" : "other";
  };
  const readdir = (d) => {
    let n = tree;
    for (const part of d.split("/").filter(Boolean)) n = n[part];
    return Object.keys(n);
  };
  return { kind, readdir, real: (p) => p };
};

const tree = {
  home: {
    ana: {
      ".ssh": { id: 1 }, ".claude": { s: 1 }, notes: 1,
      work: { repo: { src: { a: 1 } }, other: { x: 1 }, reserved: { check: 1 } },
      link: "link",
    },
    bob: { x: 1 },
  },
  tmp: { a: 1, b: { c: 1 } },
};

const mac = (roots, keep, opts = {}) => territoryReads(roots, keep, { platform: "darwin", fs: disk(tree), ...opts });
const linux = (roots, keep, opts = {}) => territoryReads(roots, keep, { platform: "linux", fs: disk(tree), ...opts });

test("a data root is denied whole, and what is kept inside it is allowed back", () => {
  assert.deepEqual(mac(["/home", "/tmp"], ["/home/ana/work/repo"]),
    { deny: ["/home", "/tmp"], allow: ["/home/ana/work/repo"] });
});

test("nothing is denied by name: an entry made after the rules is under the deny like the rest", () => {
  // The carving this replaced listed /home/ana/work/other by name, and a
  // /home/ana/work/later made during the run was in no rule at all.
  const { deny } = mac(["/home"], ["/home/ana/work/repo"]);
  assert.deepEqual(deny, ["/home"]);
});

test("a root kept whole is not denied, and a nested root is covered by the outer one", () => {
  assert.deepEqual(mac(["/home", "/home/ana"], ["/home/ana/work/repo"]).deny, ["/home"]);
  assert.deepEqual(mac(["/home", "/tmp"], ["/home"]), { deny: ["/tmp"], allow: [] });
});

test("a kept path outside every root needs no allow", () => {
  assert.deepEqual(mac(["/tmp"], ["/home/ana/work/repo"]), { deny: ["/tmp"], allow: [] });
});

test("Linux: a kept directory holding a write path is allowed back around it, not over it", () => {
  // The runtime mounts read allows read-only on top of the write mounts, so
  // the repo itself as an allow would make src read-only.
  const out = linux(["/home"], ["/home/ana/work/repo", "/home/ana/work/repo/src"], { writes: ["/home/ana/work/repo/src"] });
  assert.deepEqual(out.deny, ["/home"]);
  assert.ok(!out.allow.includes("/home/ana/work/repo"), out.allow.join(" "));
  assert.ok(!out.allow.some((p) => p.startsWith("/home/ana/work/repo/src")), "the write comes back as a write");
  const t2 = { home: { ana: { repo: { ".git": { x: 1 }, README: 1, lib: { a: 1, gen: { b: 1 } }, link: "link" } } } };
  const deep = territoryReads(["/home"], ["/home/ana/repo"], { platform: "linux", fs: disk(t2), writes: ["/home/ana/repo/lib/gen"] });
  assert.deepEqual(deep.allow.sort(), ["/home/ana/repo/.git", "/home/ana/repo/README", "/home/ana/repo/lib/a", "/home/ana/repo/link"]);
  assert.deepEqual(territoryReads(["/home"], ["/home/ana/repo"], { platform: "darwin", fs: disk(t2), writes: ["/home/ana/repo/lib/gen"] }).allow,
    ["/home/ana/repo"], "macOS keeps read and write apart, so the repo is one allow");
  // A piece that is itself denied — the key directory — is not allowed back:
  // on Linux the deny's own mount would restore it whole.
  const keyed = territoryReads(["/home"], ["/home/ana/repo"], { platform: "linux", fs: disk(t2), writes: ["/home/ana/repo/lib/gen"], denied: ["/home/ana/repo/.git"] });
  assert.ok(!keyed.allow.includes("/home/ana/repo/.git"), keyed.allow.join(" "));
});

test("a kept path at or under a deny of seisin's own is not allowed back", () => {
  assert.deepEqual(mac(["/home"], ["/home/ana/work/repo", "/home/ana/.ssh/config"], { denied: ["/home/ana/.ssh"] }).allow,
    ["/home/ana/work/repo"]);
});

test("Linux: a directory too big to allow back piece by piece is refused, and named", () => {
  const big = { home: { ana: { repo: Object.fromEntries(Array.from({ length: MAX_CARVE + 1 }, (_, i) => [`f${i}`, 1])) } } };
  big.home.ana.repo.src = {};
  assert.throws(() => territoryReads(["/home"], ["/home/ana/repo"], { platform: "linux", fs: disk(big), writes: ["/home/ana/repo/src"] }),
    /cannot keep \/home\/ana\/repo readable around what the role writes inside it: it holds 1002 entries/);
});

test("macOS: a deny inside an allow, with allows of its own, is spelt so it comes back minus them", () => {
  // srt re-emits a deny inside an allow after the allows; as a path it comes
  // back whole and shuts the key, as a pattern it comes back minus the key.
  const out = outlastAllows(
    ["/home/ana/repo/.secrets", "/home/ana/repo/private", "/home", "/run/x"],
    ["/home/ana/repo", "/home/ana/repo/.secrets/k.txt", "/run/x/mine"]);
  assert.deepEqual(out, ["/home/ana/repo/.secret[s]", "/home/ana/repo/private", "/home", "/run/x"],
    "only the one inside an allow AND around one changes");
  assert.deepEqual(outlastAllows(["/h/r/.d.."], ["/h/r", "/h/r/.d../k"]), ["/h/r/.[d].."]);
  assert.throws(() => outlastAllows(["/h/r/a[1]"], ["/h/r", "/h/r/a[1]/k"]), /cannot keep \/h\/r\/a\[1\] shut/);
});

test("the data roots include HOME and TMPDIR wherever they are", () => {
  const roots = dataRoots("linux", "/srv/users/ana", "/scratch/tmp", (p) => p);
  assert.ok(roots.includes("/srv/users/ana") && roots.includes("/scratch/tmp") && roots.includes("/home"));
  assert.ok(!roots.includes("/usr") && !roots.includes("/opt"), "the system stays readable");
});

/* ── the settings ─────────────────────────────────────────────────────── */

test("read is \"all\" unless it says otherwise, and an unknown value is refused", () => {
  assert.equal(readReadMode(undefined), "all");
  assert.equal(readReadMode("territory"), "territory");
  for (const v of ["Territory", "none", true, "deny"])
    assert.throws(() => readReadMode(v), /runtime\.read/, JSON.stringify(v));
});

const repo = (toml) => {
  const base = realpathSync(scratch("seisin-territory-"));
  const root = join(base, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".secrets"), { recursive: true });
  mkdirSync(join(base, "reserved"), { recursive: true });
  writeFileSync(join(root, "src", "a.txt"), "inside\n");
  writeFileSync(join(root, ".secrets", "k.txt"), "KEY-VALUE\n");
  writeFileSync(join(root, ".secrets", "other.txt"), "NOT-GRANTED\n");
  writeFileSync(join(base, "reserved", "check.sh"), "RESERVED-CHECK\n");
  writeFileSync(join(root, "seisin.toml"), toml);
  return { base, root };
};

const POLICY = `[runtime]\nread = "territory"\nwrites = []\n\n[keys]\ndir = [".secrets"]\n\n` +
  `[roles.dev]\nwrites = ["src/**"]\nkeys = ["k.txt"]\nnetwork = []\n`;

test("reads and toolchain take a path or a subtree, never a pattern", () => {
  for (const bad of ["docs/*.md", "**", "src/*/x/**"]) {
    const { root } = repo(POLICY.replace('keys = ["k.txt"]', `keys = ["k.txt"]\nreads = ["${bad}"]`));
    assert.throws(() => loadConfig(join(root, "seisin.toml")), /cannot be enforced as written/, bad);
  }
  const { root } = repo(POLICY.replace('keys = ["k.txt"]', 'keys = ["k.txt"]\nreads = ["docs/**", "../shared"]'));
  assert.deepEqual(loadConfig(join(root, "seisin.toml")).roles.dev.reads, ["docs/**", "../shared"]);
  assert.equal(readPath("/r", "docs/**"), "/r/docs");
});

test("the settings deny the home whole and allow the repo back", () => {
  const { base, root } = repo(POLICY);
  const s = settingsFor(loadConfig(join(root, "seisin.toml")), "dev");
  const { denyRead: deny, allowRead: allow } = s.filesystem;
  assert.ok(deny.includes(realpathSync(homedir())) || deny.some((d) => homedir().startsWith(d + "/")), "the home, whole");
  assert.ok(!deny.includes(join(base, "reserved")), "nothing beside the repo is named: the deny covers it, now and later");
  assert.ok(allow.some((p) => p === root || root.startsWith(p + "/")) ||
    (process.platform === "linux" && allow.includes(join(root, "seisin.toml"))), "the repo is allowed back");
  assert.ok(allow.some((p) => p.endsWith("/k.txt")), "the key is re-allowed as before");
});

test("a reads entry inside a deny of its own stays shut", () => {
  const { root } = repo(POLICY.replace('keys = ["k.txt"]', 'keys = ["k.txt"]\nreads = [".secrets/other.txt"]'));
  const s = settingsFor(loadConfig(join(root, "seisin.toml")), "dev");
  assert.ok(!s.filesystem.allowRead.some((p) => p.endsWith("other.txt")), s.filesystem.allowRead.join(" "));
});

test("the run's own settings are denied to the run", () => {
  const { root } = repo(POLICY.replace('read = "territory"\n', ""));
  const sock = "/tmp/x/snr/abc-123/sock";
  const s = settingsFor(loadConfig(join(root, "seisin.toml")), "dev", sock);
  assert.ok(s.filesystem.denyRead.includes("/tmp/x/snr/abc-123/settings.json"));
});

test("check: reads under read = \"all\" is said to change nothing", () => {
  const { root } = repo(POLICY.replace('read = "territory"\n', "").replace('keys = ["k.txt"]', 'keys = ["k.txt"]\ntoolchain = ["~/.venvs/x"]'));
  const w = inspect(loadConfig(join(root, "seisin.toml"))).warnings;
  assert.ok(w.some((x) => x.kind === "reads-without-territory"));
});

test("check: a toolchain that does not exist, and a role with no verify, are named", () => {
  const { root } = repo(POLICY.replace('keys = ["k.txt"]', 'keys = ["k.txt"]\ntoolchain = ["/nonexistent/venv"]'));
  const w = inspect(loadConfig(join(root, "seisin.toml"))).warnings.map((x) => x.kind);
  assert.ok(w.includes("toolchain-missing"));
  assert.ok(w.includes("no-verify"));
});

test("check: a read grant that re-opens a whole home is named", () => {
  const { root } = repo(POLICY.replace('keys = ["k.txt"]', 'keys = ["k.txt"]\nreads = ["~"]'));
  const w = inspect(loadConfig(join(root, "seisin.toml"))).warnings;
  assert.ok(w.some((x) => x.kind === "territory-reopened"), w.map((x) => x.kind).join(" "));
  const { root: ok } = repo(POLICY.replace('keys = ["k.txt"]', 'keys = ["k.txt"]\nreads = ["~/some/dir"]'));
  assert.ok(!inspect(loadConfig(join(ok, "seisin.toml"))).warnings.some((x) => x.kind === "territory-reopened"));
});

test("check: a PATH entry under a data root and not kept is shut", () => {
  const id = (p) => p;
  assert.equal(shutByTerritory("/home/ana/.nvm/bin", ["/home/ana/work/repo"], ["/home"], id), true);
  assert.equal(shutByTerritory("/home/ana/.nvm/bin", ["/home/ana/.nvm"], ["/home"], id), false);
  assert.equal(shutByTerritory("/usr/local/bin", ["/home/ana/work/repo"], ["/home"], id), false);
});

/* ── against the kernel ───────────────────────────────────────────────── */

const skip = srtSkip();

const run = (cwd, role, script) => new Promise((ok) => {
  let out = "", err = "";
  const p = spawn(process.execPath, [CLI, "run", role, "--agent", "none", "--", "/bin/sh", "-c", script], { cwd });
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => ok({ out: `${out}\n${err}`, code }));
});

test("against the kernel: the repo and the key read, the sibling and the settings do not", { skip }, async () => {
  const { base, root } = repo(POLICY);
  const { out, code } = await run(root, "dev",
    `cat src/a.txt; cat .secrets/k.txt >/dev/null && echo KEY-READ; ` +
    `cat .secrets/other.txt 2>/dev/null; cat '${join(base, "reserved", "check.sh")}' 2>/dev/null; ` +
    `cat "$(dirname "$SEISIN_SPOOL")/settings.json" >/dev/null 2>&1 && echo POLICY-READ; ` +
    `echo w > src/new.txt && cat src/new.txt; ` +
    `if echo OUTSIDE-WRITE > ../reserved/escaped.txt 2>/dev/null; then echo OUTSIDE-WRITE; fi; echo DONE`);
  assert.match(out, /· read territory/);
  assert.equal(code, 0, out);
  assert.match(out, /inside/, "positive control: the repo reads");
  assert.match(out, /KEY-READ/, "the granted key still reads with the repo kept");
  assert.match(out, /^w$/m, "positive control: the territory writes and reads back");
  assert.match(out, /DONE/, "the command continues after the denied write");
  assert.doesNotMatch(out, /NOT-GRANTED/, "a key not granted");
  assert.doesNotMatch(out, /RESERVED-CHECK/, "a file beside the repo");
  assert.doesNotMatch(out, /POLICY-READ/, "the run's own settings");
  assert.equal(existsSync(join(base, "reserved", "escaped.txt")), false,
    "positive control: a sibling outside the role's territory is not writable");
});

test("against the kernel: what another run creates beside this one, after it started, does not read", { skip }, async () => {
  // A data directory shared by concurrent runs: each has its turn directory
  // under turns/ and its worktree under worktrees/. Run B's turn directory —
  // its MCP token, its transcript — is made after run A started. The carving
  // that came before denied the siblings it found at start, and B's was not
  // one of them.
  const base = realpathSync(scratch("seisin-late-"));
  const root = join(base, "worktrees", "task-a");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".secrets"), { recursive: true });
  mkdirSync(join(base, "turns", "a"), { recursive: true });
  writeFileSync(join(root, "src", "a.txt"), "inside\n");
  writeFileSync(join(root, ".secrets", "k.txt"), "KEY-VALUE\n");
  writeFileSync(join(base, "turns", "a", "early.txt"), "OWN-TURN-EARLY\n");
  writeFileSync(join(root, "seisin.toml"), POLICY.replace('keys = ["k.txt"]', 'keys = ["k.txt"]\nreads = ["../../turns/a"]'));
  const go = join(root, "src", "go");
  const script = `i=0; while [ ! -f src/go ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done; test -f src/go && echo STARTED-BEFORE; ` +
    `cat src/a.txt ../../turns/a/early.txt ../../turns/a/late.txt; cat .secrets/k.txt >/dev/null && echo KEY-READ; ` +
    `cat ../../turns/b/config/mcp.json ../../turns/b/private/t.jsonl ../../worktrees/task-b/x ../../late.txt 2>/dev/null; ` +
    `echo w > src/new.txt && cat src/new.txt; echo DONE`;
  const done = run(root, "dev", script);
  // Made once the run is confined: the run reads src/go only after this.
  await new Promise((ok) => setTimeout(ok, 3000));
  mkdirSync(join(base, "turns", "b", "config"), { recursive: true });
  mkdirSync(join(base, "turns", "b", "private"), { recursive: true });
  mkdirSync(join(base, "worktrees", "task-b"), { recursive: true });
  writeFileSync(join(base, "turns", "b", "config", "mcp.json"), '{"token":"LATE-MCP-TOKEN"}\n');
  writeFileSync(join(base, "turns", "b", "private", "t.jsonl"), "LATE-TRANSCRIPT\n");
  writeFileSync(join(base, "worktrees", "task-b", "x"), "LATE-WORKTREE\n");
  writeFileSync(join(base, "late.txt"), "LATE-TOP\n");
  writeFileSync(join(base, "turns", "a", "late.txt"), "OWN-TURN-LATE\n");
  writeFileSync(go, "");
  const { out, code } = await done;
  assert.equal(code, 0, out);
  assert.match(out, /STARTED-BEFORE/, "the entries were made while the run was already running");
  assert.match(out, /inside/, "positive control: the repo reads");
  assert.match(out, /KEY-READ/, "positive control: the granted key reads");
  assert.match(out, /OWN-TURN-EARLY/, "positive control: the run's own turn directory reads");
  assert.match(out, /OWN-TURN-LATE/, "positive control: an entry made during the run where the role keeps it reads");
  assert.match(out, /^w$/m, "positive control: the territory writes");
  for (const leak of ["LATE-MCP-TOKEN", "LATE-TRANSCRIPT", "LATE-WORKTREE", "LATE-TOP"])
    assert.doesNotMatch(out, new RegExp(leak), leak);
  assert.match(out, /DONE/);
});

test("against the kernel: a name with two unclosed [ beside the repo neither stops the run nor reads", { skip }, async () => {
  const { base, root } = repo(POLICY);
  writeFileSync(join(base, "notes [a [b"), "BRACKET-SECRET\n");
  const { out, code } = await run(root, "dev", `cat '${join(base, "notes [a [b")}' 2>/dev/null; cat src/a.txt; echo DONE`);
  assert.equal(code, 0, out);
  assert.match(out, /inside/, "positive control: the run started and the repo reads");
  assert.doesNotMatch(out, /BRACKET-SECRET/);
});

test("against the kernel: a symlink out of the repo does not carry the read with it", { skip }, async () => {
  const { base, root } = repo(POLICY);
  symlinkSync(join(base, "reserved"), join(root, "src", "peek"));
  const { out } = await run(root, "dev", "cat src/peek/check.sh 2>/dev/null; echo done");
  assert.doesNotMatch(out, /RESERVED-CHECK/);
  assert.match(out, /done/);
});

test("against the kernel: check --verify runs the role's command in its sandbox", { skip }, async () => {
  // verify runs in the repo root, so the reserved check is one level up — and
  // shut. The command fails inside the sandbox, which is what check must say.
  const { root } = repo(POLICY.replace('keys = ["k.txt"]',
    'keys = ["k.txt"]\nverify = ["/bin/sh", "-c", "cat ../reserved/check.sh"]'));
  const res = await new Promise((ok) => {
    let out = "";
    const p = spawn(process.execPath, [CLI, "check", "--verify"], { cwd: root });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ out, code }));
  });
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /✗ verify dev/);

  const parallel = await new Promise((ok) => {
    let out = "";
    const p = spawn(process.execPath, [CLI, "check", "--verify", "--parallel"], { cwd: root });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ out, code }));
  });
  assert.equal(parallel.code, 1, parallel.out);
  assert.match(parallel.out, /experimental: verify commands are running concurrently/);
  assert.match(parallel.out, /✗ verify dev/);
});

test("against the kernel: experimental parallel verify overlaps role checks", { skip }, async () => {
  const policy = `[runtime]\nread = "territory"\nwrites = []\n\n` +
    `[roles.alpha]\nwrites = ["alpha/**"]\n` +
    `verify = ["/bin/sh", "-c", "printf ready > alpha/ready; i=0; while [ ! -f beta/ready ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; test -f beta/ready"]\n\n` +
    `[roles.beta]\nwrites = ["beta/**"]\n` +
    `verify = ["/bin/sh", "-c", "printf ready > beta/ready; i=0; while [ ! -f alpha/ready ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done; test -f alpha/ready"]\n`;
  const { root } = repo(policy);
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, "beta"));
  const res = await new Promise((ok) => {
    let out = "";
    const p = spawn(process.execPath, [CLI, "check", "--verify", "--parallel"], { cwd: root });
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ out, code }));
  });
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /✓ verify alpha/);
  assert.match(res.out, /✓ verify beta/);
});

/* ── the canary ───────────────────────────────────────────────────────── */

import { runCanary, CANARY_EXIT } from "../src/canary.js";
import { openRun } from "../src/rundir.js";
import { resolveSrt } from "../src/commands/run.js";
import { writePathsOf } from "../src/grants.js";

// Each break is one the generator could plausibly produce; each must stop the
// run with its own reason, and the unbroken policy must pass.
const BREAKS = {
  none: [(s) => s, null],
  "the run's settings left readable": [(s) => { s.filesystem.denyRead = s.filesystem.denyRead.filter((p) => !p.endsWith("settings.json") && !p.endsWith("/snr")); return s; }, /settings were readable/],
  "a write outside the territory": [(s, run) => { s.filesystem.denyWrite = s.filesystem.denyWrite.filter((p) => !p.includes("/snr")); s.filesystem.allowWrite.push(run.dir); return s; }, /write outside the territory went through/],
  // macOS only: on Linux the runtime gives each role a network namespace of its
  // own, so local_binding reaches nothing on the host and the decoy stays
  // unreachable — measured in Docker (Debian 12, bwrap 0.8.0), and the canary
  // rightly passes it.
  ...(process.platform === "darwin"
    ? { "loopback open": [(s) => { s.network.allowLocalBinding = true; return s; }, /loopback port outside the policy was reachable/] }
    : {}),
  "the territory's grant lost": [(s) => { s.filesystem.allowWrite = []; return s; }, /positive control/],
  // The runtime grants /tmp/claude to every sandbox; only seisin's deny takes
  // it back. Made if missing, as Claude Code would: there is no probe without it.
  "the runtime's shared temp directory left writable": [(s) => {
    mkdirSync("/tmp/claude", { recursive: true });
    s.filesystem.denyWrite = s.filesystem.denyWrite.filter((p) => !/^(\/private)?\/tmp\/claude$/.test(p));
    return s;
  }, /shared temp directory went through/],
};

for (const [name, [mutate, expect]] of Object.entries(BREAKS))
  test(`against the kernel: the canary ${expect ? `stops a policy with ${name}` : "passes the policy as generated"}`, { skip }, async () => {
    const { root } = repo(POLICY);
    const config = loadConfig(join(root, "seisin.toml"));
    const run = openRun();
    try {
      const settings = mutate(settingsFor(config, "dev", run.sock, false, { agent: null }), run);
      const file = run.writeSettings(settings);
      const r = await runCanary({
        srt: resolveSrt(), settingsFile: file, settings, env: { PATH: process.env.PATH, HOME: process.env.HOME },
        cwd: root, runDir: run.dir, runsRoot: run.root, role: config.roles.dev,
        granted: writePathsOf(config, config.roles.dev, { agent: null }),
      });
      if (!expect) assert.ok(r.ok, r.failed.join("; "));
      else { assert.equal(r.ok, false); assert.ok(r.failed.some((f) => expect.test(f)), r.failed.join("; ")); }
    } finally { run.close(); }
  });

test("the canary fails closed on a sandbox that runs nothing", { skip }, async () => {
  // No way to swap the runtime from the environment exists, on purpose; the
  // canary is handed one directly. It exits 0 and runs nothing — the shape
  // of a runtime that broke quietly — and that must not read as "all denied".
  const { root } = repo(POLICY);
  const fake = join(root, "..", "fake-srt");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const config = loadConfig(join(root, "seisin.toml"));
  const run = openRun();
  try {
    const settings = settingsFor(config, "dev", run.sock, false, { agent: null });
    const r = await runCanary({
      srt: fake, settingsFile: run.writeSettings(settings), settings, env: { PATH: process.env.PATH },
      cwd: root, runDir: run.dir, runsRoot: run.root, role: config.roles.dev,
      granted: writePathsOf(config, config.roles.dev, { agent: null }),
    });
    assert.equal(r.ok, false);
    assert.ok(r.failed.some((f) => /did not run the canary at all/.test(f)), r.failed.join("; "));
    assert.equal(CANARY_EXIT, 86);
  } finally { run.close(); }
});

test("territory keeps ~/.CFUserTextEncoding readable on macOS: every process reads it at start, and it holds no secret", async () => {
  const { keptFor, PLATFORM_FILES } = await import("../src/territory.js");
  const { homedir } = await import("node:os");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "seisin-cfu-"));
  writeFileSync(join(dir, "seisin.toml"), '[roles.a]\nwrites = ["src/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const kept = keptFor(config, config.roles.a, {});
  const file = `${homedir()}/.CFUserTextEncoding`;
  assert.equal(kept.includes(file), process.platform === "darwin");
  assert.deepEqual(PLATFORM_FILES.linux, []);
});
