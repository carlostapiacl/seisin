/**
 * Pre-release review of 0.5.0, second pass: the scan that went blind at a
 * folder of projects, the genesis record that outlived its log, and the run
 * that called its own orphaned child a stranger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan, insideRepo } from "../src/scan.js";
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
