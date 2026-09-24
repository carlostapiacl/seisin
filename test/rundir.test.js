/**
 * The per-run directory, against the real kernel: what one run keeps there is
 * reachable by that run and by nobody else, and it does not outlive the run.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSrt } from "../src/commands/run.js";
import { runsRoot, runsRootOf, openRun } from "../src/rundir.js";
import { boxed } from "./_tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const SPOOL = join(HERE, "..", "src", "spool.js");
const skip = resolveSrt() ? false : "sandbox runtime not installed";

let repo;
before(() => {
  const box = join(HERE, ".sandbox-box");
  mkdirSync(box, { recursive: true });
  repo = boxed("rundir-");
  mkdirSync(join(repo, "a"), { recursive: true });
  mkdirSync(join(repo, "b"), { recursive: true });
  writeFileSync(join(repo, "token.txt"), "scratch-secret-value\n");
  writeFileSync(join(repo, "seisin.toml"),
    '[roles.a]\nwrites = ["a/**"]\nkeys = ["S=file://token.txt"]\nkey_mode = "scratch"\n\n' +
    '[roles.b]\nwrites = ["b/**"]\n');
});

/**
 * Polls for a file the run inside the box writes. Generous on purpose: the
 * full suite once ran on a machine at load 468, where starting a sandbox took
 * longer than the 5 s this used to allow.
 */
async function waitFor(file, ms = 30000) {
  for (const end = Date.now() + ms; !existsSync(file) && Date.now() < end;)
    await new Promise((r) => setTimeout(r, 50));
}

const as = (role, line) =>
  spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line], { cwd: repo, encoding: "utf8" });

test("a role cannot read another role's scratch key while it runs", { skip }, async () => {
  // Measured before: b read a's key file (`cat …/keys/S` printed the value).
  const holder = spawn(process.execPath,
    [CLI, "run", "a", "--", "sh", "-c", 'echo "$S_FILE" > a/where; while [ ! -f a/done ]; do sleep 0.1; done'], { cwd: repo });
  const where = join(repo, "a", "where");
  await waitFor(where);
  const path = readFileSync(where, "utf8").trim();
  assert.ok(path.includes("/snr/"), path);
  const r = as("b", `cat '${path}'`);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /scratch-secret-value/);
  // ...and its owner still reads it, or the deny would be blanket.
  writeFileSync(join(repo, "a", "done"), "");
  await new Promise((r) => holder.on("exit", r));
  assert.equal(as("a", 'test "$(cat "$S_FILE")" = scratch-secret-value').status, 0);
});

test("the hook's channel still reaches the parent from inside the box", { skip }, () => {
  // Other runs' directories are unreadable now; this run's socket must still
  // take a line. Sent the way the hook sends it.
  const line =
    `node --input-type=module -e 'const s = await import("${SPOOL}");` +
    ` s.send("log", { tool: "Write", action: "write", target: "b/x.txt", verdict: "allowed" });` +
    ` await s.flush();'`;
  assert.equal(as("b", line).status, 0);
  const log = readFileSync(join(repo, ".seisin", "log.jsonl"), "utf8");
  assert.match(log, /"role":"b","tool":"Write","action":"write","kind":"file","target":"b\/x.txt"/);
});

test("two runs of one role at once each get their own settings", { skip }, async () => {
  // `.seisin/<role>.json` was one file per role, rewritten by every run.
  const both = await Promise.all([0, 1].map(() => new Promise((ok) => {
    const c = spawn(process.execPath, [CLI, "run", "b", "--", "sh", "-c", "sleep 1"], { cwd: repo });
    c.on("exit", ok);
  })));
  assert.deepEqual(both, [0, 0]);
  assert.ok(!existsSync(join(repo, ".seisin", "b.json")));
});

test("a run directory left by a killed run is swept, keys and all", () => {
  const root = runsRoot();
  const dead = mkdtempSync(join(root, "dead00-"));
  // A pid that is not running: spawn something short and wait for it to end.
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  writeFileSync(join(dead, "pid"), gone);
  mkdirSync(join(dead, "keys"));
  writeFileSync(join(dead, "keys", "S"), "left-behind");
  const run = openRun();
  try {
    assert.ok(!existsSync(dead), "a dead run's directory survived the next run");
    assert.ok(readdirSync(root).includes(run.dir.split("/").pop()));
  } finally {
    run.close();
  }
});

test("settings are written once per run, never over a file that exists", () => {
  const run = openRun();
  try {
    run.writeSettings({ a: 1 });
    assert.throws(() => run.writeSettings({ a: 2 }), /EEXIST/);
  } finally {
    run.close();
  }
});

