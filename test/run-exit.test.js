/**
 * How `seisin run` leaves: with the child's status, all of its output, and
 * without waiting on a timer that was only ever meant as a ceiling.
 *
 * The redactor sits between the child and the terminal whenever a role has a
 * key and stdout is not a TTY, so these run through a pipe — which is how an
 * orchestrator runs them, and how every test here sees them.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boxed, CLI, srtSkip } from "./_tmp.js";

const skip = srtSkip();

let repo;
before(() => {
  repo = boxed("exit-");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "token.txt"), "a-token-long-enough-to-redact\n");
  writeFileSync(join(repo, "seisin.toml"),
    '[roles.plain]\nwrites = ["src/**"]\n\n' +
    '[roles.keyed]\nwrites = ["src/**"]\nkeys = ["TOK=file://token.txt"]\nkey_mode = "env"\n');
});

function timed(role, line) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line],
    { cwd: repo, encoding: "utf8" });
  return { ...r, ms: Date.now() - t };
}

test("a keyed run keeps the child's exit status and its output, redacted", { skip }, () => {
  const r = timed("keyed", 'echo "tok=$TOK"; echo last; exit 3');
  assert.equal(r.status, 3);
  assert.match(r.stdout, /tok=‹redacted›/);
  assert.match(r.stdout, /last/);
  assert.doesNotMatch(r.stdout, /a-token-long-enough/);
});

test("a keyed run does not wait out the exit guard", { skip }, () => {
  // Measured before the fix: 3.0 s keyed against 1.2 s plain, the difference
  // being the 2-second ceiling taken every time. Compared with a plain run on
  // the same machine rather than against a fixed number, so load moves both,
  // with a margin under the 2 s it exists to catch.
  //
  // Sequential, stopping at the first pair that clears: the guard is a floor
  // under every keyed run, so no amount of retrying lets a regression through
  // unless every plain run is also 500 ms slower than it can be. Usually one
  // pair (2 runs); up to four under load. It was five of each, every time —
  // 17 s, 44 % of the suite.
  const plain = [];
  const keyed = [];
  for (let i = 0; i < 4; i++) {
    plain.push(timed("plain", "true").ms);
    keyed.push(timed("keyed", "true").ms);
    if (Math.min(...keyed) - Math.min(...plain) < 1500) break;
  }
  assert.ok(Math.min(...keyed) - Math.min(...plain) < 1500, `keyed ${keyed} ms vs plain ${plain} ms`);
});
