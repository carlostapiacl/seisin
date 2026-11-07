/**
 * The status a run leaves with when its key fails or its runtime is killed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { boxed, CLI } from "./_tmp.js";
import { resolveSrt } from "../src/commands/run.js";
import { runsRoot } from "../src/rundir.js";

/* ── P0-8: a run that fails leaves nothing behind, and says so with exit 2 ── */

const noSrt = resolveSrt() ? false : "sandbox runtime not installed";

/** The run directories still on disk that belong to process `pid`. */
function leftBy(pid) {
  const root = runsRoot();
  return readdirSync(root).filter((n) => {
    try { return Number(readFileSync(join(root, n, "pid"), "utf8")) === pid; } catch { return false; }
  });
}

test("a run whose key cannot be resolved exits 2 and removes its run directory", { skip: noSrt }, () => {
  const dir = boxed("rh-key-");
  writeFileSync(join(dir, "seisin.toml"),
    '[roles.keyed]\nwrites = ["src/**"]\nkeys = ["TOK=file://not-there.txt"]\nkey_mode = "run-file"\n');
  // Fails after the run directory, the settings and the spool exist.
  const r = spawnSync(process.execPath, [CLI, "run", "keyed", "--", "true"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot read/);
  assert.deepEqual(leftBy(r.pid), [], "the run's directory — socket, settings — stayed on disk");
});

test("a runtime killed by a signal exits 128 + n, like a run that was stopped", { skip: noSrt }, async () => {
  const dir = boxed("rh-sig-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.plain]\nwrites = ["src/**"]\n');
  const child = spawn(process.execPath, [CLI, "run", "plain", "--", "sleep", "20"], { cwd: dir, stdio: "ignore" });
  // The runtime is seisin's direct child other than `log stream` — the one
  // running the agent's command, not the canary's that runs before it.
  let srt = null;
  for (const end = Date.now() + 15_000; !srt && Date.now() < end;) {
    await new Promise((ok) => setTimeout(ok, 100));
    const ps = spawnSync("/bin/ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" }).stdout;
    srt = ps.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .find((m) => m && Number(m[2]) === child.pid && /srt|tartaros/.test(m[3]) && /sleep 20/.test(m[3]))?.[1];
  }
  assert.ok(srt, "the runtime never started");
  process.kill(Number(srt), "SIGKILL");
  const [code] = await once(child, "exit");
  assert.equal(code, 128 + 9);
  assert.deepEqual(leftBy(child.pid), []);
});
