/**
 * What the kernel watcher costs under a burst of denials, and what it must not lose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { watchDenials } from "../src/violations.js";

test("a kernel watcher that cannot start has the whole shape run relies on", async () => {
  const w = watchDenials(() => {}, { platform: "darwin", spawnFn: () => { throw new Error("no log(1) here"); } });
  assert.equal(w.available, false);
  assert.doesNotThrow(() => w.attributeTo(123));
  assert.deepEqual(await w.close({ drain: 50 }), { attributed: 0, foreign: 0, unattributed: 0, dropped: 0 });
});

/* ── P1-15: `ps` is not taken once per foreign denial ─────────────────── */

/** A denial as `log stream` prints it, from `pid`, tagged with `cmd` and `suffix`. */
const denial = (pid, suffix, cmd = "git gc --aggressive", path = "/private/tmp/demo/src/api/x.txt") =>
  `2026-09-30 12:00:00.000 E  kernel[0:78a1c2] (Sandbox) Sandbox: bash(${pid}) deny(1) file-write-create ${path}\n` +
  `CMD64_${Buffer.from(cmd).toString("base64")}_END_${suffix}_SBX`;

function fakeStream() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.kill = () => {};
  return child;
}

const delivered = () => new Promise((r) => setImmediate(r));

const OURS = ["env", "SEISIN_RUN_ID=abc", "sh", "-c", "work"];

test("a burst of foreign denials costs one ps, not one each (review P1-15)", async () => {
  const child = fakeStream();
  let calls = 0;
  // Two other sandboxes, alive, under their own srt (pid 500 and 600).
  const tree = new Map([[900, 1], [500, 1], [600, 1]]);
  for (let i = 0; i < 40; i++) { tree.set(10_000 + i, 500); tree.set(20_000 + i, 600); }
  const w = watchDenials(() => {}, { argv: OURS, platform: "darwin", spawnFn: () => child,
    treeFn: () => { calls++; return tree; } });
  w.attributeTo(900);

  for (let i = 0; i < 40; i++) {
    child.stdout.push(denial(10_000 + i, "_aaaaaaaaa"));
    child.stdout.push(denial(20_000 + i, "_bbbbbbbbb"));
  }
  await delivered();
  assert.ok(calls <= 2, `${calls} ps snapshots for 80 foreign denials`);
  assert.equal(w.stats.attributed, 0);
  assert.equal(w.stats.foreign, 80, "a suffix proven foreign is counted, not held");
  w.close();
});

test("throttling ps does not lose a denial from a process younger than the snapshot", async () => {
  const child = fakeStream();
  const seen = [];
  const tree = new Map([[900, 1], [500, 1], [10_000, 500]]);
  let calls = 0;
  const w = watchDenials((d) => seen.push(d.pid), { argv: OURS, platform: "darwin", spawnFn: () => child,
    treeFn: () => { calls++; return new Map(tree); } });
  w.attributeTo(900);

  child.stdout.push(denial(10_000, "_aaaaaaaaa"));      // foreign: takes the snapshot
  await delivered();
  // Ours, from a process born after that snapshot, with a tag that does not
  // match (the case the tree exists for). Inside the window: no ps now.
  tree.set(30_000, 900);
  child.stdout.push(denial(30_000, "_ours12345", "something the runtime quoted differently"));
  await delivered();
  assert.deepEqual(seen, [], "decided on a stale snapshot");
  const before = calls;
  for (const end = Date.now() + 3000; !seen.length && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(seen, [30_000], "held and never looked at again");
  assert.equal(calls, before + 1, "one snapshot for the deferred look");
  w.close();
});
