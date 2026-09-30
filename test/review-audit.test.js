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

/* ── the console's server ──────────────────────────────────────────────── */

async function console_(t) {
  const { serve } = await import("../src/serve.js");
  const box = scratch("seisin-audit-ui-");
  writeFileSync(join(box, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n[network]\nallow = ["example.org"]\n\n[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\nkeys   = []\n');
  const q = requestsPath(box);
  record(q, { role: "frontend", action: "write", target: "src/api/checkout/a.ts", owners: ["backend"] });
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { "x-seisin-token": server.seisinToken };
  const get = (path, headers = {}) => fetch(base + path, { headers: { ...auth, ...headers } });
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
  return { box, q, base, auth, get, post, key: pending(q)[0].key };
}

test("the poll carries no settings; one role's are served on demand, with the token", async (t) => {
  const { get, base } = await console_(t);
  const s = await (await get("/api/state")).json();
  assert.ok(s.roles.every((r) => !("settings" in r)), "settings are back in the poll");
  const { settingsFor } = await import("../src/srt.js");
  const one = await get("/api/settings?role=frontend");
  assert.equal(one.status, 200);
  const body = await one.json();
  assert.equal(body.role, "frontend");
  assert.deepEqual(body.settings, settingsFor(loadConfig(s.config), "frontend"));
  assert.ok(JSON.stringify(body.settings).includes("example.org"), "the policy's domains, not a hand-built github.com");
  assert.equal((await get("/api/settings?role=nobody")).status, 404);
  assert.equal((await get("/api/settings?role=__proto__")).status, 404);
  assert.equal((await fetch(base + "/api/settings?role=frontend")).status, 403);
});

test("an unchanged state answers 304 to its own tag, and a change is a new tag", async (t) => {
  const { get, q } = await console_(t);
  const first = await get("/api/state");
  const tag = first.headers.get("etag");
  assert.ok(tag);
  assert.equal((await get("/api/state", { "if-none-match": tag })).status, 304);
  record(q, { role: "backend", action: "write", target: "src/web/x.ts", owners: ["frontend"] });
  const next = await get("/api/state", { "if-none-match": tag });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).requests.length, 2);
});

test("HEAD on the API is refused, not computed", async (t) => {
  const { base, auth } = await console_(t);
  const r = await fetch(base + "/api/state", { method: "HEAD", headers: auth });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
});

test("a body over the cap gets a 413 before the connection closes", async (t) => {
  const { post } = await console_(t);
  const r = await post("/api/decide", JSON.stringify({ key: "x", decision: "denied", reason: "y".repeat(8000) }));
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /too large/);
});

test("a decision the policy file cannot take is a 500; a bad one is a 400", async (t) => {
  const { chmodSync } = await import("node:fs");
  const { post, box, key, q } = await console_(t);
  assert.equal((await post("/api/decide", "{not json")).status, 400);
  assert.equal((await post("/api/decide", JSON.stringify({ key, decision: "maybe" }))).status, 400);
  // The directory the policy lives in cannot be written: no lock, no temp file.
  chmodSync(box, 0o555);
  try {
    const r = await post("/api/decide", JSON.stringify({ key, decision: "granted" }));
    assert.equal(r.status, 500, await r.text());
  } finally { chmodSync(box, 0o755); }
  assert.equal(pending(q).length, 1, "the request is still open: nothing was written");
});

test("a decision is looked up, applied and settled under the policy lock", async (t) => {
  const { spawn } = await import("node:child_process");
  const { post, box, key, q } = await console_(t);
  const policy = join(box, "seisin.toml");
  // Another process — a `seisin grant` or `decline` in a terminal — holds the
  // policy lock and declines the request while holding it. The console must
  // look the request up after that, not before.
  const log = new URL("../src/log.js", import.meta.url).href;
  const reqs = new URL("../src/requests.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { withLock } from ${JSON.stringify(log)}; import { settle } from ${JSON.stringify(reqs)};
     withLock(${JSON.stringify(policy)}, () => {
       process.stdout.write("locked\\n");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
       settle(${JSON.stringify(q)}, ${JSON.stringify(key)}, "denied", "the other channel");
     });`]);
  await new Promise((ok) => child.stdout.once("data", ok));
  const r = await post("/api/decide", JSON.stringify({ key, decision: "granted", reason: "r" }));
  await new Promise((ok) => child.once("close", ok));
  assert.equal(r.status, 400, "the request had been settled by the lock holder");
  assert.ok(!readFileSync(policy, "utf8").includes("checkout"), "granted what the other channel declined");
});

/* ── the MCP shares the console's arithmetic, and reads the log once ───── */

test("seisin_walls without a role equals asking role by role", async () => {
  const { HANDLERS } = await import("../src/mcp.js");
  const { walls } = await import("../src/walls.js");
  const dir = scratch("seisin-audit-mcp-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.a]\nwrites = ["src/**"]\n\n[roles.b]\nwrites = ["deploy/**"]\n');
  mkdirSync(join(dir, ".seisin"));
  const d = (role, target) => JSON.stringify({ at: "2026-09-28T10:00:00.000Z", role, action: "write", target, verdict: "denied", owners: [] });
  writeFileSync(join(dir, ".seisin", "log.jsonl"),
    [d("a", "deploy/x"), d("a", "deploy/x"), d("a", "deploy/x"), d("b", "src/y"), d("b", "src/y"), d("b", "lib/z")].join("\n") + "\n");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const every = HANDLERS.seisin_walls({});
    const cfg = loadConfig(join(dir, "seisin.toml"));
    for (const r of ["a", "b"]) {
      assert.deepEqual(every.roles[r].walls, walls(cfg, r, { file: join(dir, ".seisin", "log.jsonl") }));
      assert.deepEqual(HANDLERS.seisin_walls({ role: r }).roles[r], every.roles[r]);
    }
    assert.equal(every.spentRetrying, 3);
  } finally { process.chdir(cwd); }
});

test("the MCP server no longer loads node:http to answer", async () => {
  const src = readFileSync(new URL("../src/mcp.js", import.meta.url), "utf8");
  assert.ok(!/from "\.\/serve\.js"/.test(src));
  assert.ok(!/grantFor/.test(src));
});
