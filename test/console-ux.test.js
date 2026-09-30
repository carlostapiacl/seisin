/**
 * The console as a person meets it: what the server insists on before a
 * decision is written, what it hands back so the page can say what changed,
 * and static checks on the page for the things a reviewer found it getting
 * wrong (a grant that widened without saying so, a live table that looked
 * editable, two screens that gave opposite advice about one path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxed } from "./_tmp.js";

import { serve, lineDiff } from "../src/serve.js";
import { record, requestsPath, pending } from "../src/requests.js";
import { append, logPath } from "../src/log.js";
import { KINDS } from "../src/kinds.js";

const POLICY =
  '# the shop\n[keys]\ndir = ".secrets"\n\n' +
  '[roles.frontend]\nwrites = ["src/web/**"]\nkeys = []\n\n' +
  '[roles.backend]\nwrites = ["src/api/**"]\nkeys = []\n\n' +
  '[roles.qa]\nwrites = ["tests/**"]\nkeys = []\n';

async function shop(t, { log = [] } = {}) {
  const box = boxed("seisin-ux-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  mkdirSync(join(box, ".seisin"), { recursive: true });
  for (const d of ["src/web/.vscode", "src/api/.vscode"]) mkdirSync(join(box, d), { recursive: true });
  const q = requestsPath(box);
  record(q, { role: "backend", action: "write", target: "docs/api.md", owners: [] });
  record(q, { role: "frontend", action: "write", target: "src/api/routes.ts", owners: ["backend"] });
  for (const e of log) append(logPath(box), { run: "r1", tool: "Write", reason: "", owners: [], ...e });
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const port = server.address().port;
  const token = server.seisinToken;
  const call = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-seisin-token": token },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const keyOf = (target) => pending(q).find((r) => r.target === target).key;
  const toml = () => readFileSync(join(box, "seisin.toml"), "utf8");
  return { box, q, call, keyOf, toml };
}

/* ── a decision needs a reason ─────────────────────────────────────────── */

