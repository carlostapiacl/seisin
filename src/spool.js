/**
 * The audit trail, held by the parent instead of by the thing being audited.
 *
 * ── Why this exists ──
 * `.seisin/` used to be in every role's allowWrite, because the hook runs
 * inside the box and has to record what it decided. That made the log and the
 * request queue writable by the process they are a record of: an agent could
 * truncate `log.jsonl`, rewrite a decision, or invent a request that had never
 * been refused. The files said "append-only" in their own comments and nothing
 * enforced it. An external review named this and was right.
 *
 * So the file moves out of reach and a socket takes its place:
 *
 *     agent ─X─► .seisin/            (no longer writable)
 *     hook  ──line──► unix socket ──► seisin run ──append──► .seisin/log.jsonl
 *
 * The only verb reachable from inside the sandbox is "send one line". There is
 * no seek, no truncate, no unlink, because there is no file descriptor — and
 * `allowUnixSockets` is granted for exactly this one socket path, so it is not
 * a general hole either.
 *
 * ── What this does not fix, stated plainly ──
 * A hostile agent can still *send* lines, so it can add noise to its own
 * record. What it can no longer do is erase or alter what is already there.
 * Forgery and tampering are different problems and only the second one is
 * solved here; the log is evidence of what happened, not proof that nothing
 * else did.
 */
import { createServer, createConnection, Socket } from "node:net";
import { unlinkSync, existsSync, mkdtempSync, chmodSync, openSync, writeSync, closeSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** The env var a confined hook looks for. Absent means "write the file". */
export const SOCK_ENV = "SEISIN_SPOOL";

/**
 * Where the socket lives.
 *
 * Not under the repo: the point is a path the role's territory does not cover.
 * Kept short because a unix socket path is capped near 104 bytes on macOS and
 * the failure when it is too long is an unhelpful EINVAL.
 */
export function spoolPath() {
  // A random directory, 0700, rather than a name anyone can guess from the pid.
  // The socket itself is already denyWrite so the agent cannot unlink it, but
  // any other process running as this user could otherwise connect and add
  // lines. That does not let them erase anything — forgery is the part that
  // stays open — but a predictable path invites it for free.
  const dir = mkdtempSync(join(tmpdir(), "seisin-"));
  chmodSync(dir, 0o700);
  return join(dir, "spool.sock");
}

/**
 * Listens for lines from inside the box and hands each to `sink`.
 *
 * One line is one JSON object with a `to` field naming which file it belongs
 * in. The parent decides what that means; the sender does not get to pick a
 * path, which is the other half of why this is not just a slower file write.
 */
/**
 * Which channel this platform can use: a unix socket, or a FIFO.
 *
 * On Linux the runtime blocks creating ANY unix socket inside the box with a
 * seccomp filter — it cannot filter by path, so `allowUnixSockets` is ignored
 * there (its README says so). The socket this file was built on therefore
 * never carried a line on Linux: measured in Docker on 2026-09-23, with the
 * code as published in 0.2.0 and after, the hook "sent" and the log stayed
 * empty. A FIFO is a file, not a socket — seccomp does not see it, bubblewrap
 * grants it by path, and a write of up to PIPE_BUF bytes is atomic, so lines
 * from concurrent tool calls do not interleave. Measured the same day: the
 * role wrote a line through it, could not create anything beside it, and
 * could not remove it.
 */
export const FIFO_SUFFIX = ".fifo";
export const channelName = (platform = process.platform) => (platform === "linux" ? "s.fifo" : "s.sock");

/** The most a FIFO write carries atomically on Linux (PIPE_BUF). */
const PIPE_BUF = 4096;

/** Parses newline-separated JSON messages and hands each to `sink`. */
function lineReader(sink, onTooLong) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    // A 1 MB line is not a log entry, it is something trying to fill a disk.
    if (buffer.length > 1_000_000) { buffer = ""; return onTooLong?.(); }
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && (msg.to === "log" || msg.to === "requests")) sink(msg.to, msg.entry);
      } catch {
        // Garbage from inside the box is not the parent's emergency.
      }
    }
  };
}

/**
 * The FIFO end of the spool. Opened read-write so it never sees end-of-file
 * when a writer closes — every hook call opens, writes one line and closes —
 * and read through a net.Socket, which takes a pipe descriptor and reads it
 * without holding a thread.
 */
