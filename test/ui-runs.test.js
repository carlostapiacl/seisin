/**
 * `seisin ui --runs <dir>`: the console over a directory of archived runs, read
 * only (runs.js, docs/runs.md).
 *
 * Three runs made by hand — two executors of different teams and a reviewer,
 * one of them denied the network — and what the encargo asked of them: all
 * three listed, a team filter that leaves one, `&run=` opening that run, no
 * write anywhere, and `--link --json` for the launcher's panel.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { serve } from "../src/serve.js";
import { runsView, scanRuns, filtersOf, isRunId } from "../src/runs.js";
import { record } from "../src/requests.js";
import { writeUiLink, clearUiLink } from "../src/uilink.js";
import { boxed } from "./_tmp.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

const TOML = (role) => `[roles.${role}]\nwrites = ["src/**"]\n`;

function line(e) { return JSON.stringify({ at: "2026-10-26T10:00:00.000Z", ...e }) + "\n"; }

/** One run's folder, as a launcher archives it. */
function run(dir, id, { meta, role = "agent", log = [], request = null } = {}) {
  const root = join(dir, id);
  mkdirSync(join(root, ".seisin"), { recursive: true });
  writeFileSync(join(root, "seisin.toml"), TOML(role));
  if (meta !== undefined) writeFileSync(join(root, "run.json"), JSON.stringify(meta));
  writeFileSync(join(root, ".seisin", "log.jsonl"), log.map(line).join(""));
  if (request) record(join(root, ".seisin", "requests.jsonl"), request);
  return root;
}

function threeRuns() {
  const dir = boxed("ui-runs-");
  run(dir, "r-exec-a", {
    meta: { run_id: "r-exec-a", team: "compras", work_item: "WI-1", role: "executor", repo: "compras",
      started_at: "2026-10-26T09:00:00Z", ended_at: "2026-10-26T09:10:00Z", status: "done", launcher: "wapentake" },
    log: [
      { event: "canary", role: "agent", run: "a1", confined: true, reasons: [] },
      { role: "agent", source: "kernel", action: "connect", kind: "network", target: "api.example.com:443", verdict: "denied", owners: [] },
      { role: "agent", source: "kernel", action: "connect", kind: "network", target: "api.example.com:443", verdict: "denied", owners: [] },
      { role: "agent", source: "kernel", action: "write", kind: "file", target: "docs/x.md", verdict: "denied", owners: [] },
    ],
    request: { role: "agent", action: "write", target: "docs/x.md", owners: [] },
  });
  run(dir, "r-exec-b", {
    meta: { run_id: "r-exec-b", team: "pos", work_item: "WI-2", role: "executor", repo: "pos",
      started_at: "2026-10-26T08:00:00Z", status: "done" },
    log: [{ event: "canary", role: "agent", run: "b1", confined: true, reasons: [] },
      { role: "agent", source: "kernel", action: "write", kind: "file", target: "src/a.js", verdict: "allowed", owners: ["agent"] }],
  });
  run(dir, "r-review", {
    meta: { run_id: "r-review", team: "compras", work_item: "WI-1", role: "reviewer", repo: "compras",
      started_at: "2026-10-26T09:20:00Z", status: "failed" },
    log: [{ event: "canary", role: "agent", run: "c1", confined: true, reasons: [] },
      { role: "agent", source: "kernel", action: "write", kind: "file", target: "docs/x.md", verdict: "denied", owners: [] }],
  });
  return dir;
}

async function console_(dir) {
  const server = await serve(null, 0, { runsDir: dir });
  const port = server.address().port;
  const get = (path, opts = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts, headers: { "x-seisin-token": server.seisinToken, ...(opts.headers ?? {}) } });
  return { server, port, get };
}

test("every run is listed, newest first, with what it was denied", () => {
  const v = runsView(threeRuns());
  assert.equal(v.total, 3);
  assert.deepEqual(v.runs.map((r) => r.id), ["r-review", "r-exec-a", "r-exec-b"]);
  const a = v.runs.find((r) => r.id === "r-exec-a");
  assert.equal(a.outcome, "denied");
  assert.equal(a.denied, 3);
  assert.equal(a.byKind.network, 2);
  assert.deepEqual(a.hosts, [{ target: "api.example.com:443", times: 2 }]);
  assert.equal(a.retried, 1, "the second denial of the same host is a retry");
  assert.equal(v.runs.find((r) => r.id === "r-exec-b").outcome, "clean");
  // The same denial in two runs is one line, counted in both.
  const x = v.causes.find((c) => c.target === "docs/x.md");
  assert.equal(x.runs, 2);
  assert.deepEqual(x.roles.sort(), ["executor", "reviewer"]);
});

