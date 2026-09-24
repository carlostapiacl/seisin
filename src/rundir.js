/**
 * One private directory per run, for everything that belongs to that run only:
 * the audit socket, the sandbox settings, and `scratch` keys.
 *
 * ── Why ──
 * These lived in two places and both leaked. The settings were written to
 * `.seisin/<role>.json`, one file per ROLE, so two runs of the same role — an
 * orchestrator does that all day — wrote the same file with different socket
 * paths, and one could start with the other's. The socket and the scratch keys
 * lived in `$TMPDIR/seisin-XXXX/`, private by mode, but every role runs as the
 * same user and every role can read the temp dir: measured on 2026-09-23, one
 * role read another's `scratch` key while it ran (`cat …/keys/S` → the value).
 *
 * ── How ──
 * All runs live under one root, `$TMPDIR/snr/`, and each role's profile denies
 * reading that root and allows reading its own run's directory — the shape the
 * key directories and the isolated homes already use. The root is denied for
 * writing too, so no role can swap it for a symlink between runs.
 *
 * Short names on purpose: the socket path is capped near 104 bytes on macOS.
 */
import { mkdirSync, mkdtempSync, lstatSync, chmodSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { realOrSelf } from "./grants.js";
import { channelName } from "./spool.js";

export const RUNS_NAME = "snr";

/**
 * The root every run lives under, created private, and checked.
 *
 * Real path, because the kernel enforces on real paths and on macOS the temp
 * dir sits behind /var → /private/var. Refused rather than used when it is not
 * a directory of this user's with nobody else's bits on it: it holds keys.
 */
export function runsRoot(base = tmpdir()) {
  const root = join(realOrSelf(base), RUNS_NAME);
  try { mkdirSync(root, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = lstatSync(root);
  const mine = typeof process.getuid !== "function" || st.uid === process.getuid();
  if (st.isSymbolicLink() || !st.isDirectory() || !mine)
    throw new Error(
      `${root} is not a directory of yours (${st.isSymbolicLink() ? "it is a symlink" : "wrong owner or type"}).\n` +
      `  It holds each run's socket and keys, so seisin will not use it. Remove it and run again.`);
  if (st.mode & 0o077) chmodSync(root, 0o700);
  return root;
}

/** Is the process that owns a run directory still alive? */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * Removes the directories of runs whose process is gone.
 *
 * A run cleans up after itself on exit. A run that is killed does not, and
 * its directory keeps its `scratch` keys on disk indefinitely — measured by
 * SIGKILL on a keyed run. Swept at the start of the next one; a directory
 * without a pid file is younger than the write that creates it, and is left.
 */
function sweep(root) {
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let pid;
    try { pid = Number(readFileSync(join(dir, "pid"), "utf8")); } catch { continue; }
    if (pid && !alive(pid)) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Opens a run: its id, its directory, and the paths inside it.
 *
 * The id is the one the rest of the run uses — the nonce in the kernel's
 * command tag, the `run` field on every log line — so one value ties the
 * socket, the settings, the log and the kernel's reports together.
 */
export function openRun({ base = tmpdir(), id = randomUUID() } = {}) {
  const root = runsRoot(base);
  try { sweep(root); } catch { /* a sweep that fails is not a reason not to run */ }
  const dir = mkdtempSync(join(root, `${id.slice(0, 6)}-`));
  writeFileSync(join(dir, "pid"), String(process.pid), { mode: 0o600 });
  return {
    id,
    dir,
    root,
    // A socket on macOS, a FIFO on Linux, where the runtime blocks every unix
    // socket inside the box (spool.js).
    sock: join(dir, channelName()),
    keys: join(dir, "keys"),
    /**
     * `wx`: created by this call or not at all. A settings file that already
     * exists is not this run's, and the runtime would read whatever it says.
     */
    writeSettings(settings) {
      const file = join(dir, "settings.json");
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      return file;
    },
    close() {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** The runs root a socket path belongs to, or null when it is not one of ours. */
export function runsRootOf(sock) {
  if (!sock) return null;
  const root = dirname(dirname(sock));
  return basename(root) === RUNS_NAME ? root : null;
}
