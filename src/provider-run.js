/**
 * Runs one key provider and reports what it printed, as JSON on stdout.
 *
 * A separate process because `spawnSync` cannot do two things a provider
 * needs, and `resolveRef` is synchronous by contract (keys.js):
 *
 *   - **Take the answer when the provider exits.** `spawnSync` returns when
 *     the child has exited AND every copy of its stdout is closed. A provider
 *     that printed the value, exited 0 and left a background process holding
 *     the pipe made seisin wait the whole timeout and then say the provider
 *     "did not answer". Here the answer is what was read by the time the
 *     provider exited, plus a short drain for bytes still in the pipe.
 *   - **Stop it for good.** A timeout is SIGKILL, not SIGTERM: a provider that
 *     ignored SIGTERM held the run forever.
 *
 * stderr is read and counted, never kept: a provider may print the value
 * there, and nothing downstream shows it.
 *
 * argv: <timeoutMs> <maxBytes> <drainMs> <command> [args…]
 */
import { spawn } from "node:child_process";

const [timeoutMs, maxBytes, drainMs] = process.argv.slice(2, 5).map(Number);
const argv = process.argv.slice(5);

const chunks = [];
let size = 0, errBytes = 0, timedOut = false, tooBig = false, done = false;

function finish(result) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  const out = tooBig ? "" : Buffer.concat(chunks).toString("base64");
  process.stdout.write(JSON.stringify({ ...result, out, errBytes, timedOut, tooBig }), () => process.exit(0));
}

const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
const kill = () => { try { child.kill("SIGKILL"); } catch {} };
const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);

child.stdout.on("data", (c) => {
  size += c.length;
  if (size > maxBytes) { tooBig = true; chunks.length = 0; kill(); return; }
  if (!tooBig) chunks.push(c);
});
child.stderr.on("data", (c) => { errBytes += c.length; });
child.on("error", (e) => finish({ error: e.code ?? e.message }));
child.on("exit", (status, signal) => {
  // What the provider wrote before exiting may still be in the pipe. Wait for
  // the end of it, but not for a descendant that kept the pipe open.
  const drained = () => finish({ status, signal });
  if (child.stdout.readableEnded) return drained();
  child.stdout.once("end", drained);
  setTimeout(drained, drainMs).unref();
});
