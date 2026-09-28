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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
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
      // Rotate first, under the same lock: a full segment is renamed away and a
      // fresh one seeded so the chain continues, then this line lands in the new
      // segment. Done here so the size check and the append never race.
      maybeRotate(file);
      // `prev` goes last and is computed from the previous line exactly as it
      // sits on disk, so verifying needs nothing but the file.
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry, prev: hashOf(lastLine(file)) });
      appendFileSync(file, line + "\n");
    }, { waitMs: envInt("SEISIN_LOG_LOCK_WAIT_MS", 6000) });
    return true;
  } catch (e) {
    // A line that could not get the lock is gone, and a missing line does not
    // break the chain. Say so beside the log, so `verify` can.
    if (e?.code === "ELOCKED") {
      try { appendFileSync(droppedPath(file), JSON.stringify({ at: new Date().toISOString(), role: entry?.role, event: entry?.event }) + "\n"); } catch {}
    }
    return false;
  }
}

/** Where entries that could not be written are counted. */
export function droppedPath(file) {
  return file + ".dropped";
}

function countLines(file) {
  try { return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length; } catch { return 0; }
}

/**
 * When the current segment fills, retire it and start a fresh one that still
 * chains.
 *
 * An append-only file that only grows is the right default and the wrong
 * forever: a busy team writes megabytes of it, and `verify` walks all of them
 * on every run. Rotation caps the size of the file three tools tail while
 * keeping the property that made the chain worth having — that a deletion shows.
 *
 * The retired segment keeps its own chain intact; the new segment's first line
 * is a `rotated` marker whose `prev` is the retired segment's last hash, so the
 * two verify as one chain across the cut (`verifyLog`). The comment on GENESIS
 * asked for exactly this. Segments are numbered upward, `.1` the oldest, and
 * the oldest beyond the keep count are dropped — the only place seisin removes
 * a record, and it removes whole retired segments, never a line.
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;   // 8 MiB per segment
const DEFAULT_KEEP = 5;                        // retired segments kept beside the current one

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Every segment of the log, oldest → newest, current last. */
export function logSegments(file) {
  const dir = dirname(file);
  const base = basename(file);
  let names = [];
  try { names = readdirSync(dir); } catch { return existsSync(file) ? [file] : []; }
  const archives = names
    .map((n) => {
      if (!n.startsWith(base + ".")) return null;
      const seq = Number(n.slice(base.length + 1));
      return Number.isInteger(seq) && seq > 0 ? { seq, path: join(dir, n) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.seq - b.seq)
    .map((a) => a.path);
  if (existsSync(file)) archives.push(file);
  return archives;
}

function maybeRotate(file) {
  let sz = 0;
  try { sz = statSync(file).size; } catch { return; }
  if (sz < envInt("SEISIN_LOG_MAX_BYTES", DEFAULT_MAX_BYTES)) return;

  const tail = hashOf(lastLine(file));
  const archives = logSegments(file).filter((p) => p !== file);
  const seqs = archives.map((p) => Number(p.slice((file + ".").length))).filter(Number.isInteger);
  const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
  renameSync(file, `${file}.${next}`);
  // Seed the new current so the first real append chains from the retired tail.
  const marker = JSON.stringify({ at: new Date().toISOString(), event: "rotated", from: `${basename(file)}.${next}`, prev: tail });
  appendFileSync(file, marker + "\n");

  const keep = envInt("SEISIN_LOG_KEEP", DEFAULT_KEEP);
  const retired = logSegments(file).filter((p) => p !== file); // oldest → newest, includes the new archive
  for (let i = 0; i < retired.length - keep; i++) { try { unlinkSync(retired[i]); } catch {} }
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
 *
 * The lock names its holder (pid and a nonce). A lock whose holder is gone is
 * taken over at once; one whose holder cannot be read is taken over once it is
 * older than `staleMs`. The wait outlasts that age on purpose: a writer that
 * died holding the lock can never make the next one give up, so the only entry
 * ever dropped is one that waited on a writer still alive — and that drop is
 * counted beside the log (see `append`), because a missing line does not break
 * the chain and would otherwise not show.
 */
export function withLock(file, fn, { waitMs = 6000, staleMs = 5000 } = {}) {
  const lock = file + ".lock";
  const deadline = Date.now() + waitMs;
  const mine = `${process.pid} ${createHash("sha256").update(String(Math.random()) + Date.now()).digest("hex").slice(0, 12)}\n`;
  let acquired = false;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, mine); } finally { closeSync(fd); }
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (reapable(lock, staleMs)) continue;
      // Never write without the lock. Doing so forks the hash chain; deleting
      // the lock in `finally` then admits still more writers while its owner is
      // active. The log is bookkeeping and append() may fail without taking the
      // agent down, so dropping this entry is safer than fabricating evidence.
      if (Date.now() > deadline) {
        const error = new Error(`could not acquire log lock within ${waitMs} ms`);
        error.code = "ELOCKED";
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); }
  finally {
    // Remove it only while it is still ours: if it was taken over, it now
    // belongs to someone else.
    if (acquired) try { if (readFileSync(lock, "utf8") === mine) unlinkSync(lock); } catch {}
  }
}

