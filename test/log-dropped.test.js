/**
 * A flooded system log drops kernel denials before seisin sees them.
 *
 * Measured on a real machine: a network filter's kernel extension writing
 * thousands of lines a second, and every write a run was denied missing from
 * the log and the queue. `log stream` says it dropped messages and nothing
 * else; these are about counting that, saying it, and measuring it on demand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { droppedIn, watchDenials, measureSystemLog } from "../src/violations.js";
import { renderEntry } from "../src/render.js";

const MARKER = "=== Messages dropped during live streaming (use `log show` to see what they were)\n";
const WRITE_DENY =
  "2026-09-14 15:51:48.212 E  kernel[0:78a1c2] (Sandbox) Sandbox: bash(65518) deny(1) " +
  "file-write-create /private/tmp/demo/src/api/tagprobe.txt\n" +
  "CMD64_c2ggLWMgJ2VjaG8gaGkgPiBzcmMvYXBpL3RhZ3Byb2JlLnR4dCc=_END__qlvxb5sax_SBX\n";

/** A `log stream` that, like the real one, flushes what it holds only on SIGINT. */
function fakeStream({ held = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (sig) => {
    child.signals.push(sig);
    if (sig === "SIGINT" && held) child.stdout.push(held);
    child.stdout.push(null);
    child.signalCode = sig;
    child.stdout.once("end", () => child.emit("close", null, sig));
    child.stdout.resume();
  };
  return child;
}

const delivered = () => new Promise((r) => setImmediate(r));

test("droppedIn counts one per marker line, and nothing else", () => {
  assert.equal(droppedIn(""), 0);
  assert.equal(droppedIn(MARKER + MARKER + "Timestamp  Ty Process\n" + MARKER), 3);
  assert.equal(droppedIn("a line that mentions === Messages dropped during live streaming mid-line\n"), 0);
});

test("a run's watcher counts dropped batches between denials, after them, and in what it was still holding", async () => {
  const child = fakeStream({ held: MARKER + MARKER });
  const seen = [];
  const w = watchDenials((d) => seen.push(d.path), {
    argv: ["sh", "-c", "echo hi > src/api/tagprobe.txt"], platform: "darwin", spawnFn: () => child, treeFn: () => new Map(),
  });
  child.stdout.push(MARKER + WRITE_DENY);   // before a denial: in its chunk
  child.stdout.push(MARKER);                // after the last one: still in the buffer
  await delivered();
  const stats = await w.close();
  assert.deepEqual(seen, ["/private/tmp/demo/src/api/tagprobe.txt"], "the denial itself still arrives");
  assert.equal(stats.dropped, 4);
  // SIGTERM made `log` throw away what it had not written yet: measured, 18 markers against 0.
  assert.deepEqual(child.signals, ["SIGINT"]);
});

test("a stream that is all markers is counted before the buffer is let go", async () => {
  const child = fakeStream();
  const w = watchDenials(() => {}, { platform: "darwin", spawnFn: () => child, treeFn: () => new Map() });
  child.stdout.push(MARKER.repeat(1000));   // > 64 KB with no tag in it
  await delivered();
  assert.equal((await w.close()).dropped, 1000);
});

test("measureSystemLog reports the batches lost and names who writes the most", async () => {
  const children = [];
  const spawnFn = (_cmd, args) => {
    const c = fakeStream({ held: args.includes("--predicate") ? MARKER : "" });
    children.push({ args, c });
    return c;
  };
  const m = measureSystemLog({ seconds: 0.05, platform: "darwin", spawnFn });
  const [ours, all] = children.map((x) => x.c);
  ours.stdout.push(MARKER + MARKER);
  const line = (o) => JSON.stringify(o) + "\n";
  for (let i = 0; i < 5; i++) all.stdout.push(line({ processImagePath: "/kernel", eventMessage: "cfil_inp_log: 7 outbound TCP data dropped" }));
  all.stdout.push(line({ processImagePath: "/usr/libexec/taskgated", subsystem: "com.apple.securityd", eventMessage: "x" }));
  all.stdout.push("Filtering the log data\n");
  const r = await m;
  assert.equal(r.available, true);
  assert.equal(r.dropped, 3, "two while streaming, one flushed on SIGINT");
  assert.equal(r.top[0].who, "kernel · cfil_inp_log", "a kernel message is named by the function that wrote it");
  assert.equal(r.top[1].who, "taskgated · com.apple.securityd");
  assert.ok(children.every((x) => x.c.signals[0] === "SIGINT"));
});

test("off macOS there is no system log stream to measure", async () => {
  const r = await measureSystemLog({ platform: "linux", spawnFn: () => { throw new Error("not called"); } });
  assert.equal(r.available, false);
  assert.match(r.reason, /linux/);
});

test("seisin log shows the loss as a line of its own", () => {
  const s = renderEntry({ at: "2026-10-13T05:27:11.000Z", event: "log-dropped", role: "agent", run: "abcd1234", batches: 52 })
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(s, /05:27:11  log dropped  agent 52 batch\(es\) of system log messages lost — kernel denials may be missing/);
  assert.doesNotMatch(s, /undefined|allowed/);
});
