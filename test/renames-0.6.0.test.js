/**
 * The 0.6.0 renames, each made at the root: one name in the code, and the old
 * one stopped with a sentence wherever a person or a file can still carry it.
 *
 *   stillRefused             → stillDenied       (MCP seisin_causes, the console)
 *   requests.jsonl "denied"  → "declined"        (a person's decline; migrated once)
 *   key_mode = "scratch"     → "run-file"        (refused at load, with the change to make)
 *   seisin deny              → seisin decline    (removed; says what to type)
 *   docs/permission-requests.md → docs/requests.md
 *
 * docs/glossary.md says why each word; docs/decisions.md why the queue is
 * rewritten once instead of read both ways.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { causesOf } from "../src/views.js";
import { queue } from "../src/views.js";
import { HANDLERS } from "../src/mcp.js";
import { loadConfig } from "../src/config.js";
import { MODES } from "../src/keys.js";
import { pending, record, settle, migrateQueue, requestsPath } from "../src/requests.js";
import { scratch, CLI } from "./_tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── stillDenied ───────────────────────────────────────────────────────────

test("a cause counts the roles the boundary still denies as stillDenied", () => {
  const cfg = {
    root: "/repo", keyDirs: [],
    roles: { a: { name: "a", writes: ["src/**"], keys: [], keyEntries: [] } },
  };
  const [c] = causesOf(cfg, [{ role: "a", action: "write", target: "deploy/x.yml", verdict: "denied", owners: [] }]).causes;
  assert.equal(c.stillDenied, 1);
  assert.ok(!("stillRefused" in c));
});

// ── "declined" in the queue, and the one migration ────────────────────────

/** A queue as seisin 0.5 wrote it: an ask, a decline as "denied", a grant, a torn line. */
function oldQueue() {
  const dir = scratch("seisin-rename-");
  mkdirSync(join(dir, ".seisin"));
  const f = join(dir, ".seisin", "requests.jsonl");
  const lines = [
    { at: "2026-10-01T00:00:00.000Z", kind: "asked", key: "web:write:api", role: "web", action: "write", target: "api/x.ts", owners: ["api"] },
    { at: "2026-10-01T00:01:00.000Z", kind: "denied", key: "web:write:api", reason: "not theirs" },
    { at: "2026-10-01T00:02:00.000Z", kind: "asked", key: "web:write:docs", role: "web", action: "write", target: "docs/a.md", owners: [] },
    { at: "2026-10-01T00:03:00.000Z", kind: "granted", key: "web:write:docs", reason: "fine" },
    { at: "2026-10-01T00:04:00.000Z", kind: "asked", key: "web:write:lib", role: "web", action: "write", target: "lib/b.ts", owners: [] },
    { at: "2026-10-01T00:05:00.000Z", kind: "denied", key: "web:write:lib", reason: "later" },
  ].map((l) => JSON.stringify(l));
  const text = lines.slice(0, 3).join("\n") + "\n{not json\n" + lines.slice(3).join("\n") + "\n";
  writeFileSync(f, text);
  return { dir, f, text };
}

test("a decline is stored as \"declined\"", () => {
  const f = join(scratch("seisin-rename-"), "requests.jsonl");
  record(f, { role: "qa", action: "write", target: "docs/x.md", owners: [] });
  settle(f, pending(f)[0].key, "declined", "no");
  assert.equal(JSON.parse(readFileSync(f, "utf8").trim().split("\n").at(-1)).kind, "declined");
  assert.equal(pending(f, { includeSettled: true })[0].state, "declined");
});