test("runsRootOf only recognises seisin's own layout", () => {
  assert.equal(runsRootOf("/tmp/x/snr/abc123-Q/s.sock"), "/tmp/x/snr");
  assert.equal(runsRootOf("/tmp/seisin-abc/spool.sock"), null);
  assert.equal(runsRootOf(null), null);
});

test("a run stopped by SIGTERM stops its agent, cleans up, and does not report success", { skip }, async () => {
  // Measured before: the parent died at once, the agent (`sleep 30`) kept
  // running with nobody holding its audit socket, and the directory stayed.
  // With the signal forwarded, the runtime then ended 0 — success, for a run
  // an orchestrator had just killed.
  // The agent writes `up` at once and would write `alive` after 3 s if it kept
  // running. A SIGTERM to seisin must stop the agent, so `alive` never appears.
  // Checked by that marker, not by probing the agent's pid: under bubblewrap the
  // pid is namespaced, so process.kill from outside gives EPERM, not ESRCH.
  const c = spawn(process.execPath,
    [CLI, "run", "b", "--", "sh", "-c", "echo up > b/up; sleep 3; echo alive > b/alive; sleep 30"], { cwd: repo });
  await waitFor(join(repo, "b", "up"));
  const t = Date.now();
  c.kill("SIGTERM");
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 143);
  assert.ok(Date.now() - t < 20000);
  await new Promise((r) => setTimeout(r, 5000));   // longer than the agent's 3 s
  assert.ok(!existsSync(join(repo, "b", "alive")), "the agent outlived its run");
});

test("the FIFO channel carries lines, and a parent that is gone costs nothing", async () => {
  // The channel Linux uses, where the runtime blocks every unix socket in the
  // box. Measured before: on Linux the hook "sent" and the log stayed empty.
  const { spool, send } = await import("../src/spool.js");
  const run = openRun();
  const path = join(run.dir, "t.fifo");
  const got = [];
  const s = await spool((to, entry) => got.push([to, entry.target]), path);
  try {
    assert.equal(send("log", { target: "a" }, path), true);
    assert.equal(send("requests", { target: "b", reason: "x".repeat(10_000) }, path), true);
    for (let i = 0; i < 100 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got, [["log", "a"], ["requests", "b"]]);
  } finally {
    s.close();
    run.close();
  }
  // No reader: an error swallowed, not a hung tool call.
  assert.equal(send("log", { target: "c" }, path), false);
});

/**
 * Starts a run in its own process group and, once the agent says "ready",
 * sends SIGINT to the group, as a terminal does on Ctrl-C. On the agent's
 * word and not after a fixed delay: under load (the suite once ran at load
 * 165) the signal arrived before the agent had installed its handler.
 */
function ctrlC(childScript) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, "run", "b", "--", "node", "-e", childScript],
      { cwd: repo, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    let sent = false;
    p.stdout.on("data", (d) => {
      out += d;
      if (!sent && out.includes("ready")) { sent = true; try { process.kill(-p.pid, "SIGINT"); } catch {} }
    });
    p.on("exit", (code) => ok({ code, out }));
  });
}

// macOS only: on Linux the runtime kills the agent on Ctrl-C even when it
// catches SIGINT (measured in Docker with the runtime alone, no seisin), so
// there is no count to read. The next test holds on both.
test("Ctrl-C reaches the agent as many times as it did before seisin handled signals, not more",
  { skip: skip || (process.platform === "darwin" ? false : "the runtime kills the agent on Ctrl-C on Linux") }, async () => {
  // Measured: 2 SIGINTs before signals were handled (the runtime already
  // forwards the group's), 3 when seisin forwarded too. Two in a row is how
  // Claude Code tells "cancel" from "quit".
  const { code, out } = await ctrlC(
    'let n=0; process.on("SIGINT",()=>n++); console.log("ready"); setTimeout(()=>{console.log("got "+n); process.exit(0)}, 3000);');
  const got = Number(/got (\d+)/.exec(out)?.[1]);
  assert.ok(got >= 1 && got <= 2, `the agent got ${got} SIGINTs for one Ctrl-C`);
  // Interrupted is not a success, even when the agent caught it: the runtime
  // exits 0 either way, so seisin cannot tell the two apart (see run.js).
  assert.equal(code, 130);
});

test("Ctrl-C to an agent that does not catch it ends the run with a failure", { skip }, async () => {
  const { code } = await ctrlC('console.log("ready"); setTimeout(()=>{}, 30000)');
  assert.notEqual(code, 0);
  assert.notEqual(code, null, "seisin itself died of the signal");
});
