/**
 * Pre-release review of 0.5.0, second pass: the scan that went blind at a
 * folder of projects, the genesis record that outlived its log, and the run
 * that called its own orphaned child a stranger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { scan, insideRepo } from "../src/scan.js";
import { append, verifyLog, genesisPath } from "../src/log.js";
import { renderScan } from "../src/render.js";
import { CLI, scratch } from "./_tmp.js";

const seisin = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
const TOKEN = (c) => "ghp_" + c.repeat(36) + "\n";

/* ── scan: nested checkouts ──────────────────────────────────────────── */

// A folder of projects that is not itself a repository — the portfolio root.
function projects() {
  const box = scratch("seisin-scan-");
  assert.equal(insideRepo(box), false, "the scratch dir must not sit inside a checkout");
  mkdirSync(join(box, "app", ".git"), { recursive: true });
  writeFileSync(join(box, "app", "k.txt"), TOKEN("A"));
  mkdirSync(join(box, "wt"));
  writeFileSync(join(box, "wt", ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(box, "wt", "k.txt"), TOKEN("B"));
  writeFileSync(join(box, "seisin.toml"), `[roles.dev]\nwrites = ["app/**"]\n`);
  return box;
}

test("scan walks the checkouts when the root is not a repository", () => {
  const { hits, skipped, nestedPaths } = scan(projects(), []);
  assert.deepEqual(hits.map((h) => h.file).sort(), ["app/k.txt", "wt/k.txt"]);
  assert.equal(skipped.nested, 0);
  assert.deepEqual(nestedPaths, []);
});

test("scan still prunes checkouts nested inside a repository, and names them", () => {
  const box = projects();
  mkdirSync(join(box, ".git"));
  const { hits, skipped, nestedPaths } = scan(box, []);
  assert.deepEqual(hits, []);
  assert.equal(skipped.nested, 2);
  assert.deepEqual(nestedPaths.sort(), ["app", "wt"]);
  // …and from a subdirectory of that repository, too: its root is still inside one.
  mkdirSync(join(box, "sub", "inner", ".git"), { recursive: true });
  assert.equal(scan(join(box, "sub"), []).skipped.nested, 1);
});

test("a scan with pruned checkouts does not read as clean", () => {
  const text = renderScan({ certain: [], review: [], links: [], skipped: { nested: 2 }, nestedPaths: ["app", "wt"] }, []);
  assert.doesNotMatch(text, /nothing credential-shaped outside the declared directories/);
  assert.match(text, /nothing credential-shaped in what was scanned/);
  assert.match(text, /not scanned: 2 nested checkout\(s\)/);
  assert.match(text, /cd <dir> && seisin scan/);
  assert.match(text, /\n {4}app\n {4}wt\n/);
});

test("the CLI fails on a certain hit inside a checkout under a non-repo root", () => {
  const r = seisin(projects(), "scan");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /2 credential\(s\)/);
  assert.doesNotMatch(r.stdout, /not scanned/);
});

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