test("opening an old queue rewrites its declines once, keeps every line, and keeps the original", () => {
  const { f, text } = oldQueue();
  const all = pending(f, { includeSettled: true });
  assert.deepEqual(all.map((r) => [r.key, r.state]),
    [["web:write:api", "declined"], ["web:write:docs", "granted"], ["web:write:lib", "declined"]]);

  const now = readFileSync(f, "utf8");
  const before = text.split("\n"), after = now.split("\n");
  assert.equal(after.length, before.length, "no line lost, none added");
  for (let i = 0; i < before.length; i++) {
    if (before[i].includes('"kind":"denied"')) assert.equal(after[i], before[i].replace('"kind":"denied"', '"kind":"declined"'), `line ${i + 1}`);
    else assert.equal(after[i], before[i], `line ${i + 1} is byte for byte, the torn one too`);
  }
  assert.ok(!now.includes('"kind":"denied"'));
  assert.equal(readFileSync(`${f}.pre-0.6.0`, "utf8"), text, "the original, word for word");

  // Idempotent: nothing left to rewrite, nothing rewritten, no second copy.
  assert.equal(migrateQueue(f), 0);
  assert.equal(readFileSync(f, "utf8"), now);
  pending(f, { includeSettled: true });
  assert.deepEqual(readdirSync(dirname(f)).filter((n) => n.startsWith("requests.jsonl.pre")), ["requests.jsonl.pre-0.6.0"]);
  assert.ok(!readdirSync(dirname(f)).some((n) => n.startsWith(".requests.migrate-")), "no temporary left");
});

test("a decline an older seisin writes later is migrated too, beside the first copy", () => {
  const { f } = oldQueue();
  pending(f);
  appendFileSync(f, JSON.stringify({ at: "2026-10-02T00:00:00.000Z", kind: "denied", key: "web:write:docs", reason: "x" }) + "\n");
  assert.equal(migrateQueue(f), 1);
  assert.ok(!readFileSync(f, "utf8").includes('"kind":"denied"'));
  assert.equal(readdirSync(dirname(f)).filter((n) => n.startsWith("requests.jsonl.pre-0.6.0")).length, 2);
});

test("the read-only MCP server does not rewrite an old queue: it says what to run", () => {
  const { dir, f, text } = oldQueue();
  writeFileSync(join(dir, "seisin.toml"), '[roles.web]\nwrites = ["web/**"]\n');
  assert.throws(() => queue({ root: dir, roles: {} }, [], { readOnly: true }), (e) =>
    e.code === "EQUEUEFORMAT" && /2 declines written by seisin before 0\.6\.0/.test(e.message) && /seisin requests/.test(e.message));
  const cwd = process.cwd();
  process.chdir(dir);
  try { assert.throws(() => HANDLERS.seisin_requests(), /seisin requests/); }
  finally { process.chdir(cwd); }
  assert.equal(readFileSync(f, "utf8"), text, "untouched");
  assert.ok(!existsSync(`${f}.pre-0.6.0`));
});

test("`seisin requests` migrates the queue a person opens", () => {
  const { dir, f } = oldQueue();
  writeFileSync(join(dir, "seisin.toml"), '[roles.web]\nwrites = ["web/**"]\n');
  const r = spawnSync(process.execPath, [CLI, "requests"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!readFileSync(f, "utf8").includes('"kind":"denied"'));
  assert.equal(requestsPath(dir), f);
});

test("lines appended while the queue is migrated are all kept", async () => {
  // Every line seisin appends takes the queue's lock, and so does the rewrite.
  // A writer appends asks and declines spelled the old way as fast as it can
  // while this process migrates over and over; every line it wrote must be there.
  const { f, text } = oldQueue();
  const N = 2000;
  const requestsJs = JSON.stringify(new URL("../src/requests.js", import.meta.url).href);
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `
    const { record, settle } = await import(${requestsJs});
    for (let i = 0; i < ${N}; i++)
      if (i % 2) settle(${JSON.stringify(f)}, "k" + i, "denied", "r");
      else record(${JSON.stringify(f)}, { role: "web", action: "write", target: "x/" + i, owners: [] });
  `], { stdio: "inherit" });
  const done = new Promise((ok) => writer.on("exit", ok));
  let finished = false;
  done.then(() => { finished = true; });
  let migrations = 0;
  while (!finished) {
    migrations += migrateQueue(f) > 0 ? 1 : 0;
    await new Promise((ok) => setImmediate(ok));
  }
  migrateQueue(f);
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, text.split("\n").filter(Boolean).length + N);
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const declined = new Set(parsed.filter((e) => e?.kind === "declined").map((e) => e.key));
  for (let i = 1; i < N; i += 2) assert.ok(declined.has("k" + i), `k${i} kept, as declined`);
  assert.equal(parsed.filter((e) => e?.kind === "asked" && e.target?.startsWith("x/")).length, N / 2);
  assert.ok(!lines.some((l) => l.includes('"kind":"denied"')));
  assert.ok(migrations > 1, `migrated while the writer ran (${migrations})`);
});

