/**
 * Masks a role's own secrets on their way out of the process.
 *
 * The sandbox stops a role from *getting* a key that is not its own. It cannot
 * stop a role from spilling one it legitimately holds — a `cat` while debugging,
 * an error message that echoes a header, a token printed into a log that is
 * three commits from being pushed. That is a different failure and it needs a
 * different place to stand: the launcher already carries the child's output.
 *
 * ── The trade this makes, stated plainly ──
 * To mask a value, seisin has to read it. So a role's own keys pass through this
 * process in memory. That is a real cost and it buys the only leak that matters
 * in practice; if you would rather it not, `[runtime] redact = false`.
 *
 * ── And what it cannot catch ──
 * Only the literal value, and only on stdout and stderr. A key the agent writes
 * straight to a file never comes through here, and neither does one it has
 * base64'd. This narrows the blast radius of a careless print. It is not a
 * containment boundary, and calling it one would be the sort of claim this
 * README spends its time avoiding.
 */
import { Transform } from "node:stream";

/** Reads the values this role may read. Unreadable or huge files are skipped. */
export function secretsOf(settings, readFile) {
  const out = [];
  for (const path of settings.filesystem.allowRead) {
    let text;
    try {
      text = readFile(path, "utf8");
    } catch {
      continue; // declared but not on disk yet: nothing to mask
    }
    if (text.length > 64 * 1024) continue; // not a credential; do not scan a blob
    for (const line of text.split(/\r?\n/)) {
      const value = line.includes("=") ? line.slice(line.indexOf("=") + 1) : line;
      const v = value.trim().replace(/^["']|["']$/g, "");
      // Short strings produce false positives that mangle ordinary output.
      if (v.length >= 8) out.push(v);
    }
  }
  // Longest first, so a value that contains another is masked whole.
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/**
 * A stream that replaces each secret with `‹redacted:name›`.
 *
 * It carries the tail of each chunk forward, because a value split across a
 * buffer boundary would otherwise sail through — which is the one case a
 * naive implementation always gets wrong and never notices.
 */
export function redactor(secrets, label = "redacted") {
  if (secrets.length === 0) return null;
  const longest = secrets[0].length;
  let tail = "";

  return new Transform({
    transform(chunk, _enc, done) {
      // Mask the WHOLE accumulated text first, then cut. Doing it the other way
      // — masking only the part about to be emitted — lets a secret that
      // straddles the cut through in two innocent halves. Written that way
      // first; the split-buffer test caught it on the first run.
      const masked = mask(tail + chunk.toString("utf8"), secrets, label);
      const keep = Math.min(longest - 1, masked.length);
      this.push(masked.slice(0, masked.length - keep));
      tail = masked.slice(masked.length - keep);
      done();
    },
    flush(done) {
      this.push(mask(tail, secrets, label));
      tail = "";
      done();
    },
  });
}

function mask(text, secrets, label) {
  let out = text;
  for (const s of secrets) out = out.split(s).join(`‹${label}›`);
  return out;
}
