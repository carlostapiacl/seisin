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
import { createServer, createConnection } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The env var a confined hook looks for. Absent means "write the file". */
export const SOCK_ENV = "SEISIN_SPOOL";

/**
 * Where the socket lives.
 *
 * Not under the repo: the point is a path the role's territory does not cover.
 * Kept short because a unix socket path is capped near 104 bytes on macOS and
 * the failure when it is too long is an unhelpful EINVAL.
 */
export function spoolPath(pid = process.pid) {
  return join(tmpdir(), `seisin-${pid}.sock`);
}

/**
 * Listens for lines from inside the box and hands each to `sink`.
 *
 * One line is one JSON object with a `to` field naming which file it belongs
 * in. The parent decides what that means; the sender does not get to pick a
 * path, which is the other half of why this is not just a slower file write.
 */
export function spool(sink, path = spoolPath()) {
  if (existsSync(path)) unlinkSync(path);

  const server = createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      // A 1 MB line is not a log entry, it is something trying to fill a disk.
      if (buffer.length > 1_000_000) return conn.destroy();
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
    });
    conn.on("error", () => {});
  });

  server.on("error", () => {});
  return new Promise((ok) => {
    server.listen(path, () => ok({
      path,
      close() {
        server.close();
        try { unlinkSync(path); } catch {}
      },
    }));
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
