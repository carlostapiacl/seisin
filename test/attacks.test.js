/**
 * Attacks, run against the real kernel. Each one worked on 2026-09-23 before
 * the change that closes it, and each test says what it measured then.
 *
 * The rest of the suite checks that a role cannot write outside its territory.
 * These check the other half: that nothing a role CAN write decides what runs,
 * or what is handed over, outside the box — the machinery around the sandbox,
 * which an external review named and these measurements confirmed.
 *
 * The ids are the ones in seisin-privado's analysis of that review.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveSrt } from "../src/commands/run.js";
import { resolveRef } from "../src/keys.js";
import { boxed } from "./_tmp.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const macOnly = process.platform === "darwin" ? false : "glob and rename semantics measured on macOS";
const skip = resolveSrt() ? false : "sandbox runtime not installed";

let repo, trusted, outside;
before(() => {
  // Not under the temp dir: every role writes it, so a repo there would be
  // writable by all of them and every "cannot" below would pass by accident.
  const box = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
  mkdirSync(box, { recursive: true });
  const root = boxed("attack-");
  repo = join(root, "repo");
  trusted = join(root, "trusted");
  outside = join(root, "outside");
  for (const d of [repo, trusted, outside, join(repo, "bin"), join(repo, "src"), join(repo, "config"), join(repo, ".secrets")])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(trusted, "fakeprov"), "#!/bin/sh\necho real-value\n", { mode: 0o755 });
  writeFileSync(join(repo, ".secrets", "database.txt"), "SECRET-OF-BACKEND\n");
  writeFileSync(join(repo, "config", "token.txt"), "file-token\n");
  writeFileSync(join(repo, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n' +
    '[keys.providers.fake]\ncommand = ["fakeprov", "{ref}"]\n\n' +
    '[roles.dev]\nwrites = ["**"]\nkeys = ["TOK=fake://x", "FT=file://config/token.txt"]\nkey_mode = "env"\n\n' +
    '[roles.narrow]\nwrites = ["src/**"]\n\n' +
    '[roles.backend]\nwrites = ["other/**"]\nkeys = ["database.txt"]\n');
  execFileSync("git", ["init", "-q", join(repo, "src", "nested")]);
  mkdirSync(join(repo, "src", "nested", ".claude"), { recursive: true });
  writeFileSync(join(repo, "src", "nested", ".claude", "settings.json"), "{}\n");
});

/** The PATH of an ordinary machine with a bin/ of the repo in front of it. */
const env = () => ({ ...process.env, PATH: `${join(repo, "bin")}:${trusted}:${process.env.PATH}` });

function as(role, line) {
  return spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line],
    { cwd: repo, encoding: "utf8", env: env() });
}

test("ATTACK-001 a role cannot plant a provider on PATH", { skip }, () => {
  // Before: dev wrote bin/fakeprov, and the next run executed it outside the
  // box — the marker appeared in a directory no role could write.
  const marker = join(outside, "provider-ran");
  const r = as("dev", `printf '#!/bin/sh\\ntouch ${marker}\\necho hijacked\\n' > bin/fakeprov && chmod +x bin/fakeprov`);
  assert.notEqual(r.status, 0, "writing into a PATH directory must be refused");
  assert.ok(!existsSync(join(repo, "bin", "fakeprov")));
});

test("ATTACK-001b a planted provider left from before is never executed", { skip }, () => {
  // The same attack with the file already there — put by a run from before the
  // fix, or by hand. The lookup skips directories a role can write.
  const marker = join(outside, "provider-ran-2");
  writeFileSync(join(repo, "bin", "fakeprov"), `#!/bin/sh\ntouch ${marker}\necho hijacked\n`, { mode: 0o755 });
  try {
    const r = as("dev", 'test "$TOK" = real-value');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(marker), "the planted provider ran outside the box");
  } finally {
    rmSync(join(repo, "bin", "fakeprov"), { force: true });
  }
});

test("ATTACK-002 a file:// target cannot be swapped for another role's key", { skip }, () => {
  // Before: rm + ln -s ../.secrets/database.txt, and the next run handed dev
  // the backend key it cannot read (its own cat of it was refused).
  assert.notEqual(as("dev", "cat .secrets/database.txt").status, 0);
  const r = as("dev", "rm config/token.txt && ln -s ../.secrets/database.txt config/token.txt");
  assert.notEqual(r.status, 0);
  assert.ok(!lstatSync(join(repo, "config", "token.txt")).isSymbolicLink());
  assert.equal(as("dev", 'test "$FT" = file-token').status, 0);
});

test("ATTACK-003 a role cannot reach a nested repo's git metadata, by write or by move", { skip: skip || macOnly }, () => {
  // A nested repository inside a role's territory: seisin denies both writing
  // its hooks and moving its `.git` out of place, so a role cannot leave
  // anything behind that git would run.
  assert.notEqual(as("narrow", "echo x > src/nested/.git/hooks/pre-commit").status, 0);
  assert.notEqual(as("narrow", "mv src/nested/.git src/nested/g").status, 0);
  assert.ok(existsSync(join(repo, "src", "nested", ".git", "HEAD")));
});

test("ATTACK-004 a role cannot reach a project's .claude, by write or by move", { skip: skip || macOnly }, () => {
  // Same for the directory Claude Code reads its own instructions from.
  assert.notEqual(as("narrow", 'echo "{}" > src/nested/.claude/settings.json').status, 0);
  assert.notEqual(as("narrow", "mv src/nested/.claude src/nested/x").status, 0);
  assert.equal(readFileSync(join(repo, "src", "nested", ".claude", "settings.json"), "utf8"), "{}\n");
});

test("ATTACK-005 the home's Claude settings cannot be opened for writing", { skip: skip || (existsSync(join(homedir(), ".claude", "settings.json")) ? false : "no ~/.claude/settings.json here") }, () => {
  // Before: every role opened it for append through the shared ~/.claude
  // scratch. Opened and closed without a byte written, so nothing changes
  // even if this ever regresses.
  const r = as("narrow", '(exec 3>>"$HOME/.claude/settings.json")');
  assert.notEqual(r.status, 0);
});

test("ATTACK-006 a failing provider's stderr does not carry the secret out", () => {
  // A provider that prints the value and then fails used to have it echoed
  // back through the error meant to explain the failure.
  const run = () => ({ status: 1, stdout: "sk_live_abcdef123456\n", stderr: "could not finish: sk_live_abcdef123456\n" });
  const entry = { raw: "T=p://x", scheme: "p", ref: "x", name: "T", kind: "ref" };
  assert.throws(() => resolveRef(entry, { command: ["p", "{ref}"] }, { run }),
    (e) => !e.message.includes("sk_live_abcdef123456") && /‹redacted›/.test(e.message));
});

test("ATTACK-007 a provider that never answers stops the run with a reason", () => {
  const run = () => ({ error: Object.assign(new Error("spawnSync p ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  const entry = { raw: "T=p://x", scheme: "p", ref: "x", name: "T", kind: "ref" };
  assert.throws(() => resolveRef(entry, { command: ["p", "{ref}"] }, { run }), /did not answer in 60 s/);
});

test("ATTACK-008 writing the policy under another spelling is still refused", { skip: skip || macOnly }, () => {
  // APFS is case-insensitive: SEISIN.TOML is seisin.toml. Held before the
  // changes here too; kept so it keeps holding.
  assert.notEqual(as("dev", "echo x >> SEISIN.TOML").status, 0);
  assert.doesNotMatch(readFileSync(join(repo, "seisin.toml"), "utf8"), /^x$/m);
});