test("a filter by team leaves that team's runs, and the facets still show every team", () => {
  const dir = threeRuns();
  const pos = runsView(dir, filtersOf("team=pos"));
  assert.deepEqual(pos.runs.map((r) => r.id), ["r-exec-b"]);
  assert.equal(pos.totals.runs, 1);
  assert.deepEqual(pos.facets.team.map((f) => f.value).sort(), ["compras", "pos"]);
  assert.deepEqual(runsView(dir, filtersOf("team=compras&role=reviewer")).runs.map((r) => r.id), ["r-review"]);
  assert.deepEqual(runsView(dir, filtersOf("outcome=clean")).runs.map((r) => r.id), ["r-exec-b"]);
});

test("a run without run.json is still listed, and one without a policy says so", () => {
  const dir = threeRuns();
  run(dir, "bare", { log: [{ role: "agent", action: "write", kind: "file", target: "x", verdict: "denied" }] });
  mkdirSync(join(dir, "empty"));
  mkdirSync(join(dir, "no-log"));
  writeFileSync(join(dir, "no-log", "seisin.toml"), TOML("agent"));
  writeFileSync(join(dir, "stray.txt"), "not a run");
  const v = runsView(dir);
  const bare = v.runs.find((r) => r.id === "bare");
  assert.equal(bare.meta, false);
  assert.equal(bare.run_id, "bare", "the folder name stands for the run id");
  assert.equal(bare.outcome, "denied");
  assert.equal(v.runs.find((r) => r.id === "empty").outcome, "unread");
  assert.equal(v.runs.find((r) => r.id === "no-log").outcome, "clean");
  assert.equal(v.total, 6, "a file beside the runs is not a run");
});

test("a run that moved is read again; one that did not is not", () => {
  const dir = threeRuns();
  const first = scanRuns(dir).runs.find((r) => r.id === "r-exec-b");
  assert.equal(scanRuns(dir).runs.find((r) => r.id === "r-exec-b"), first, "the same object: not re-read");
  writeFileSync(join(dir, "r-exec-b", ".seisin", "log.jsonl"),
    line({ role: "agent", action: "write", kind: "file", target: "y", verdict: "denied" }), { flag: "a" });
  assert.equal(scanRuns(dir).runs.find((r) => r.id === "r-exec-b").denied, 1);
});

test("run ids are folder names, nothing that walks out of the directory", () => {
  for (const ok of ["r-1", "01M5VAEQ", "a.b_c"]) assert.ok(isRunId(ok), ok);
  for (const no of ["..", ".", "../x", "a/b", "", ".hidden", "a b"]) assert.ok(!isRunId(no), no);
});

