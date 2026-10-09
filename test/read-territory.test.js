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
import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { carveDenies, readPath, dataRoots, shutByTerritory } from "../src/territory.js";
import { loadConfig, readReadMode } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { inspect } from "../src/inspect.js";
import { mkdtempSync, rmSync } from "node:fs";
import { srtSkip } from "./_tmp.js";

// Under /tmp, not TMPDIR: a Mac's TMPDIR holds thousands of entries, and
// carving through it is refused by design (see MAX_CARVE).
const made = [];
process.on("exit", () => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {} });
const scratch = (prefix) => { const d = mkdtempSync(join(realpathSync("/tmp"), prefix)); made.push(d); return d; };

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

/* ── the carving, against a fake disk ────────────────────────────────── */

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

test("a data root with nothing kept under it is denied whole", () => {
  assert.deepEqual(carveDenies(["/tmp"], ["/home/ana/work/repo"], disk(tree)), ["/tmp"]);
});

test("the way to a kept path stays open, and every sibling on it is denied", () => {
  const out = carveDenies(["/home"], ["/home/ana/work/repo"], disk(tree));
  assert.deepEqual(out.sort(), [
    "/home/ana/.claude", "/home/ana/.ssh", "/home/ana/notes",
    "/home/ana/work/other", "/home/ana/work/reserved", "/home/bob",
  ]);
});

test("a symlink on the way is left alone: denying it would deny where it points", () => {
  const out = carveDenies(["/home"], ["/home/ana/work/repo"], disk(tree));
  assert.ok(!out.includes("/home/ana/link"));
});

test("a kept path is readable whole; nothing below it is visited", () => {
  const out = carveDenies(["/home"], ["/home/ana"], disk(tree));
  assert.deepEqual(out, ["/home/bob"]);
});

test("a kept path that does not exist yet still keeps the way to it", () => {
  const out = carveDenies(["/home"], ["/home/ana/work/new/deep"], disk(tree));
  assert.ok(!out.includes("/home/ana/work"));
  assert.ok(out.includes("/home/ana/work/repo"));
});

test("a directory too big to carve is refused, and named", () => {
  const big = { home: { ana: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}`, 1])) } };
  big.home.ana.repo = {};
  assert.throws(() => carveDenies(["/home"], ["/home/ana/repo"], disk(big)), /cannot carve \/home\/ana: it holds 1002 entries/);
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

test("the settings deny the sibling outside the repo and keep the repo", () => {
  const { base, root } = repo(POLICY);
  const s = settingsFor(loadConfig(join(root, "seisin.toml")), "dev");
  const deny = s.filesystem.denyRead;
  assert.ok(deny.includes(join(base, "reserved")), "the reserved check, beside the repo");
  assert.ok(!deny.some((p) => p === root || root.startsWith(p + "/")), "nothing on the way to the repo");
  assert.equal(s.filesystem.allowRead.length >= 1, true, "the key is re-allowed as before");
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

test("check: a PATH entry under a data root and not kept is shut", () => {
  const id = (p) => p;
  assert.equal(shutByTerritory("/home/ana/.nvm/bin", ["/home/ana/work/repo"], ["/home"], id), true);
  assert.equal(shutByTerritory("/home/ana/.nvm/bin", ["/home/ana/.nvm"], ["/home"], id), false);
  assert.equal(shutByTerritory("/usr/local/bin", ["/home/ana/work/repo"], ["/home"], id), false);
});

/* ── against the kernel ───────────────────────────────────────────────── */

const skip = srtSkip() || (process.platform !== "darwin" && "measured on macOS; the Linux carving is not yet measured through seisin");

const run = (cwd, role, script) => new Promise((ok) => {
  let out = "";
  const p = spawn(process.execPath, [CLI, "run", role, "--agent", "none", "--", "/bin/sh", "-c", script], { cwd });
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => ok({ out, code }));
});

test("against the kernel: the repo and the key read, the sibling and the settings do not", { skip }, async () => {
  const { base, root } = repo(POLICY);
  const { out, code } = await run(root, "dev",
    `cat src/a.txt; cat .secrets/k.txt >/dev/null && echo KEY-READ; ` +
    `cat .secrets/other.txt 2>/dev/null; cat '${join(base, "reserved", "check.sh")}' 2>/dev/null; ` +
    `cat "$(dirname "$SEISIN_SPOOL")/settings.json" >/dev/null 2>&1 && echo POLICY-READ; ` +
    `ls ~ >/dev/null 2>&1 && echo HOME-LISTED; echo w > src/new.txt && cat src/new.txt`);
  assert.equal(code, 0, out);
  assert.match(out, /inside/, "positive control: the repo reads");
  assert.match(out, /KEY-READ/, "the granted key still reads with the repo kept");
  assert.match(out, /^w$/m, "positive control: the territory writes and reads back");
  assert.doesNotMatch(out, /NOT-GRANTED/, "a key not granted");
  assert.doesNotMatch(out, /RESERVED-CHECK/, "a file beside the repo");
  assert.doesNotMatch(out, /POLICY-READ/, "the run's own settings");
  assert.doesNotMatch(out, /HOME-LISTED/, "the home");
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
  "loopback open": [(s) => { s.network.allowLocalBinding = true; return s; }, /loopback port outside the policy was reachable/],
  "the territory's grant lost": [(s) => { s.filesystem.allowWrite = []; return s; }, /positive control/],
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