/** True if the process is still there. EPERM means it is, and not ours to signal. */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; }
}

/**
 * Removes a lock whose holder is gone, and says whether it did.
 *
 * The content is read again just before removing it, so a waiter that decided
 * on one lock does not remove a newer one another waiter has just taken.
 */
function reapable(lock, staleMs) {
  let seen, mtime;
  try { seen = readFileSync(lock, "utf8"); mtime = statSync(lock).mtimeMs; } catch { return true; }
  const pid = Number(seen.split(" ")[0]);
  const named = Number.isInteger(pid) && pid > 0;
  // A named holder that is alive is waited on, however long it takes: its age
  // says nothing about whether it is done. An unnamed one (an older seisin, or
  // killed between creating the file and writing its name) goes by age.
  const gone = named ? !alive(pid) : Date.now() - mtime > staleMs;
  if (!gone) return false;
  try { if (readFileSync(lock, "utf8") !== seen) return true; unlinkSync(lock); } catch {}
  return true;
}

/**
 * Walk the file and say where the chain breaks.
 *
 * Lines written before the chain existed have no `prev`; they are counted as an
 * unchained prefix, not reported as tampering. After the first chained line,
 * a line without `prev` is itself a break.
 */
function walk(file, { seed = GENESIS, startLine = 0 } = {}) {
  const out = { lines: 0, unchained: 0, chained: 0, breaks: [], tail: null };
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
    const first = out.chained === 0 && out.unchained === 0;
    // A rotation marker leading a segment we have nothing to check it against —
    // a file verified on its own, or the oldest segment left after the prefix
    // was pruned for retention (seed still GENESIS) — is accepted rather than
    // called a break. For any later segment the seed is the real previous tail,
    // so the marker's `prev` IS checked, and a whole segment deleted or
    // reordered in the middle shows.
    const rotationStart = first && e?.event === "rotated" && seed === GENESIS;
    const expected = first ? seed : hashOf(previous);
    const ok = rotationStart || prev === expected || (first && prev === hashOf(previous));
    if (!ok) out.breaks.push({ line: startLine + out.lines, expected, found: prev ?? null });
    out.chained++;
    previous = line;
  }
  out.tail = previous;
  return out;
}

export function verifyChain(file, seed = GENESIS) {
  const r = walk(file, { seed });
  return { lines: r.lines, unchained: r.unchained, chained: r.chained, breaks: r.breaks };
}

/**
 * Verify the whole log, across every rotated segment, as one chain.
 *
 * Each retired segment is walked in order, and its last hash becomes the seed
 * the next segment's `rotated` marker must match — so deleting or reordering a
 * whole segment shows, not only an edit inside one. With no rotation there is a
 * single segment and this is exactly `verifyChain`. What it cannot see is a
 * segment dropped off the *oldest* end by the keep limit: that is retention, not
 * tampering, and the count of segments is reported so the drop is not silent.
 */
export function verifyLog(file) {
  const segs = logSegments(file);
  const agg = { lines: 0, unchained: 0, chained: 0, breaks: [], segments: segs.length, dropped: countLines(droppedPath(file)) };
  let seed = GENESIS;
  for (const seg of segs) {
    const r = walk(seg, { seed, startLine: agg.lines });
    agg.lines += r.lines;
    agg.unchained += r.unchained;
    agg.chained += r.chained;
    agg.breaks.push(...r.breaks);
    seed = hashOf(r.tail);
  }
  return agg;
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
    if (e.event === "rotated") continue; // a structural marker, not a decision
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
