/**
 * Where a running `seisin ui` leaves its live link, so it can be found again.
 *
 * The console's token never travels in an HTTP response — that was the whole
 * point of the redesign in serve.js: a page that could GET `/` used to walk
 * away with it. The cost was that a tab which lost the fragment had nowhere to
 * recover the token from but the terminal that printed it once. When that
 * terminal is gone, so is the link.
 *
 * This is the recovery channel that does not reopen the leak: the link (token
 * and all) is written to a file only this user can read — under `$TMPDIR/snr/`,
 * the same 0700 directory runs already keep their sockets and keys in — and
 * never sent over the wire. `seisin ui` on a busy port reads it and reopens the
 * live link instead of failing; `seisin ui --link` prints it. The token now
 * rests on disk (0600) for the life of the run rather than only in memory, a
 * bounded, local-user exposure, and it is removed when the run exits.
 *
 * The pid is stored so a file left by a crashed run is recognisable: a link
 * whose writer is gone is stale, not a running console.
 */
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { runsRoot } from "./rundir.js";

function linkFile(port, base) {
  return join(runsRoot(base), `ui-${port}.url`);
}

/** Records this run's live URL for the port it bound. */
export function writeUiLink(port, url, base) {
  writeFileSync(linkFile(port, base), JSON.stringify({ url, pid: process.pid }) + "\n", { mode: 0o600 });
}

/**
 * The live URL a `seisin ui` left for this port, with whether its writer is
 * still alive — or null if there is no readable record.
 */
export function readUiLink(port, base) {
  let raw;
  try { raw = readFileSync(linkFile(port, base), "utf8"); } catch { return null; }
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e.url !== "string") return null;
  let alive = null;
  if (typeof e.pid === "number") {
    // Signal 0 tests for the process without touching it: it throws if gone.
    try { process.kill(e.pid, 0); alive = true; } catch { alive = false; }
  }
  return { url: e.url, pid: e.pid ?? null, alive };
}

/** Removes the record. Called on exit, and when a stale one is found. */
export function clearUiLink(port, base) {
  try { unlinkSync(linkFile(port, base)); } catch {}
}
