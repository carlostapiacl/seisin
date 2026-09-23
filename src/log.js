/**
 * One append-only JSONL file, and that is the whole storage design.
 *
 * `seisin log`, `seisin watch` and the console all read this file. There is no
 * daemon and no database, because the moment there is one, seisin stops being a
 * launcher you can reason about and becomes a service you have to operate. A
 * file that only grows is the version of "live" that survives a crash, a reboot
 * and being read by three things at once.
 *
 * Append-only also means the log is evidence. Nothing here rewrites a line, so
 * what an agent tried last night reads the same today — and since the change in
 * spool.js, nothing inside the sandbox can rewrite one either. append() below
 * tries the parent's socket first for exactly that reason; writing the file
 * directly is what happens when there is no parent, outside the box.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_DIR, LOG_NAME } from "./layout.js";
import { send } from "./spool.js";

export { STATE_DIR, LOG_NAME } from "./layout.js";

export function logPath(root) {
  return join(root, STATE_DIR, LOG_NAME);
}

/**
 * Appends one decision.
 *
 * Failing to write must never take the agent down with it: a permission tool
 * that breaks the build because its disk is full has done more damage than the
 * thing it was watching for. Errors are swallowed on purpose, and the caller
 * gets `false` if it cares.
 */
export function append(file, entry) {
  // Confined: the parent owns the file, we only get to send a line. See spool.js.
  if (send("log", entry)) return true;
  try {
    mkdirSync(dirname(file), { recursive: true });
    withLock(file, () => {
      // `prev` goes last and is computed from the previous line exactly as it
      // sits on disk, so verifying needs nothing but the file.
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry, prev: hashOf(lastLine(file)) });
      appendFileSync(file, line + "\n");
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The log is chained: every line carries `prev`, the hash of the line before it.
 *
 * The log is the record of who touched what and who was refused what, and it
 * could be edited without a trace. A chain does not stop anyone with write
 * access from rewriting it — nothing inside a file can — but it makes an edit,
 * a deletion or a reordering show, and `seisin log verify` says where. Taken
 * from nono's audit trail; the Merkle root and the signature it adds on top
 * are left for when someone asks for them.
 *
 * The first chained line of a file points at GENESIS. A file started by
 * rotation should point at the last line of the one before it; there is no
 * rotation yet, and when there is, that is what it has to do.
 */
export const GENESIS = "0".repeat(32);

export function hashOf(line) {
  return line == null ? GENESIS : createHash("sha256").update(line).digest("hex").slice(0, 32);
}

/** The last complete line of the file, or null when there is none. */
function lastLine(file) {
  if (!existsSync(file)) return null;
  const { size } = statSync(file);
  if (size === 0) return null;
  const from = Math.max(0, size - 64 * 1024);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    return lines.length ? lines[lines.length - 1] : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * One writer at a time. Several roles of a round run at once and write this
 * same file; two of them reading the same last line would fork the chain.
 * A lock left by a killed process is taken over after a few seconds.
 */
function withLock(file, fn) {
  const lock = file + ".lock";
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) break;          // never block the run over bookkeeping
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

/**
 * Walk the file and say where the chain breaks.
 *
 * Lines written before the chain existed have no `prev`; they are counted as an
 * unchained prefix, not reported as tampering. After the first chained line,
 * a line without `prev` is itself a break.
 */
export function verifyChain(file) {
  const out = { lines: 0, unchained: 0, chained: 0, breaks: [] };
  if (!existsSync(file)) return out;
  let previous = null;
  let started = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    out.lines++;
    let e = null;
    try { e = JSON.parse(line); } catch {}
    const prev = e?.prev;
    if (!started && prev === undefined) { out.unchained++; previous = line; continue; }
    started = true;
    const expected = out.chained === 0 && out.unchained === 0 ? GENESIS : hashOf(previous);
    const ok = prev === expected || (out.chained === 0 && prev === hashOf(previous));
    if (!ok) out.breaks.push({ line: out.lines, expected, found: prev ?? null });
    out.chained++;
    previous = line;
  }
  return out;
}

/** Reads entries, newest last. A malformed line is skipped, never fatal. */
export function read(file, { role, verdict, since, limit = 0 } = {}) {
  if (!existsSync(file)) return [];
  let out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a half-written line from a killed process is not an error
    }
    if (role && e.role !== role) continue;
    if (verdict && e.verdict !== verdict) continue;
    if (since && e.at < since) continue;
    out.push(e);
  }
  if (limit > 0 && out.length > limit) out = out.slice(-limit);
  return out;
}

/** Byte offset of the end of the file, for `watch` to start from. */
export function size(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * What each role actually reached for, from the log.
 *
 * This is the reason the log exists. A policy written by hand on day one is a
 * guess, and the first unjustified `denied` is when a tool gets uninstalled.
 * Observed first, written second.
 */
export function observed(entries) {
  const roles = new Map();
  for (const e of entries) {
    if (!e.role || !e.target) continue;
    const r = roles.get(e.role) ?? { writes: new Set(), keys: new Set() };
    if (e.action === "read" && e.kind === "key") r.keys.add(e.target);
    else if (e.action === "write") r.writes.add(e.target);
    roles.set(e.role, r);
  }
  return roles;
}

/**
 * Collapses observed file paths into directory globs.
 *
 * A policy listing 400 individual files is not a policy, it is a transcript.
 * The common parent of everything a role wrote is the honest generalisation,
 * and it is deliberately shallow: one level below the shared root, so that a
 * role that touched `src/api/a` and `src/api/b` gets `src/api/**` rather than
 * `src/**`, which would hand it the whole tree on the strength of two files.
 */
export function generalise(paths) {
  const dirs = new Set();
  const files = new Set();          // things at the repo root have no directory

  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    parts.pop();                    // drop the file itself
    // A path with nothing above it is a file at the root. It used to be added
    // to `dirs` and then given a `/**` like everything else, so observing a
    // write to NOTAS.md proposed `NOTAS.md/**` — the children of a directory
    // that does not exist, which grants nothing over the file that was written.
    if (parts.length === 0) files.add(p);
    else dirs.add(parts.join("/"));
  }

  const kept = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && d.startsWith(o + "/")));
  // A root file already covered by a directory grant does not need naming.
  const loose = [...files].filter((f) => ![...kept].some((d) => f.startsWith(d + "/")));
  return [...kept.map((d) => d + "/**"), ...loose].sort();
}
