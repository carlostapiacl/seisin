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
import { boxed } from "./_tmp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const BOX = join(HERE, ".sandbox-box");

const skip = resolveSrt() === null ? "sandbox runtime not installed"
  : process.platform !== "darwin" ? "kernel denials are read on macOS only" : false;

test("a denial is logged once, against the run that caused it", { skip }, async () => {
  mkdirSync(BOX, { recursive: true });
  const dir = boxed("parallel-");
  for (const d of ["a", "b", "c"]) mkdirSync(join(dir, d));
  writeFileSync(join(dir, "seisin.toml"),
    '[roles.ra]\nwrites = ["a/**"]\n\n[roles.rb]\nwrites = ["b/**"]\n\n[roles.rc]\nwrites = ["c/**"]\n');
  // The same argv for all three; only ra writes, into rb's territory.
  const cmd = 'if [ "$SEISIN_ROLE" = ra ]; then sleep 0.5; echo x > b/intruso.txt; fi; sleep 2';
  await Promise.all(["ra", "rb", "rc"].map((role) => new Promise((ok) =>
    spawn(process.execPath, [CLI, "run", role, "--", "sh", "-c", cmd], { cwd: dir, stdio: "ignore" }).on("close", ok))));

  const log = join(dir, ".seisin", "log.jsonl");
  const denied = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.verdict === "denied")
    : [];
  assert.deepEqual(denied.map((e) => [e.role, e.target]), [["ra", "b/intruso.txt"]],
    `expected one line, by ra: ${JSON.stringify(denied.map((e) => e.role))}`);
});
