/**
 * What a command writes reaches a pipe whole, however slowly it is read.
 *
 * Through a pipe, a write takes what the kernel's buffer holds and queues the
 * rest, so an exit that does not wait for the queue loses the tail, with status
 * 0 and nothing on stderr. These go through a shell because it has to be a real
 * pipe: what `spawn` gives a child is a socket pair, with a different buffer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxed, CLI, sandboxSkip } from "./_tmp.js";

const skip = sandboxSkip();
const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `seisin <args> | <reader>`, with seisin's own status, stderr and the bytes read. */
function piped(args, reader, cwd) {
  const dir = boxed("pipe-exit-out-");
  const [got, status, stderr] = ["got", "status", "stderr"].map((f) => join(dir, f));
  writeFileSync(got, "");
  const seisin = [process.execPath, CLI, ...args].map(q).join(" ");
  const r = spawnSync("sh", ["-c", `{ ${seisin} 2>${q(stderr)}; echo $? >${q(status)}; } | ${reader(q(got))}`],
    { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return {
    status: Number(readFileSync(status, "utf8")),
    stderr: readFileSync(stderr, "utf8"),
    stdout: readFileSync(got, "utf8"),
  };
}

/** Enough runs that the JSON is well past anything a kernel's pipe buffer holds. */
function manyRuns() {
  const dir = boxed("pipe-exit-");
  for (let i = 0; i < 600; i++) {
    const root = join(dir, `run-${i}`, ".seisin");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(dir, `run-${i}`, "seisin.toml"), '[roles.agent]\nwrites = ["src/**"]\n');
    writeFileSync(join(root, "log.jsonl"), JSON.stringify({ at: "2026-11-06T00:00:00.000Z", kind: "run", role: "agent", run: `run-${i}` }) + "\n");
  }
  return dir;
}

test("review --runs --json reaches a pipe whole", () => {
  const r = piped(["review", "--runs", manyRuns(), "--json"], (got) => `cat >${got}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 256 * 1024, `only ${r.stdout.length} bytes: too small to show the cut`);
  assert.equal(JSON.parse(r.stdout).runs.length, 600);
});

test("a reader that goes away costs neither the status nor a stack trace", () => {
  const r = piped(["review", "--runs", manyRuns(), "--json"], () => "head -c 10 >/dev/null");
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

test("a keyed run's output reaches a reader that is past the exit guard", { skip }, () => {
  const repo = boxed("pipe-exit-run-");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "token.txt"), "a-token-long-enough-to-redact\n");
  writeFileSync(join(repo, "seisin.toml"),
    '[roles.keyed]\nwrites = ["src/**"]\nkeys = ["TOK=file://token.txt"]\nkey_mode = "env"\n');
  // Above what the kernel holds, below what would stall the child until the
  // reader wakes: that stall is what hid this with a larger output.
  const size = 100_000;
  const r = piped(["run", "keyed", "--", process.execPath, "-e", `process.stdout.write("x".repeat(${size}))`],
    (got) => `{ sleep 6; cat >${got}; }`, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.length, size);
});
