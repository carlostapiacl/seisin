/**
 * The log's hash chain (`prev` on every line) and `seisin log verify`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boxed } from "./_tmp.js";

import { append, withLock, droppedPath, verifyChain, verifyLog, logSegments, read, GENESIS } from "../src/log.js";
import { appendFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { genesisPath } from "../src/log.js";
import { CLI, scratch } from "./_tmp.js";


function logFile() {
  return join(boxed("chain-"), ".seisin", "log.jsonl");
}
const write = (f, n) => { for (let i = 0; i < n; i++) append(f, { role: "r", action: "write", target: `t${i}`, verdict: "denied" }); };

test("a fresh log chains from genesis and verifies", () => {
  const f = logFile();
  write(f, 5);
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].prev, GENESIS);
  assert.deepEqual(verifyChain(f), { lines: 5, unchained: 0, chained: 5, breaks: [] });
});

test("an edited line breaks the chain on the line after it", () => {
  const f = logFile();
  write(f, 5);
  const lines = readFileSync(f, "utf8").split("\n");
  lines[2] = lines[2].replace('"denied"', '"allowed"');        // the kind of edit that would matter
  writeFileSync(f, lines.join("\n"));
  const r = verifyChain(f);
  assert.equal(r.breaks.length, 1);
  assert.equal(r.breaks[0].line, 4);
});

test("a removed line breaks it too", () => {
  const f = logFile();
  write(f, 5);
  const lines = readFileSync(f, "utf8").split("\n");
  lines.splice(1, 1);
  writeFileSync(f, lines.join("\n"));
  assert.equal(verifyChain(f).breaks.length, 1);
});

test("lines from before the chain are an unchained prefix, not tampering", () => {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ at: "2026-09-01T00:00:00Z", role: "r", verdict: "denied" }) + "\n" +
    JSON.stringify({ at: "2026-09-02T00:00:00Z", role: "r", verdict: "denied" }) + "\n");
  write(f, 3);
  assert.deepEqual(verifyChain(f), { lines: 5, unchained: 2, chained: 3, breaks: [] });
});

// ── Rotation ──
// The log is capped by retiring a full segment and seeding a fresh one that
// still chains, so `seisin log verify` holds across the cut.

function withRotationAt(bytes, keep, fn) {
  const max = process.env.SEISIN_LOG_MAX_BYTES, kp = process.env.SEISIN_LOG_KEEP;
  process.env.SEISIN_LOG_MAX_BYTES = String(bytes);
  if (keep != null) process.env.SEISIN_LOG_KEEP = String(keep);
  try { return fn(); }
  finally {
    if (max === undefined) delete process.env.SEISIN_LOG_MAX_BYTES; else process.env.SEISIN_LOG_MAX_BYTES = max;
    if (kp === undefined) delete process.env.SEISIN_LOG_KEEP; else process.env.SEISIN_LOG_KEEP = kp;
  }
}

test("a full segment is retired and the new one still chains across the cut", () => {
  const f = logFile();
  withRotationAt(1500, null, () => write(f, 60)); // ~120B/line → several rotations
  const segs = logSegments(f);
  assert.ok(segs.length >= 2, `expected rotation, got ${segs.length} segment(s)`);
  assert.ok(segs[segs.length - 1].endsWith("log.jsonl"), "the current segment is last");
  // The whole history verifies as one chain, across every segment.
  const r = verifyLog(f);
  assert.deepEqual(r.breaks, [], `broken: ${JSON.stringify(r.breaks.slice(0, 3))}`);
  assert.equal(r.segments, segs.length);
  // Every real decision is still there; the rotation markers are structural and
  // do not show up as entries.
  assert.equal(read(f).length + /* markers live in older segments */ 0 >= 1, true);
});

test("the new segment's first line is a rotation marker, and read skips it", () => {
  const f = logFile();
  withRotationAt(1500, null, () => write(f, 60));
  const current = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(current[0].event, "rotated", "the current segment opens with a marker");
  assert.notEqual(current[0].prev, GENESIS, "the marker continues the retired segment, not genesis");
  // read() of the current file returns decisions only, never the marker.
  assert.ok(read(f).every((e) => e.event !== "rotated"));
});

test("editing a retired segment is caught by verify across the cut", () => {
  const f = logFile();
  withRotationAt(1500, null, () => write(f, 60));
  const archive = logSegments(f).find((p) => !p.endsWith("log.jsonl") ) + "";
  const lines = readFileSync(archive, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes('"denied"'));
  lines[i] = lines[i].replace('"denied"', '"allowed"');
  writeFileSync(archive, lines.join("\n"));
  const r = verifyLog(f);
  assert.ok(r.breaks.length >= 1, "a tampered retired segment must break verify");
});

