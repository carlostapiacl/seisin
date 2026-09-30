/**
 * Findings of the 2026-09-30 code review, one test each, so none comes back:
 * the log's legacy prefix, long lines, rotation, who stamps the time, the
 * walls tail, Slack's markup, the queue cache and the console's server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scratch } from "./_tmp.js";

import { append, read, readLines, verifyLog, verifyChain, logSegments, genesisPath } from "../src/log.js";
import { timesHit } from "../src/walls.js";
import { message } from "../src/notify.js";
import { record, settle, pending, requestsPath } from "../src/requests.js";
import { loadConfig } from "../src/config.js";
import { intake } from "../src/intake.js";

function logFile() {
  const dir = join(scratch("seisin-audit-"), ".seisin");
  mkdirSync(dir, { recursive: true });
  return join(dir, "log.jsonl");
}
const denial = (i) => ({ role: "r", action: "write", target: `t${i}`, verdict: "denied" });
const linesOf = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean);
const strip = (f) => writeFileSync(f, linesOf(f).map((l) => { const e = JSON.parse(l); delete e.prev; return JSON.stringify(e); }).join("\n") + "\n");

/* ── the legacy boundary ───────────────────────────────────────────────── */

test("stripping prev from every line, then editing one and deleting another, is broken — not a legacy prefix", () => {
  const f = logFile();
  for (let i = 0; i < 6; i++) append(f, denial(i));
  assert.ok(existsSync(genesisPath(f)), "the first chained append pins the genesis");
  strip(f);
  const ls = linesOf(f);
  ls[2] = ls[2].replace('"denied"', '"allowed"');
  ls.splice(4, 1);
  writeFileSync(f, ls.join("\n") + "\n");
  const r = verifyLog(f);
  assert.equal(r.genesis, "recorded");
  assert.ok(r.breaks.length >= 1, `said intact: ${JSON.stringify(r)}`);
});

test("a real-shaped log — legacy lines then chained ones — verifies intact before and after its genesis is recorded", () => {
  const f = logFile();
  writeFileSync(f, [1, 2, 3].map((d) => JSON.stringify({ at: `2026-09-0${d}T00:00:00Z`, role: "r", verdict: "denied" })).join("\n") + "\n");
  // Chained lines written by an older seisin: no genesis record beside them.
  let prev = null;
  for (const l of linesOf(f)) prev = l;
  for (let i = 0; i < 2; i++) {
    const line = JSON.stringify({ at: "2026-09-10T00:00:00Z", ...denial(i), prev: createHash("sha256").update(prev).digest("hex").slice(0, 32) });
    appendFileSync(f, line + "\n");
    prev = line;
  }
  let r = verifyLog(f);
  assert.deepEqual([r.unchained, r.chained, r.breaks.length, r.genesis], [3, 2, 0, "unrecorded"]);
  append(f, denial(9));
  r = verifyLog(f);
  assert.deepEqual([r.unchained, r.chained, r.breaks.length, r.genesis], [3, 3, 0, "recorded"]);
  assert.equal(JSON.parse(readFileSync(genesisPath(f), "utf8")).legacy, 3);
  // …and now stripping the chain off it shows.
  strip(f);
  assert.ok(verifyLog(f).breaks.length >= 1);
});

test("editing a legacy line is caught once the genesis is recorded", () => {
  const f = logFile();
  writeFileSync(f, [1, 2, 3].map((d) => JSON.stringify({ at: `2026-09-0${d}T00:00:00Z`, role: "r", verdict: "denied" })).join("\n") + "\n");
  append(f, denial(0));
  assert.deepEqual(verifyLog(f).breaks, []);
  const ls = linesOf(f);
  ls[0] = ls[0].replace('"denied"', '"allowed"');
  writeFileSync(f, ls.join("\n") + "\n");
  assert.ok(verifyLog(f).breaks.length >= 1);
});

test("a line without prev in a segment rotation started is a break, not legacy", () => {
  const f = logFile();
  const max = process.env.SEISIN_LOG_MAX_BYTES;
  process.env.SEISIN_LOG_MAX_BYTES = "1500";
  try { for (let i = 0; i < 40; i++) append(f, denial(i)); }
  finally { if (max === undefined) delete process.env.SEISIN_LOG_MAX_BYTES; else process.env.SEISIN_LOG_MAX_BYTES = max; }
  assert.ok(logSegments(f).length >= 2);
  assert.deepEqual(verifyLog(f).breaks, []);
  strip(f);                          // the current segment only
  assert.ok(verifyLog(f).breaks.length >= 1);
});

/* ── a line longer than the old 64 KB tail ─────────────────────────────── */

test("a line over 64 KB does not break the chain", () => {
  const f = logFile();
  append(f, denial(0));
  append(f, { ...denial(1), reason: "x".repeat(70 * 1024) });
  append(f, denial(2));
  append(f, denial(3));
  assert.deepEqual(verifyChain(f).breaks, []);
  assert.deepEqual(verifyLog(f).breaks, []);
});

/* ── rotation does not take the history with it ────────────────────────── */

