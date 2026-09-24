/**
 * Temporary directories for tests, removed when the test file's process ends.
 *
 * Every test made its own with mkdtempSync and most never removed it — or
 * removed it only on the passing path. Measured: one run of the suite left 28
 * directories in the temp dir, and test/.sandbox-box had grown to 5,084. One
 * place that remembers what it made, and one exit handler; `node --test`
 * runs each file in its own process, so each file cleans up after itself.
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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
  const box = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
  mkdirSync(box, { recursive: true });
  const d = mkdtempSync(join(box, prefix));
  made.push(d);
  return d;
}