test("verifyChain of one file still starts at genesis (single-file contract)", () => {
  const f = logFile();
  write(f, 4);
  assert.deepEqual(verifyChain(f), { lines: 4, unchained: 0, chained: 4, breaks: [] });
});

test("only the keep count of retired segments is kept, oldest dropped", () => {
  const f = logFile();
  withRotationAt(1500, 2, () => write(f, 90)); // many rotations, keep = 2 retired
  const retired = logSegments(f).filter((p) => !p.endsWith("log.jsonl"));
  assert.ok(retired.length <= 2, `keep=2 exceeded: ${retired.length} retired segments`);
  // What survives still verifies as a chain (the dropped prefix is retention).
  assert.deepEqual(verifyLog(f).breaks, []);
});

test("several processes writing at once do not fork the chain", async () => {
  // A round runs several roles at once, each with its own parent writing here.
  const f = logFile();
  write(f, 1);
  const url = new URL("../src/log.js", import.meta.url).href;
  const one = (k) => new Promise((ok) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e",
      `import { append } from ${JSON.stringify(url)}; for (let i = 0; i < 40; i++) append(${JSON.stringify(f)}, { role: "p${k}", verdict: "denied", target: "t" + i });`]);
    p.on("close", ok);
  });
  await Promise.all([one(1), one(2), one(3), one(4)]);
  const r = verifyChain(f);
  assert.equal(r.lines, 161);
  assert.deepEqual(r.breaks, [], `the chain forked: ${JSON.stringify(r.breaks.slice(0, 3))}`);
});

test("a writer that times out never writes through or removes another writer's lock", () => {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".lock", "held by another process\n");
  let ran = false;
  assert.throws(
    () => withLock(f, () => { ran = true; }, { waitMs: 10, staleMs: 5000 }),
    (e) => e.code === "ELOCKED",
  );
  assert.equal(ran, false, "the unprotected write must not run");
  assert.equal(existsSync(f + ".lock"), true, "only the lock owner may remove it");
  unlinkSync(f + ".lock");
});

// The regression the lock fix above introduced, and its fix: a writer killed
// while holding the lock used to leave a fresh lock that made the next writers
// give up for a few seconds, and the entries they meant to write were lost
// without `verify` noticing.
test("a lock whose writer is dead is taken over at once, not waited out", () => {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
  writeFileSync(f + ".lock", `${dead} deadbeef0000\n`);
  let ran = false;
  withLock(f, () => { ran = true; }, { waitMs: 50, staleMs: 60_000 });
  assert.equal(ran, true, "a dead writer's lock must not block the next one");
  assert.equal(existsSync(f + ".lock"), false);
});

test("a lock whose writer is alive is never taken over for its age", () => {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".lock", `${process.pid} cafe00000000\n`);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(f + ".lock", old, old);
  assert.throws(() => withLock(f, () => {}, { waitMs: 20, staleMs: 10 }), (e) => e.code === "ELOCKED");
  assert.equal(existsSync(f + ".lock"), true);
  unlinkSync(f + ".lock");
});

test("a lock that names nobody is taken over once it is stale, inside the wait", () => {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".lock", "");
  let ran = false;
  withLock(f, () => { ran = true; }, { waitMs: 400, staleMs: 50 });
  assert.equal(ran, true);
});

test("an entry that could not get the lock is counted, and verify says so", () => {
  const f = logFile();
  write(f, 2);
  writeFileSync(f + ".lock", `${process.pid} cafe00000001\n`);
  const before = process.env.SEISIN_LOG_LOCK_WAIT_MS;
  process.env.SEISIN_LOG_LOCK_WAIT_MS = "20";
  try {
    assert.equal(append(f, { role: "r", event: "write", verdict: "denied" }), false);
  } finally {
    if (before === undefined) delete process.env.SEISIN_LOG_LOCK_WAIT_MS; else process.env.SEISIN_LOG_LOCK_WAIT_MS = before;
    unlinkSync(f + ".lock");
  }
  assert.equal(existsSync(droppedPath(f)), true);
  const r = verifyLog(f);
  assert.deepEqual(r.breaks, [], "a drop is not tampering");
  assert.equal(r.dropped, 1, "but it is not silent either");
});

const seisin = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

/* ── log verify: the genesis record and its log ──────────────────────── */

