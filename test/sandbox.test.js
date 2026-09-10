/**
 * The end-to-end test: a real command, in a real sandbox, on a real temp repo.
 *
 * These are slower than the unit tests and they are the only ones that can tell
 * you the thing actually holds. Everything above this file checks that keyward
 * *asks* for the right policy; this checks that the policy *lands*.
 *
 * It skips instead of failing where the runtime is missing, so a contributor on
 * an unsupported platform still gets a green suite — and a loud skip.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const haveSrt = spawnSync("command", ["-v", "srt"], { shell: true }).status === 0;
const skip = haveSrt ? false : "sandbox runtime not installed (npm i -g @anthropic-ai/sandbox-runtime)";

let repo;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "keyward-"));
  mkdirSync(join(repo, "src", "web"), { recursive: true });
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  mkdirSync(join(repo, ".secrets"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "server.ts"), "api\n");
  writeFileSync(join(repo, ".secrets", "netlify.txt"), "FAKE-NETLIFY\n");
  writeFileSync(join(repo, ".secrets", "database.txt"), "FAKE-DATABASE\n");
  writeFileSync(join(repo, "keyward.toml"),
    '[keys]\ndir = ".secrets"\n\n[network]\nallow = []\n\n' +
    '[roles.frontend]\nwrites = ["src/web/**"]\nkeys = ["netlify.txt"]\n\n' +
    '[roles.backend]\nwrites = ["src/api/**"]\nkeys = ["database.txt"]\n');
});

/** Runs a shell line through keyward and reports only whether it succeeded. */
function as(role, line) {
  const r = spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line],
    { cwd: repo, encoding: "utf8" });
  return r.status === 0;
}

test("a role reads the key it declares", { skip }, () => {
  assert.ok(as("frontend", "cat .secrets/netlify.txt"));
});

test("a role cannot read another role's key", { skip }, () => {
  assert.ok(!as("frontend", "cat .secrets/database.txt"));
});

test("each role reads its own, so the deny is not just blanket", { skip }, () => {
  // Without this, a config that denied the whole key directory to everyone
  // would pass the test above while being useless.
  assert.ok(as("backend", "cat .secrets/database.txt"));
});

test("a role writes inside its territory", { skip }, () => {
  assert.ok(as("frontend", "echo x > src/web/new.ts"));
});

test("a role cannot write outside it", { skip }, () => {
  assert.ok(!as("frontend", "echo x > src/api/new.ts"));
});

test("reading another role's code still works", { skip }, () => {
  // Territory partitions writes, not reads. An agent that cannot read the rest
  // of the repo cannot do the job.
  assert.ok(as("frontend", "cat src/api/server.ts"));
});

test("the boundary survives a grandchild process", { skip }, () => {
  // This is the line between asking and enforcing. A hook that inspects the
  // command string sees `sh`; the kernel sees the read.
  assert.ok(!as("frontend", 'sh -c "cat .secrets/database.txt"'));
});

test("an absolute path does not walk around the rule", { skip }, () => {
  assert.ok(!as("frontend", `cat ${JSON.stringify(join(repo, ".secrets", "database.txt"))}`));
});

test("check exits clean on a valid config", { skip: false }, () => {
  execFileSync(process.execPath, [CLI, "check"], { cwd: repo, encoding: "utf8" });
});

test("explain exits 1 when it denies, so it composes in a script", { skip: false }, () => {
  const r = spawnSync(process.execPath, [CLI, "explain", "frontend", "write", "src/api/server.ts"], { cwd: repo });
  assert.equal(r.status, 1);
});