function fifoSpool(sink, path) {
  if (existsSync(path)) unlinkSync(path);
  execFileSync("mkfifo", ["-m", "600", path]);
  const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  const stream = new Socket({ fd, readable: true, writable: false });
  stream.setEncoding("utf8");
  stream.on("data", lineReader(sink));
  stream.on("error", () => {});
  return Promise.resolve({
    path,
    close() {
      stream.destroy();
      try { unlinkSync(path); } catch {}
    },
  });
}

export function spool(sink, path = spoolPath()) {
  if (path.endsWith(FIFO_SUFFIX)) return fifoSpool(sink, path);
  if (existsSync(path)) unlinkSync(path);

  const server = createServer((conn) => {
    conn.setEncoding("utf8");
    conn.on("data", lineReader(sink, () => conn.destroy()));
    conn.on("error", () => {});
  });

  /**
   * A failed `listen` has to reject, and it used to do nothing at all.
   *
   * The error handler swallowed everything and the promise only ever settled
   * from the `listen` callback, so any failure to bind — a denied path, a name
   * too long for a unix socket, a directory that is not there — left an awaited
   * promise pending forever. What the user saw was Node's "Detected unsettled
   * top-level await" and rc=13: no error, no path, nothing naming the spool.
   * Measured while running seisin inside seisin, where the outer box refuses
   * the inner bind; but nothing about it is particular to that case, which is
   * the reason it is fixed here rather than beside the nesting check.
   *
   * After a successful bind the handler goes back to swallowing, because by
   * then an error belongs to one connection and must not take down the run
   * that the audit trail is only observing.
   */
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(path, () => {
      server.removeListener("error", fail);
      server.on("error", () => {});
      ok({
      path,
      close() {
        server.close();
        // Only the socket. The first version removed `dirname(path)` too,
        // reasoning that spoolPath() had just made that directory — but a
        // caller passing its own path makes dirname the system temp directory,
        // and closing the spool deleted it. That is a caller's whole scratch
        // space gone, for a cleanup. Whoever created the directory removes it:
        // see `run`, which owns the one spoolPath() makes.
        try { unlinkSync(path); } catch {}
      },
      });
    });
  });
}

/**
 * Sends one entry to the parent, if there is one listening.
 *
 * Returns a promise and registers it, because the hook is a short-lived
 * process whose last act is `process.exit` — and an exit does not wait for a
 * socket to drain. The write would be lost exactly when it matters, silently,
 * which is the shape of the original bug this file replaces. `flush()` is what
 * the hook awaits before it answers.
 */
const inFlight = new Set();

export function send(to, entry, path = process.env[SOCK_ENV]) {
  if (!path) return false;
  if (path.endsWith(FIFO_SUFFIX)) return sendFifo(to, entry, path);
  const p = new Promise((done) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; done(true); } };
    try {
      const conn = createConnection(path);
      // Never hang the agent's turn on bookkeeping. If the parent is gone, the
      // entry is lost and the run continues — the boundary does not depend on
      // this succeeding.
      const guard = setTimeout(() => { conn.destroy(); finish(); }, 1000);
      conn.on("error", () => { clearTimeout(guard); finish(); });
      conn.on("close", () => { clearTimeout(guard); finish(); });
      conn.write(JSON.stringify({ to, entry: { at: new Date().toISOString(), ...entry } }) + "\n");
      conn.end();
    } catch {
      finish();
    }
  });
  inFlight.add(p);
  p.then(() => inFlight.delete(p));
  return true;
}

/** Waits for everything `send` started. Call it before exiting. */
export async function flush() {
  await Promise.all([...inFlight]);
}

/**
 * One line into the FIFO, synchronously: nothing to flush, nothing to lose to
 * `process.exit`. Non-blocking, so a parent that is gone (no reader) costs an
 * ENXIO and not a hung tool call. Longer than PIPE_BUF, the free-text fields
 * are shortened first — past that size a write is no longer atomic and two
 * tool calls could interleave their lines.
 */
function sendFifo(to, entry, path) {
  const full = { at: new Date().toISOString(), ...entry };
  let line = JSON.stringify({ to, entry: full }) + "\n";
  if (Buffer.byteLength(line) > PIPE_BUF) {
    const short = { ...full, reason: String(full.reason ?? "").slice(0, 300), target: String(full.target ?? "").slice(0, 1000) };
    line = JSON.stringify({ to, entry: short }) + "\n";
    if (Buffer.byteLength(line) > PIPE_BUF) return false;
  }
  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    writeSync(fd, line);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}