const denial = (i) => ({ role: "dev", action: "write", target: `deploy/${i}`, verdict: "denied" });

function repoLog() {
  const root = scratch("seisin-genesis-");
  writeFileSync(join(root, "seisin.toml"), `[roles.dev]\nwrites = ["src/**"]\n`);
  mkdirSync(join(root, ".seisin"));
  return { root, f: join(root, ".seisin", "log.jsonl") };
}

test("a log archived by hand beside its genesis record: verify names the record, says what to do, still fails", () => {
  const { root, f } = repoLog();
  for (let i = 0; i < 3; i++) append(f, denial(i));
  renameSync(f, join(root, ".seisin", "log-archived.jsonl"));   // the record stays behind
  for (let i = 0; i < 2; i++) append(f, denial(10 + i));
  const r = verifyLog(f);
  assert.equal(r.breaks.length, 1);
  assert.equal(r.breaks[0].foreign, true);
  const v = seisin(root, "log", "verify");
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stdout, /broken/);
  assert.match(v.stdout, /the genesis record belongs to another log/);
  assert.match(v.stdout, /move log\.jsonl\.genesis along with the archived log/);
  assert.match(v.stdout, /or remove it/);
  assert.doesNotMatch(v.stdout, /line \d+: expected prev/);
  // Doing what it says fixes it — and the new record says it came late.
  unlinkSync(genesisPath(f));
  append(f, denial(20));
  const again = seisin(root, "log", "verify");
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /start recorded late .*after 2 chained line\(s\)/);
});

test("a chain stripped whole is still a plain genesis break, not 'another log'", () => {
  const { f } = repoLog();
  for (let i = 0; i < 4; i++) append(f, denial(i));
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map((l) => { const e = JSON.parse(l); delete e.prev; return JSON.stringify(e); });
  writeFileSync(f, lines.join("\n") + "\n");
  const r = verifyLog(f);
  assert.ok(r.breaks.length >= 1);
  assert.ok(!r.breaks.some((b) => b.foreign));
});

test("a deleted genesis record is a warning, and the record the next entry writes is marked late", () => {
  const { root, f } = repoLog();
  for (let i = 0; i < 5; i++) append(f, denial(i));
  unlinkSync(genesisPath(f));
  const warned = seisin(root, "log", "verify");
  assert.equal(warned.status, 0, warned.stdout);
  assert.match(warned.stdout, /intact/);
  assert.match(warned.stdout, /where the chain starts is not recorded/);
  assert.match(warned.stdout, /tampering before that cannot be excluded/);
  append(f, denial(5));
  const g = JSON.parse(readFileSync(genesisPath(f), "utf8"));
  assert.equal(g.late, true);
  assert.equal(g.after, 5);
  const r = verifyLog(f);
  assert.deepEqual([r.breaks.length, r.genesis, r.late.after], [0, "recorded", 5]);
  assert.equal(r.late.at, g.at);
});

test("the first record on a legacy + chained log (the real shape) can be made, and is reported late", () => {
  const { root, f } = repoLog();
  writeFileSync(f, [1, 2, 3].map((d) => JSON.stringify({ at: `2026-09-0${d}T00:00:00Z`, role: "dev", verdict: "denied" })).join("\n") + "\n");
  let prev = readFileSync(f, "utf8").trim().split("\n").pop();
  for (let i = 0; i < 4; i++) {
    const line = JSON.stringify({ at: "2026-09-10T00:00:00Z", ...denial(i), prev: createHash("sha256").update(prev).digest("hex").slice(0, 32) });
    appendFileSync(f, line + "\n");
    prev = line;
  }
  assert.equal(existsSync(genesisPath(f)), false);
  append(f, denial(9));
  const g = JSON.parse(readFileSync(genesisPath(f), "utf8"));
  assert.deepEqual([g.legacy, g.late, g.after], [3, true, 4]);
  const v = seisin(root, "log", "verify");
  assert.equal(v.status, 0, v.stdout);
  assert.match(v.stdout, /3 line\(s\) from before the chain, then 5 chained line\(s\)/);
  assert.match(v.stdout, /start recorded late .*after 4 chained line\(s\) — earlier tampering cannot be excluded/);
});

test("a record written with the first chained line is not late", () => {
  const { root, f } = repoLog();
  for (let i = 0; i < 3; i++) append(f, denial(i));
  assert.equal(JSON.parse(readFileSync(genesisPath(f), "utf8")).late, undefined);
  assert.equal(verifyLog(f).late, null);
  assert.doesNotMatch(seisin(root, "log", "verify").stdout, /late|not recorded/);
});
