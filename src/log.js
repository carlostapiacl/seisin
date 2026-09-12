/**
 * One append-only JSONL file, and that is the whole storage design.
 *
 * `seisin log`, `seisin watch` and the console all read this file. There is no
 * daemon, no socket and no database, because the moment there is one, seisin
 * stops being a launcher you can reason about and becomes a service you have to
 * operate. A file that only grows is the version of "live" that survives a
 * crash, a reboot and being read by three things at once.
 *
 * Append-only also means the log is evidence. Nothing here rewrites a line, so
 * what an agent tried last night reads the same today.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    return true;
  } catch {
    return false;
  }
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
export function generalise(paths, floor = 1) {
  const dirs = new Set();
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    parts.pop(); // the file itself
    if (parts.length === 0) { dirs.add(p); continue; }
    dirs.add(parts.join("/"));
  }
  const kept = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && d.startsWith(o + "/")));
  return kept.map((d) => (d.split("/").length > floor ? d + "/**" : d + "/**")).sort();
}