test("read() spans every segment, and since skips the ones that ended before it", () => {
  const f = logFile();
  const max = process.env.SEISIN_LOG_MAX_BYTES;
  process.env.SEISIN_LOG_MAX_BYTES = "1500";
  try { for (let i = 0; i < 40; i++) append(f, denial(i)); }
  finally { if (max === undefined) delete process.env.SEISIN_LOG_MAX_BYTES; else process.env.SEISIN_LOG_MAX_BYTES = max; }
  assert.ok(logSegments(f).length >= 3);
  const all = read(f);
  assert.equal(all.length, 40);
  assert.deepEqual(all.map((e) => e.target), Array.from({ length: 40 }, (_, i) => `t${i}`));
  assert.deepEqual(read(f, { limit: 5 }).map((e) => e.target), ["t35", "t36", "t37", "t38", "t39"]);
  assert.equal(read(f, { since: "2999-01-01T00:00:00Z" }).length, 0);
  assert.equal(read(f, { since: "2000-01-01T00:00:00Z" }).length, 40);
});

/* ── the parent's clock ────────────────────────────────────────────────── */

function intakeRepo() {
  const dir = scratch("seisin-audit-intake-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.web]\nwrites = ["web/**"]\n\n[roles.api]\nwrites = ["api/**"]\n');
  return { dir, config: loadConfig(join(dir, "seisin.toml")) };
}
const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };

test("the confined process cannot set the time of its own lines", () => {
  const { dir, config } = intakeRepo();
  const take = intake({ config, role: "web", runId: "abcd1234-0", settings });
  const before = new Date().toISOString();
  take.fromHook("log", { at: "2001-01-01T00:00:00.000Z", tool: "Write", action: "write", target: "web/a.ts", verdict: "allowed" });
  take.fromHook("log", { at: "2999-01-01T00:00:00.000Z", tool: "x", action: "use", target: "mcp__s__t", verdict: "denied" });
  const got = read(join(dir, ".seisin", "log.jsonl"));
  assert.equal(got.length, 2);
  for (const e of got) assert.ok(e.at >= before && e.at <= new Date().toISOString(), `child time kept: ${e.at}`);
  // Nor through append() directly, nor for a request.
  append(join(dir, ".seisin", "log.jsonl"), { at: "2001-01-01T00:00:00.000Z", role: "web", verdict: "denied" });
  assert.ok(read(join(dir, ".seisin", "log.jsonl")).at(-1).at >= before);
  record(requestsPath(dir), { role: "web", action: "write", target: "api/x.ts", owners: ["api"], at: "2001-01-01T00:00:00Z" });
  assert.ok(pending(requestsPath(dir))[0].first >= before);
});

/* ── the walls tail, with multibyte text in it ─────────────────────────── */

test("timesHit counts every line of a tail full of multibyte text", () => {
  const f = logFile();
  const line = (i) => JSON.stringify({ at: "2026-09-20T10:00:00.000Z", role: "dev", action: "write", target: "diseño/año.md", verdict: "denied", reason: "ñ".repeat(i % 7) });
  writeFileSync(f, Array.from({ length: 50 }, (_, i) => line(i)).join("\n") + "\n");
  assert.equal(timesHit(f, "dev", "write", "diseño/año.md"), 50);
});

test("readLines with a tail keeps the first line when the cut is on a boundary, and drops a fragment", () => {
  const f = logFile();
  writeFileSync(f, "ñandú-1\nñandú-2\nñandú-3\n");
  const third = Buffer.byteLength("ñandú-3\n");
  assert.deepEqual(readLines(f, { tail: third }), ["ñandú-3"]);
  assert.deepEqual(readLines(f, { tail: third + 2 }), ["ñandú-3"]);
  assert.deepEqual(readLines(f, { tail: 1e9 }), ["ñandú-1", "ñandú-2", "ñandú-3"]);
});

/* ── Slack's markup is not the agent's to use ──────────────────────────── */

test("a slack message escapes & < > in what the agent chose", () => {
  const cfg = { root: "/repo" };
  const req = { role: "web", action: "write", target: "src/<https://evil.example|approve here>&<!channel>.ts", owners: ["api"] };
  const { body } = message(cfg, req, 1, "slack");
  const { text } = JSON.parse(body);
  assert.ok(!/[<>]/.test(text), text);
  assert.match(text, /&lt;https:\/\/evil\.example\|approve here&gt;&amp;&lt;!channel&gt;/);
  // The other formats are not Slack's and stay as they were.
  assert.match(message(cfg, req, 1, "text").body, /<https:\/\/evil/);
});

/* ── the queue, reduced once per change ────────────────────────────────── */

test("pending() is cached per file state, and one caller's marks do not leak into the next", () => {
  const dir = scratch("seisin-audit-q-");
  const file = requestsPath(dir);
  record(file, { role: "web", action: "write", target: "api/x.ts", owners: ["api"] });
  const a = pending(file);
  a[0].stale = { runs: 9 };
  assert.equal(pending(file)[0].stale, undefined);
  record(file, { role: "web", action: "write", target: "api/y.ts", owners: ["api"] });
  assert.equal(pending(file)[0].times, 2, "a new line is seen");
  settle(file, pending(file)[0].key, "denied");
  assert.equal(pending(file).length, 0);
  assert.equal(pending(file, { includeSettled: true })[0].state, "denied");
});