// ── key_mode = "run-file" ─────────────────────────────────────────────────

test("key_mode = \"scratch\" is refused with the one line to change; \"run-file\" loads", () => {
  assert.deepEqual(MODES, ["env", "run-file", "inject"]);
  const dir = scratch("seisin-rename-");
  const p = join(dir, "seisin.toml");
  writeFileSync(p, '[roles.r]\nwrites = []\nkeys = ["A=file://t.txt"]\nkey_mode = "scratch"\n');
  assert.throws(() => loadConfig(p), /roles\.r: key_mode = "scratch" was renamed "run-file" in seisin 0\.6\.0[\s\S]*Change it to key_mode = "run-file"/);
  writeFileSync(p, '[keys.providers.p]\ncommand = ["x", "{ref}"]\nmode = "scratch"\n\n[roles.r]\nwrites = []\n');
  assert.throws(() => loadConfig(p), /\[keys\.providers\.p\] mode = "scratch" was renamed "run-file"[\s\S]*Change it to mode = "run-file"/);
  writeFileSync(p, '[roles.r]\nwrites = []\nkeys = ["A=file://t.txt"]\nkey_mode = "run-file"\n');
  assert.equal(loadConfig(p).roles.r.keyMode, "run-file");
});

// ── seisin decline ────────────────────────────────────────────────────────

test("`seisin deny` is gone, and says what to type instead", () => {
  const dir = scratch("seisin-rename-");
  const r = spawnSync(process.execPath, [CLI, "deny", "1"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /removed in 0\.6\.0[\s\S]*seisin decline <n\|id>/);
  const help = spawnSync(process.execPath, [CLI, "--help"], { cwd: dir, encoding: "utf8" });
  assert.doesNotMatch(help.stdout, /seisin deny/);
});

// ── docs/requests.md, and no old name left behind ─────────────────────────

test("the old names are gone from the code and the docs", () => {
  assert.ok(existsSync(join(ROOT, "docs", "requests.md")));
  assert.ok(!existsSync(join(ROOT, "docs", "permission-requests.md")));
  const OLD = /permission-requests|stillRefused|key_mode = "scratch"|mode = "scratch"|\bseisin deny\b/;
  // Where the rename itself is explained: the changelog, the glossary's table,
  // the decision, the errors that name the old value, and this file.
  const EXPLAINS = new Set(["CHANGELOG.md", "docs/glossary.md", "docs/decisions.md", "src/cli.js", "src/keys.js", "test/renames-0.6.0.test.js", "test/words.test.js"]);
  const hits = [];
  const walk = (rel) => {
    for (const d of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!["node_modules", ".git", ".sandbox-box", "reviews"].includes(d.name)) walk(r); continue; }
      if (!/\.(js|md|html|ts|css|json)$/.test(d.name) || EXPLAINS.has(r)) continue;
      readFileSync(join(ROOT, r), "utf8").split("\n").forEach((l, i) => { if (OLD.test(l)) hits.push(`${r}:${i + 1}`); });
    }
  };
  for (const top of ["src", "test", "docs", "ui", "site"]) if (existsSync(join(ROOT, top))) walk(top);
  for (const f of ["README.md", "CONTRIBUTING.md"]) if (OLD.test(readFileSync(join(ROOT, f), "utf8"))) hits.push(f);
  assert.deepEqual(hits, []);
});
