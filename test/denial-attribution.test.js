import { test } from "node:test";
import assert from "node:assert/strict";
import { createDenialAttribution, TREE_MS } from "../src/denial-attribution.js";

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
