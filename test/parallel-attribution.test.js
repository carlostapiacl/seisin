/**
 * Several roles running the same command at once: a denial belongs to the one
 * run that caused it, and to no other.
 *
 * Found in the field (four roles in one stage of an agent team): the kernel
 * tags each denial with the command the runtime wrapped, and every watcher
 * recognised that tag as its own when the commands were identical. One write
 * became one line and one request per role running, including a denial logged
 * against the role that owns the path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSrt } from "../src/commands/run.js";
import { boxed, CLI } from "./_tmp.js";


const skip = resolveSrt() === null ? "sandbox runtime not installed"
  : process.platform !== "darwin" ? "kernel denials are read on macOS only" : false;

/** The denied lines of a log, skipping one that is still being written. */
function deniedIn(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean)
    .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => e.verdict === "denied");
}

test("a denial is logged once, against the run that caused it", { skip }, async () => {
  const dir = boxed("parallel-");
  for (const d of ["a", "b", "c"]) mkdirSync(join(dir, d));
  writeFileSync(join(dir, "seisin.toml"),
    '[roles.ra]\nwrites = ["a/**"]\n\n[roles.rb]\nwrites = ["b/**"]\n\n[roles.rc]\nwrites = ["c/**"]\n');
  // The same argv for all three; only ra writes, into rb's territory. On
  // conditions, not on a clock: ra writes once rb and rc are running (each says
  // so in its own territory), and all three stay until this test has seen the
  // denial in the log and says `release` — so every watcher is alive when the
  // kernel's line arrives, however loaded the machine is. Each wait has its own
  // ceiling (30 s) so a broken run ends instead of hanging.
  const wait = (cond) => `n=0; until ${cond} || [ $n -ge 600 ]; do sleep 0.05; n=$((n+1)); done`;
  const cmd =
    'case "$SEISIN_ROLE" in ' +
    `ra) ${wait("[ -e b/up ] && [ -e c/up ]")}; echo x > b/intruso.txt;; ` +
    'rb) touch b/up;; rc) touch c/up;; esac; ' +
    wait("[ -e release ]");
  const runs = ["ra", "rb", "rc"].map((role) => new Promise((ok) =>
    spawn(process.execPath, [CLI, "run", role, "--", "sh", "-c", cmd], { cwd: dir, stdio: "ignore" }).on("close", ok)));

  const log = join(dir, ".seisin", "log.jsonl");
  const deadline = Date.now() + 30_000;
  while (!deniedIn(log).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  writeFileSync(join(dir, "release"), "");
  await Promise.all(runs);

  const denied = deniedIn(log);
  assert.deepEqual(denied.map((e) => [e.role, e.target]), [["ra", "b/intruso.txt"]],
    `expected one line, by ra: ${JSON.stringify(denied.map((e) => e.role))}`);
});
