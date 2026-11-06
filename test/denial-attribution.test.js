import { test } from "node:test";
import assert from "node:assert/strict";
import { createDenialAttribution, TREE_MS } from "../src/denial-attribution.js";
import { watchDenials, underAnotherRun } from "../src/violations.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const denial = (pid, suffix = "ours_SBX", command = null) => ({
  pid, suffix, command, action: "write", operation: "file-write-create", path: `/repo/${pid}`,
});

function tree() {
  const t = new Map([[900, 1], [500, 1], [10, 500], [31, 1], [32, 900], [33, 900]]);
  t.roots = new Set([900, 500]);
  return t;
}

test("held arrivals survive duplicates and PID discovery, including a suffix learned during replay", () => {
  const seen = [];
  const a = createDenialAttribution((d) => seen.push(d.pid), { treeFn: tree });
  a.accept(denial(31)); // Orphan: only the later child's suffix can identify it.
  a.accept(denial(31)); // The OS's second report must not enter the held queue.
  a.accept(denial(10, "foreign_SBX"));
  a.accept(denial(32));
  a.accept(denial(33));
  assert.deepEqual(a.stats, { attributed: 0, foreign: 0, unattributed: 4, dropped: 0 });

  a.attributeTo(900);
  // The child is reported before the orphan it resolves; the remaining held
  // arrival follows them. Keep this callback order when learning a suffix.
  assert.deepEqual(seen, [32, 31, 33]);
  assert.deepEqual(a.stats, { attributed: 3, foreign: 1, unattributed: 0, dropped: 0 });
  a.attributeTo(900);
  a.revisitPending();
  a.accept(denial(31));
  assert.deepEqual(seen, [32, 31, 33], "replay and duplicate deliveries cannot count again");
});

test("a matching command resolves held events even before the run's PID is known", () => {
  const seen = [];
  const a = createDenialAttribution((d) => seen.push(d.pid), {
    argv: ["sh", "-c", "work"],
    treeFn: () => { throw new Error("the command anchor needs no process tree"); },
  });
  a.accept(denial(31));
  a.accept(denial(10, "foreign_SBX"));
  a.accept(denial(32, "ours_SBX", "sh -c work"));
  assert.deepEqual(seen, [32, 31]);
  assert.deepEqual(a.stats, { attributed: 2, foreign: 1, unattributed: 0, dropped: 0 });
});

test("a deferred snapshot resolves an untagged arrival without a reader or real timer", () => {
  const seen = [];
  let time = 0, calls = 0, requests = 0;
  const t = tree();
  const a = createDenialAttribution((d) => seen.push(d.pid), {
    pid: 900, now: () => time,
    treeFn: () => { calls++; const copy = new Map(t); copy.roots = t.roots; return copy; },
    requestRecheck: () => { requests++; },
  });
  a.accept(denial(10, "foreign_SBX"));
  time = 1;
  t.set(34, 900);
  a.accept(denial(34, null));
  assert.equal(requests, 1);
  assert.equal(calls, 1);
  assert.equal(a.stats.unattributed, 1);
  assert.deepEqual(seen, []);

  time = TREE_MS + 1;
  a.revisitPending();
  assert.equal(calls, 2);
  assert.deepEqual(seen, [34]);
  assert.deepEqual(a.stats, { attributed: 1, foreign: 1, unattributed: 0, dropped: 0 });
});

/* ── attribution: an orphan is not a stranger ────────────────────────── */

/** A denial as `log stream` prints it; `suffix: null` leaves the tag off. */
const kernelLine = (pid, suffix, cmd = "something the runtime quoted differently") =>
  `2026-09-30 12:00:00.000 E  kernel[0:78a1c2] (Sandbox) Sandbox: bash(${pid}) deny(1) file-write-create /private/tmp/demo/src/x${pid}.txt\n` +
  (suffix ? `CMD64_${Buffer.from(cmd).toString("base64")}_END_${suffix}_SBX` : "untagged_SBX");

function fakeStream() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.kill = () => {};
  return child;
}

const delivered = () => new Promise((r) => setImmediate(r));

const OURS = ["env", "SEISIN_RUN_ID=abc", "sh", "-c", "work"];

// 800 is our `seisin run`, 900 its srt; 400/500 another run. 31000 was started
// by our run with `cmd &` and reparented to init when its shell exited.
function table() {
  const t = new Map([[800, 1], [900, 800], [31_001, 900], [400, 1], [500, 400], [10_000, 500], [31_000, 1]]);
  t.roots = new Set([800, 900, 400, 500]);
  return t;
}

test("underAnotherRun: another run's descendant yes, an orphan no, a table without commands as before", () => {
  const t = table();
  assert.equal(underAnotherRun(10_000, 900, t), true);
  assert.equal(underAnotherRun(31_000, 900, t), false);
  const bare = new Map(t);                     // no `roots`: cannot tell
  assert.equal(underAnotherRun(31_000, 900, bare), true);
});

test("an orphaned child of this run does not turn its suffix foreign; its line is kept and attributed", async () => {
  const child = fakeStream();
  const seen = [];
  const w = watchDenials((d) => seen.push(d.pid), { argv: OURS, platform: "darwin", spawnFn: () => child, treeFn: table });
  w.attributeTo(900);
  child.stdout.push(kernelLine(31_000, "_ours12345"));    // the orphan: alive, under no run
  await delivered();
  assert.deepEqual(seen, []);
  assert.equal(w.stats.foreign, 0, "an orphan is not proof of a stranger");
  assert.equal(w.stats.unattributed, 1, "held until something decides it");
  child.stdout.push(kernelLine(31_001, "_ours12345"));    // a child still in our tree
  child.stdout.push(kernelLine(10_000, "_aaaaaaaaa"));    // another run, really foreign
  await delivered();
  assert.deepEqual(seen.sort(), [31_000, 31_001]);
  assert.deepEqual([w.stats.attributed, w.stats.foreign, w.stats.unattributed], [2, 1, 0]);
  w.close();
});

test("a line without a suffix put off to the next snapshot is held for it, not dropped", async () => {
  const child = fakeStream();
  const seen = [];
  const t = table();
  let calls = 0;
  const w = watchDenials((d) => seen.push(d.pid), { argv: OURS, platform: "darwin", spawnFn: () => child,
    treeFn: () => { calls++; const c = new Map(t); c.roots = t.roots; return c; } });
  w.attributeTo(900);
  child.stdout.push(kernelLine(10_000, "_aaaaaaaaa"));    // foreign: takes the snapshot
  await delivered();
  t.set(32_000, 900);                                       // ours, born after it
  child.stdout.push(kernelLine(32_000, null));
  await delivered();
  assert.deepEqual(seen, []);
  assert.equal(w.stats.unattributed, 1, "held for the deferred look");
  for (const end = Date.now() + 3000; !seen.length && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(seen, [32_000]);
  assert.equal(calls, 2);
  w.close();
});
