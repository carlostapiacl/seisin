/**
 * Temporary directories for tests, removed when the test file's process ends.
 *
 * Every test made its own with mkdtempSync and most never removed it — or
 * removed it only on the passing path. Measured: one run of the suite left 28
 * directories in the temp dir, and test/.sandbox-box had grown to 5,084. One
 * place that remembers what it made, and one exit handler; `node --test`
 * runs each file in its own process, so each file cleans up after itself.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { BUILTIN_SANDBOXES, DEFAULT_SANDBOX } from "../src/sandboxes/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The CLI entry point, run with `process.execPath` by the end-to-end tests. */
export const CLI = join(HERE, "..", "src", "cli.js");

/**
 * The skip reason for a test that needs the real sandbox (the default,
 * tartaros), or false.
 *
 * Decided the way `seisin run` decides it (the sandbox's own locate), never
 * with `command -v`: a checkout whose bundled runtime was right there once
 * skipped fourteen tests and reported green.
 */
export function sandboxSkip() {
  return BUILTIN_SANDBOXES[DEFAULT_SANDBOX].locate() ? false : `${DEFAULT_SANDBOX} not installed`;
}

/** The same, for a test about sandbox-runtime itself (a devDependency since 0.7). */
export function srtOnlySkip() {
  return BUILTIN_SANDBOXES.srt.locate() ? false : "sandbox-runtime (srt) not installed";
}

const made = [];
process.on("exit", () => {
  for (const d of made) try { rmSync(d, { recursive: true, force: true }); } catch {}
});

/** A directory under the system temp dir. */
export function scratch(prefix = "seisin-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

/**
 * A directory under test/.sandbox-box — for repos the sandbox tests run in.
 * NOT under the temp dir: every role writes it, so a repo there would be
 * writable by all of them and every "cannot" would pass by accident.
 */
export function boxed(prefix) {
  const box = join(HERE, ".sandbox-box");
  mkdirSync(box, { recursive: true });
  const d = mkdtempSync(join(box, prefix));
  made.push(d);
  return d;
}

/**
 * A boxed repo with `toml` as its seisin.toml, and each path in `touch`
 * created: a trailing `/` makes a directory, anything else an empty file.
 */
export function repoWith(prefix, toml, touch = []) {
  const dir = boxed(prefix);
  writeFileSync(join(dir, "seisin.toml"), toml);
  for (const f of touch) {
    if (f.endsWith("/")) { mkdirSync(join(dir, f), { recursive: true }); continue; }
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "");
  }
  return dir;
}

/** One turn of the event loop, for what a stream or a socket hands over on the next one. */
export const delivered = () => new Promise((r) => setImmediate(r));

/** A policy written to a file of its own and loaded the way a run loads it. */
export function policyFrom(toml) {
  const dir = scratch("seisin-policy-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return loadConfig(join(dir, "seisin.toml"));
}

/** The CLI in `cwd`, without color. */
export const seisinIn = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

/** Settings with a filesystem section and nothing in it. */
export const noFilesystem = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };

/** Two roles and a key directory, as a plain object: nothing here reads a file. */
export const twoRoles = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};
