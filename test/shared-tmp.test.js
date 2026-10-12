/**
 * The runtime's shared temp directory, `/tmp/claude`, taken back.
 *
 * sandbox-runtime grants it to every sandbox it starts and hands it to the
 * child as TMPDIR. Every Claude Code session on the machine keeps temp files
 * there, so it was a place every confined role could write beside them. These
 * check that the settings deny it, that the kernel does, and that the run gets
 * a temp directory of its own that works in its place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { settingsFor, SHARED_TMP } from "../src/srt.js";
import { srtSkip } from "./_tmp.js";

// Under the home, not /tmp: with /tmp writable as scratch, a write into
// /tmp/claude would say nothing about the deny.
const made = [];
process.on("exit", () => { for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {} });
const repo = (runtime) => {
  const root = mkdtempSync(join(homedir(), ".seisin-shared-tmp-"));
  made.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "seisin.toml"), `[runtime]\n${runtime}\n\n[roles.dev]\nwrites = ["src/**"]\n`);
  return root;
};

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (cwd, script) => new Promise((ok) => {
  let out = "";
  const p = spawn(process.execPath, [CLI, "run", "dev", "--agent", "none", "--", "/bin/sh", "-c", script], { cwd });
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => ok({ out, code }));
});

test("the settings deny the runtime's shared temp directory, in every mode", () => {
  const platform = process.platform === "linux" ? "linux" : "darwin";
  for (const runtime of ["", "writes = []", 'read = "territory"\nwrites = []', 'isolate = "home"']) {
    const root = repo(runtime);
    const config = loadConfig(join(root, "seisin.toml"));
    const deny = settingsFor(config, "dev").filesystem.denyWrite;
    // On Linux a missing directory is not named (bubblewrap would make it on
    // the host); there it is either made first or there is nothing to deny.
    for (const p of SHARED_TMP[platform])
      if (platform === "darwin" || existsSync(p)) assert.ok(deny.includes(p), `${runtime || "default"}: ${p}`);
  }
});

test("a temp directory passed in is granted to the run", () => {
  const root = repo("writes = []");
  const config = loadConfig(join(root, "seisin.toml"));
  const tmp = join(root, "run-tmp");
  assert.ok(settingsFor(config, "dev", null, false, { tmp }).filesystem.allowWrite.includes(tmp));
  assert.ok(!settingsFor(config, "dev").filesystem.allowWrite.includes(tmp));
});

const skip = srtSkip();

for (const runtime of ["writes = []", 'read = "territory"\nwrites = []', 'isolate = "home"', ""]) {
  test(`against the kernel: /tmp/claude is not writable, and the run's TMPDIR is (${runtime.replace(/\n/g, ", ") || "default"})`, { skip }, async () => {
    // Made if missing, as Claude Code itself would: a deny on a directory that
    // is not there proves nothing.
    mkdirSync("/tmp/claude", { recursive: true });
    const nonce = randomBytes(6).toString("hex");
    const target = `/tmp/claude/seisin-test-${nonce}`;
    const root = repo(runtime);
    const { out, code } = await run(root,
      `(echo x > ${target}) 2>/dev/null && echo SHARED-WRITE; ` +
      `echo t > "$TMPDIR/t-${nonce}" && cat "$TMPDIR/t-${nonce}" >/dev/null && echo TMP-OK; ` +
      `[ "$TMPDIR" = "$CLAUDE_CODE_TMPDIR" ] && echo SAME-TMP; ` +
      `echo w > src/w && echo GRANT-OK`);
    try { rmSync(target, { force: true }); } catch {}
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /SHARED-WRITE/, "the runtime's shared temp directory");
    assert.match(out, /TMP-OK/, "positive control: the run's own TMPDIR reads and writes");
    assert.match(out, /SAME-TMP/, "the agent and the runtime agree on one temp directory");
    assert.match(out, /GRANT-OK/, "positive control: the territory writes");
  });
}

test("against the kernel: one run cannot see or read the temp directory another run was given", { skip }, async () => {
  // Planted the way another run's would be. Listing the parent is not the
  // measure: bubblewrap answers a denied directory with an empty one, Seatbelt
  // with EPERM. Seeing the other run's name or reading its file is.
  const tmps = join(realpathSync(tmpdir()), "snt");
  mkdirSync(tmps, { recursive: true, mode: 0o700 });
  const other = mkdtempSync(join(tmps, "other-"));
  made.push(other);
  writeFileSync(join(other, "left"), "OTHER-RUN-TMP\n");
  const root = repo("writes = []");
  const { out } = await run(root,
    `ls "$(dirname "$TMPDIR")" 2>/dev/null; cat '${join(other, "left")}' 2>/dev/null; echo done`);
  assert.match(out, /done/);
  assert.doesNotMatch(out, /other-/, "another run's temp directory is not listed");
  assert.doesNotMatch(out, /OTHER-RUN-TMP/, "nor read");
});