test("approving without a reason is refused and writes nothing", async (t) => {
  const { call, keyOf, toml, q } = await shop(t);
  for (const reason of [undefined, "", "   ", "\n\t"]) {
    const r = await call("/api/decide", { key: keyOf("docs/api.md"), decision: "granted", ...(reason !== undefined && { reason }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /reason is required/);
  }
  assert.equal(toml(), POLICY, "the policy moved");
  assert.equal(pending(q).length, 2, "a request was settled");
});

test("declining without a reason is refused too, one or all", async (t) => {
  const { call, keyOf, q } = await shop(t);
  assert.equal((await call("/api/decide", { key: keyOf("docs/api.md"), decision: "denied" })).status, 400);
  assert.equal((await call("/api/decline-all", { keys: pending(q).map((r) => r.key) })).status, 400);
  assert.equal((await call("/api/decline-all", { keys: pending(q).map((r) => r.key), reason: " " })).status, 400);
  assert.equal(pending(q).length, 2);
  const ok = await call("/api/decline-all", { keys: pending(q).map((r) => r.key), reason: "noise from a fixed bug" });
  assert.equal(ok.status, 200);
  assert.equal(pending(q).length, 0);
});

test("an approval answers with the line it wrote and where", async (t) => {
  const { call, keyOf, toml } = await shop(t);
  const r = await call("/api/decide", { key: keyOf("docs/api.md"), decision: "granted", reason: "backend keeps the API docs" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.grant, "docs/**", "a request keyed by folder grants the folder");
  assert.ok(out.line, "no line in the answer");
  const lines = toml().split("\n");
  assert.equal(lines[out.line.number - 1].trim(), out.line.text);
  assert.match(out.line.text, /^"docs\/\*\*"\s+# granted .*«backend keeps the API docs»$/);
});

test("a refusal answers with no line: nothing was written", async (t) => {
  const { call, keyOf, toml } = await shop(t);
  const out = await (await call("/api/decide", { key: keyOf("docs/api.md"), decision: "denied", reason: "not backend's" })).json();
  assert.equal(out.line, null);
  assert.equal(toml(), POLICY);
});

test("the token is still demanded before the reason is looked at", async (t) => {
  const { box } = await shop(t);
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/decide`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "x", decision: "granted", reason: "r" }),
  });
  assert.equal(r.status, 403);
});

/* ── the control-files preview names the line and the roles it misses ── */

test("a control-files preview carries the exact line and the roles it leaves alone", async (t) => {
  const { call, toml } = await shop(t);
  const plan = await (await call("/api/control-files", { role: "frontend", families: ["ide"], dryRun: true })).json();
  assert.equal(plan.dryRun, true);
  assert.equal(plan.lines.removed.length, 0);
  assert.equal(plan.lines.added.length, 1);
  assert.match(plan.lines.added[0], /^control_files = \["ide"\]/);
  assert.deepEqual(plan.unaffected, [], "frontend holds a .vscode, so its profile moves");
  assert.equal(toml(), POLICY, "a preview wrote");

  const glob = await (await call("/api/control-files", { protect: true, dryRun: true })).json();
  assert.ok(glob.lines.added.some((l) => /instructions = true/.test(l)));
  // qa's territory holds no project, so its profile does not move — and it is named.
  assert.ok(glob.unaffected.includes("qa"), JSON.stringify(glob.unaffected));

  const saved = await (await call("/api/control-files", { role: "frontend", families: ["ide"], base: plan.base, reason: "launch configs" })).json();
  assert.equal(saved.dryRun, false);
  const lines = toml().split("\n");
  assert.equal(lines[saved.lines.at - 1], saved.lines.added[0], "the line number points at the line");
});

test("lineDiff finds the one place an edit moved", () => {
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\nb\nB\nc\n"), { at: 3, removed: [], added: ["B"] });
  assert.deepEqual(lineDiff("a\nx\nc", "a\ny\nc"), { at: 2, removed: ["x"], added: ["y"] });
  assert.deepEqual(lineDiff("same", "same"), { at: 2, removed: [], added: [] });
});

/* ── walls and denied say the same thing about one path ────────────────── */

const LOG = [
  ...Array(3).fill({ role: "qa", action: "write", kind: "file", target: ".env.local", verdict: "denied" }),
  ...Array(2).fill({ role: "frontend", action: "write", kind: "file", target: "dist/index.html", verdict: "denied" }),
  ...Array(2).fill({ role: "backend", action: "connect", kind: "network", target: "db.internal:5432", verdict: "denied" }),
  ...Array(2).fill({ role: "qa", action: "use", kind: "tool", target: "mcp__github__create_issue", verdict: "denied" }),
  ...Array(2).fill({ role: "frontend", action: "write", kind: "file", target: "src/api/routes.ts", verdict: "denied", owners: ["backend"] }),
];

test("a wall on an unowned path carries the kind and hint Denied gives it", async (t) => {
  const { call } = await shop(t, { log: LOG });
  const s = await (await call("/api/state")).json();
  const env = s.walls.qa.find((w) => w.target === ".env.local");
  assert.equal(env.kind, "credential");
  assert.equal(env.hint, KINDS.credential);
  const denied = s.causes.causes.find((c) => c.target === ".env.local");
  assert.equal(denied.kind, env.kind, "the two screens disagree about .env.local");
  assert.equal(denied.hint, env.hint);
  assert.equal(s.walls.frontend.find((w) => w.target === "dist/index.html").kind, "build");
  // An owned wall gets no kind: it is somebody's, and the owner is the news.
  const owned = s.walls.frontend.find((w) => w.target === "src/api/routes.ts");
  assert.deepEqual(owned.owners, ["backend"]);
  assert.equal(owned.kind, undefined);
  // retried is what the total adds up: times - 1 per wall.
  for (const list of Object.values(s.walls)) for (const w of list) assert.equal(w.retried, w.times - 1);
});

test("network and MCP walls and causes say what they were about", async (t) => {
  const { call } = await shop(t, { log: LOG });
  const s = await (await call("/api/state")).json();
  assert.equal(s.walls.backend.find((w) => w.target === "db.internal:5432").about, "network");
  assert.equal(s.walls.qa.find((w) => w.target === "mcp__github__create_issue").about, "tool");
  const c = s.causes;
  assert.equal(c.causes.find((x) => x.target === "db.internal:5432").about, "network");
  assert.equal(c.causes.find((x) => x.target === "mcp__github__create_issue").about, "tool");
  assert.equal(c.about.network.denials, 2);
  assert.equal(c.about.tool.denials, 2);
  assert.equal(c.about.file.paths, 3);
});

test("the page is sent every cause up to its cap, not twelve, and told how many there are", async (t) => {
  const many = [];
  for (let i = 0; i < 15; i++) many.push({ role: "qa", action: "write", kind: "file", target: `lib/f${i}.ts`, verdict: "denied" });
  const { call } = await shop(t, { log: many });
  const s = await (await call("/api/state")).json();
  assert.equal(s.causes.distinct, 15);
  assert.equal(s.causes.causes.length, 15, "the list was cut at twelve without saying so");
});