test("the server lists the runs, filters them, and opens one by id", async () => {
  const dir = threeRuns();
  const { server, get } = await console_(dir);
  try {
    assert.deepEqual(await (await get("/api/info")).json(), { mode: "runs", dir, readOnly: true });
    const all = await (await get("/api/runs")).json();
    assert.equal(all.runs.length, 3);
    const pos = await (await get("/api/runs?team=pos")).json();
    assert.deepEqual(pos.runs.map((r) => r.id), ["r-exec-b"]);
    const one = await (await get("/api/run?run=r-exec-a")).json();
    assert.equal(one.readOnly, true);
    assert.equal(one.run.team, "compras");
    assert.equal(one.config, join(dir, "r-exec-a", "seisin.toml"));
    assert.equal(one.requests.length, 1, "its queue is shown, to be asked for elsewhere");
    assert.equal((await get("/api/run?run=..%2Fr-exec-a")).status, 400);
    assert.equal((await get("/api/run?run=nope")).status, 404);
    assert.equal((await get("/api/state")).status, 404, "there is no one policy here");
    // A poll that already has the answer gets a 304.
    const r = await get("/api/runs");
    assert.equal((await get("/api/runs", { headers: { "if-none-match": r.headers.get("etag") } })).status, 304);
    // No token, nothing — as in the console over one policy.
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/runs`)).status, 403);
  } finally { server.close(); }
});

test("nothing is written over runs: every write is a 405, and the files stay as they were", async () => {
  const dir = threeRuns();
  const before = readFileSync(join(dir, "r-exec-a", "seisin.toml"), "utf8");
  const queue = readFileSync(join(dir, "r-exec-a", ".seisin", "requests.jsonl"), "utf8");
  const { server, get } = await console_(dir);
  try {
    const key = (await (await get("/api/run?run=r-exec-a")).json()).requests[0].key;
    for (const path of ["/api/decide", "/api/decline-all", "/api/control-files", "/api/runs"]) {
      const r = await get(path, { method: "POST", body: JSON.stringify({ key, keys: [key], decision: "granted", reason: "x" }) });
      assert.equal(r.status, 405, path);
      assert.match((await r.json()).error, /read only/);
    }
  } finally { server.close(); }
  assert.equal(readFileSync(join(dir, "r-exec-a", "seisin.toml"), "utf8"), before);
  assert.equal(readFileSync(join(dir, "r-exec-a", ".seisin", "requests.jsonl"), "utf8"), queue);
});

test("the page draws no grant over runs: the buttons are behind the read-only switch", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "src", "console.js"), "utf8");
  // Grant and Decline are only in the branch READONLY does not take, and the run link survives the token's removal.
  assert.match(src, /\(READONLY\s*\n\s*\? '<div class="act ro-ask">'/);
  assert.match(src, /bulk\.hidden = REQS\.length < 2 \|\| READONLY;/);
  assert.match(src, /\?run=" \+ encodeURIComponent\(RUN\)/);
});

test("ui --runs --link --json prints the running console's link, or that none is running, and opens nothing", () => {
  const dir = threeRuns();
  const port = 4790 + Math.floor(Math.random() * 100);
  const cli = (...args) => spawnSync(process.execPath, [CLI, "ui", "--runs", dir, "--port", String(port), ...args], { encoding: "utf8" });
  clearUiLink(port);
  const none = cli("--link", "--json");
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), { running: false, port });
  const url = `http://127.0.0.1:${port}/#t=${"ab".repeat(24)}`;
  writeUiLink(port, url, undefined, null, { mode: "runs", dir });
  try {
    const got = cli("--link", "--json");
    assert.equal(got.status, 0, got.stderr);
    assert.deepEqual(JSON.parse(got.stdout), { running: true, url, port, mode: "runs", dir });
    assert.equal(got.stderr, "", "the token goes to stdout once, nowhere else");
  } finally { clearUiLink(port); }
});

test("ui --runs refuses a directory that is not there", () => {
  const r = spawnSync(process.execPath, [CLI, "ui", "--runs", join(boxed("ui-runs-none-"), "missing")], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /not a directory/);
});

test("without --runs the console is the one it was: one policy, and its writes", async () => {
  const box = boxed("ui-runs-policy-");
  writeFileSync(join(box, "seisin.toml"), TOML("dev"));
  const server = await serve(join(box, "seisin.toml"), 0);
  const port = server.address().port;
  const h = { "x-seisin-token": server.seisinToken };
  try {
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/info`, { headers: h })).json()).mode, "policy");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: h })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/runs`, { headers: h })).status, 404);
    const r = await fetch(`http://127.0.0.1:${port}/api/decide`, { method: "POST", headers: h, body: "{}" });
    assert.equal(r.status, 400, "a decision is still taken — this one is just missing its key");
  } finally { server.close(); }
});

test("a run whose system log dropped kernel messages says its record is incomplete; macOS housekeeping counts as expected", () => {
  const dir = boxed("ui-runs-dropped-");
  run(dir, "r-lost", {
    log: [
      { event: "canary", role: "agent", run: "l1", confined: true, reasons: [] },
      { role: "agent", source: "kernel", action: "ipc-posix-shm-read-data", kind: "system", target: "apple.shm.notification_center", verdict: "denied", owners: [] },
      { role: "agent", source: "kernel", action: "sysctl-write", kind: "system", target: "kern.tcsm_enable", verdict: "denied", owners: [] },
      { event: "log-dropped", role: "agent", run: "l1", batches: 3 },
      { event: "log-dropped", role: "agent", run: "l1", batches: 2 },
    ],
  });
  run(dir, "r-whole", { log: [{ event: "canary", role: "agent", run: "w1", confined: true, reasons: [] }] });
  const v = runsView(dir);
  const lost = v.runs.find((r) => r.id === "r-lost");
  assert.equal(lost.dropped, 5);
  assert.equal(lost.expected, 2);
  assert.equal(lost.outcome, "clean");
  assert.equal(v.runs.find((r) => r.id === "r-whole").dropped, 0);
  assert.equal(v.totals.incomplete, 1);
});
