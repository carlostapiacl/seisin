/**
 * What is left of a run when `seisin run` is killed outright.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CLI, boxed, sandboxSkip } from "./_tmp.js";
import { follow, alive } from "../src/watchdog.js";

const skip = sandboxSkip();
const up = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return true; return ok(); };

test("what is followed goes down by parent, and a pid handed to another process is dropped", () => {
  const known = new Map([[10, "a"]]);
  follow(known, [{ pid: 10, ppid: 1, start: "a" }, { pid: 11, ppid: 10, start: "b" }, { pid: 12, ppid: 11, start: "c" }, { pid: 13, ppid: 1, start: "d" }]);
  assert.deepEqual([...known.keys()], [10, 11, 12]);
  // 11 died and its pid is someone else's now; 10 is gone; 12 was orphaned and is still the same process.
  const later = [{ pid: 11, ppid: 1, start: "other" }, { pid: 12, ppid: 1, start: "c" }];
  follow(known, later);
  assert.deepEqual(alive(known, later), [12]);
});

function start(script) {
  const dir = boxed("watchdog-");
  writeFileSync(join(dir, "seisin.toml"), '[runtime]\nwrites = []\n[roles.dev]\nwrites = ["**"]\n');
  // A group of its own, so the test can do what a launcher does: kill the group.
  const run = spawn(process.execPath, [CLI, "run", "dev", "--agent", "none", "--", "/bin/sh", "-c", script], { cwd: dir, stdio: "ignore", detached: true });
  return { dir, run };
}
const pidIn = (dir, name) => Number(readFileSync(join(dir, name), "utf8"));
const killGroup = (run) => { try { process.kill(-run.pid, "SIGKILL"); } catch {} };
const watchdogOf = (run) => spawnSync("pgrep", ["-P", String(run.pid), "-f", "watchdog.js"], { encoding: "utf8" }).stdout.trim();

// By what the host sees: on Linux the sandbox has a pid namespace, and a pid from inside means nothing here.
const sleepers = (seconds) => spawnSync("pgrep", ["-f", `sleep ${seconds}$`], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);

test("SIGKILL to seisin's group: the agent and a child in its own session die", { skip }, async () => {
  const [own, session] = [70000 + (process.pid % 9000), 80000 + (process.pid % 9000)];
  const detached = `perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep","${session}"'`;
  const { run } = start(`/bin/sleep ${own} & ${detached} & wait`);
  try {
    assert.ok(await until(() => sleepers(own).length > 0 && sleepers(session).length > 0, 20000), "the run did not start");
    await new Promise((r) => setTimeout(r, 2500));         // one scan of the tree
    killGroup(run);
    assert.ok(await until(() => sleepers(own).length === 0), "the agent's child outlived the run");
    assert.ok(await until(() => sleepers(session).length === 0), "the child in another session outlived the run");
  } finally {
    killGroup(run);
    for (const p of [...sleepers(own), ...sleepers(session)]) try { process.kill(p, "SIGKILL"); } catch {}
  }
});

test("a run that ends by itself takes its watchdog with it", { skip }, async () => {
  const { dir, run } = start("/bin/sleep 3; echo done > done");
  try {
    assert.ok(await until(() => watchdogOf(run) !== "", 15000), "no watchdog while the run is up");
    const pid = Number(watchdogOf(run).split("\n")[0]);
    await new Promise((r) => run.once("exit", r));
    assert.ok(existsSync(join(dir, "done")));
    assert.ok(await until(() => !up(pid), 5000), "the watchdog stayed behind");
  } finally { killGroup(run); }
});
