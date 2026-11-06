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
import { boxed, CLI, sandboxSkip } from "./_tmp.js";
import { cpSync } from "node:fs";
import { scratch } from "./_tmp.js";

const skip = sandboxSkip();

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

test("the launcher drains redacted pipes after the runtime exits", () => {
  // A fake runtime isolates process/stdio ordering. This is not a test of
  // confinement; the real runtime's output/status tests remain in run-exit.
  const root = scratch("seisin-output-audit-");
  cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module","version":"0.0.0"}\n');
  writeFileSync(join(root, "seisin.toml"), '[sandbox]\nprovider = ["srt"]\n\n[roles.dev]\nwrites = []\nkeys = ["TOKEN=file://token.txt"]\nkey_mode = "env"\n');
  const secret = "synthetic-output-credential";
  writeFileSync(join(root, "token.txt"), secret + "\n");
  const runtime = join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "package.json"), '{"bin":{"srt":"cli.cjs"}}\n');
  const late = "require('node:fs').writeSync(3, 'up'); setTimeout(() => { process.stdout.write('tail=' + process.env.TOKEN + '\\n'); process.stderr.write('last stderr\\n'); }, 120)";
  // Every run starts with a canary, and a runtime that confines nothing fails
  // it (exit 86) — as it should. This one answers the canary the way a working
  // sandbox would, so the run reaches the stdio ordering under test.
  const script = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const sh = argv.indexOf('/bin/sh');
if (sh !== -1 && /ALIVE-/.test(argv[sh + 2] || '')) {
  const s = argv[sh + 2];
  const nonce = /ALIVE-([0-9a-f]+)/.exec(s)[1];
  const inside = /\\(echo IN-[0-9a-f]+ > '([^']*)'\\)/.exec(s);
  if (inside) require('node:fs').writeFileSync(inside[1], 'IN-' + nonce + '\\n');
  process.stdout.write('ALIVE-' + nonce + '\\n' + (/PROBED-/.test(s) ? 'PROBED-' + nonce : ''));
  process.exit(0);
}
const late = ${JSON.stringify(late)};
// The late writer says it has started before the runtime exits, so the
// launcher's 2-second guard measures only its 120 ms and not how long a
// loaded machine takes to start node.
const w = spawn(process.execPath, ['-e', late], { stdio: ['ignore', 1, 2, 'pipe'] });
w.stdio[3].once('data', () => {
  process.stdout.write('begin\\n');
  setTimeout(() => process.exit(3), 20);
});
`;
  writeFileSync(join(runtime, "cli.cjs"), script, { mode: 0o755 });
  const r = spawnSync(process.execPath, [join(root, "src", "cli.js"), "run", "dev", "--", process.execPath, "-e", ""],
    // Only a bound on a hang. At 4 s a loaded machine hit it before seisin
    // finished, and seisin passes the SIGTERM on and exits 143.
    { cwd: root, encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /tail=‹redacted›\n/);
  assert.match(r.stderr, /last stderr\n/);
  assert.doesNotMatch(r.stdout, new RegExp(secret));
});
