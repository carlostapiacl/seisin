/**
 * The handoff decision in use: decided where the queue is read, the same
 * everywhere a person or an agent reads it, and carried into the requests of a
 * run started for it — so a cycle or a chain too deep is caught, not routed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, boxed, srtSkip } from "./_tmp.js";

import { loadConfig, policyId } from "../src/config.js";
import { decideHandoff } from "../src/handoff.js";
import { record, requestsPath, queueOf, queueData, recordHandoff, keyOf } from "../src/requests.js";
import { intake } from "../src/intake.js";
import { message } from "../src/notify.js";
import { state } from "../src/serve.js";
import * as api from "../src/index.js";

const POLICY =
  '[keys]\ndir = ".secrets"\n\n' +
  '[roles.frontend]\nwrites = ["src/web/**"]\n\n' +
  '[roles.backend]\nwrites = ["src/api/**"]\nkeys = ["db.txt"]\n\n' +
  '[roles.qa]\nwrites = ["test/**"]\n';

// Under the test directory, not the temp dir: a run's TMPDIR is writable to it.
function repo(text = POLICY) {
  const dir = boxed("handoff-");
  for (const d of ["src/api", "src/web", "test", "docs", ".secrets"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, ".secrets", "db.txt"), "x\n");
  writeFileSync(join(dir, "seisin.toml"), text);
  return { dir, config: loadConfig(join(dir, "seisin.toml")), file: requestsPath(dir) };
}

const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };

/* ── the decision ─────────────────────────────────────────────────────── */

test("a key is never handed over: a person decides, and the decision names who declares it", () => {
  const { config } = repo();
  const d = decideHandoff({ request: { role: "frontend", action: "read", target: ".secrets/db.txt" }, config });
  assert.equal(d.type, "human");
  assert.equal(d.reason, "key");
  assert.deepEqual(d.owners, ["backend"]);
  // A key the asker declares by now is a request that stopped existing.
  const mine = decideHandoff({ request: { role: "backend", action: "read", target: "db.txt" }, config });
  assert.equal(mine.type, "resolved");
});

test("every decision says whose the path is, whatever its type", () => {
  const { config } = repo();
  const w = { role: "frontend", action: "write", target: "src/api/x.ts" };
  for (const d of [
    decideHandoff({ request: w, config }),
    decideHandoff({ request: w, config, chain: { visited: ["backend"], depth: 1 } }),
    decideHandoff({ request: w, config, chain: { visited: [], depth: 9 } }),
    decideHandoff({ request: w, config, limits: { senderChains: 0 } }),
  ]) assert.deepEqual(d.owners, ["backend"], d.type);
});

/* ── one queue, decided where it is read ──────────────────────────────── */

test("the queue carries the decision against the policy as it stands, not the owners stored at denial", () => {
  const { config, file } = repo();
  // Filed when qa owned it, as far as the line knows.
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["qa"] });
  const [r] = queueOf(config);
  assert.equal(r.handoff.type, "route");
  assert.equal(r.handoff.role, "backend");
  assert.deepEqual(r.owners, ["backend"]);           // what every reader shows
  assert.deepEqual(r.ownersThen, ["qa"]);            // the evidence, kept
  assert.equal(r.handoff.revision, policyId(config));
  assert.equal(r.handoff.chainId, r.key);            // a request outside any chain starts its own
  assert.deepEqual(r.handoff.visited, ["frontend", "backend"]);
});

test("a grant made since changes the decision on the next read", () => {
  const { dir, config, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  assert.equal(queueOf(config)[0].handoff.type, "route");
  writeFileSync(join(dir, "seisin.toml"), POLICY.replace('[roles.backend]\nwrites = ["src/api/**"]', '[roles.backend]\nwrites = []'));
  const moved = queueOf(loadConfig(join(dir, "seisin.toml")))[0];
  assert.equal(moved.handoff.type, "human");
  assert.equal(moved.handoff.reason, "unowned");
});

test("a queue written before handoffs were recorded reads the same, and old attempt lines land as attempt", () => {
  const { config, file } = repo();
  mkdirSync(join(file, ".."), { recursive: true });
  const at = "2026-09-01T00:00:00.000Z";
  appendFileSync(file,
    JSON.stringify({ at, kind: "asked", key: "frontend:write:src/api", role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] }) + "\n" +
    JSON.stringify({ at, kind: "handoff", key: "frontend:write:src/api", outcome: "throttled", role: "backend", limit: "senderChains", max: 2 }) + "\n");
  const [r] = queueOf(config);
  assert.equal(r.state, "pending");
  assert.equal(r.handoff.type, "route");
  assert.equal(r.attempt.outcome, "throttled");
  assert.equal(r.chain, undefined);
});

/* ── the chain is the parent's, never the sandbox's ───────────────────── */

test("a run started for a handoff files its requests in that chain, and a way back is a cycle", () => {
  const { config, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  const first = queueOf(config)[0];
  const chain = { id: first.handoff.chainId, depth: first.handoff.depth, visited: first.handoff.visited };

  const take = intake({ config, role: "backend", runId: "abcd1234-0000", settings, chain });
  // Whatever the sandbox claims about a chain is not read: the parent's is written.
  take.fromHook("requests", { action: "write", target: "src/web/app.ts", chain: { id: "x", depth: 0, visited: [] } });
  const back = queueOf(config).find((r) => r.role === "backend");
  assert.deepEqual(back.chain, { id: first.key, depth: 1, visited: ["frontend", "backend"] });
  assert.equal(back.handoff.type, "cycle");
  assert.equal(back.handoff.role, "frontend");

  // Forward to a role the chain has not visited is still a route, one deeper.
  take.fromHook("requests", { action: "write", target: "test/a.test.ts" });
  const on = queueOf(config).find((r) => r.key === "backend:write:test");
  assert.equal(on.handoff.type, "route");
  assert.equal(on.handoff.depth, 2);
  assert.equal(on.handoff.chainId, first.key);
});

test("a hook line cannot start a chain of its own choosing", () => {
  const { config, file } = repo();
  const take = intake({ config, role: "backend", runId: "abcd1234-0000", settings });
  take.fromHook("requests", { action: "write", target: "src/web/app.ts", chain: { id: "x", depth: 3, visited: ["frontend"] } });
  const line = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(line.chain, undefined);
  assert.equal(queueOf(config)[0].handoff.type, "route");
});

test("the deepest chain a request was asked in is the one kept", () => {
  const { config, file } = repo();
  const ask = { role: "backend", action: "write", target: "src/web/app.ts", owners: ["frontend"] };
  record(file, { ...ask, chain: { id: "c", depth: 1, visited: ["frontend", "backend"] } });
  record(file, ask);                    // asked again outside any chain
  const [r] = queueOf(config);
  assert.equal(r.times, 2);
  assert.equal(r.handoff.type, "cycle", "a plain ask let the work go back where it came from");
});

/* ── every reader shows the same decision ─────────────────────────────── */

test("seisin requests --json carries the decision as data, and the text says where it goes", () => {
  const { dir, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  record(file, { role: "frontend", action: "write", target: "docs/x.md", owners: [] });
  const j = cli(dir, "requests", "--json");
  assert.equal(j.status, 1, j.stderr);
  const { pending } = JSON.parse(j.stdout);
  assert.deepEqual(pending.map((p) => [p.id, p.handoff.type, p.handoff.role ?? p.handoff.reason]),
    [["frontend:write:src/api", "route", "backend"], ["frontend:write:docs", "human", "unowned"]]);
  const t = cli(dir, "requests").stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(t, /handed to backend/);
  assert.match(t, /a person decides: no role owns this/);
});

test("seisin_requests over the MCP returns the same shape as requests --json", async () => {
  const { dir, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  const p = spawn(process.execPath, [CLI, "mcp"], { cwd: dir });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "seisin_requests", arguments: {} } }) + "\n");
  await new Promise((ok) => p.on("close", ok));
  const got = JSON.parse(out.trim().split("\n")[0]).result.structuredContent;
  const cliShape = JSON.parse(cli(dir, "requests", "--json").stdout);
  assert.deepEqual(got.pending, cliShape.pending);
  assert.equal(got.pending[0].handoff.role, "backend");
  assert.match(got.note, /Granting is not available/);
});

test("the notification and the console say what seisin requests says", () => {
  const { dir, config, file } = repo();
  const req = { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] };
  record(file, req);
  const body = JSON.parse(message(config, req, 1, "json").body);
  assert.equal(body.handoff.type, "route");
  assert.match(body.text, /It belongs to backend\. Handed to backend\./);
  const s = state(join(dir, "seisin.toml"));
  assert.equal(s.requests[0].handoff.role, "backend");
  assert.equal(s.requests[0].handoffNote, "handed to backend");
});

test("the package exports the decision and the queue that carries it", () => {
  for (const name of ["decideHandoff", "requestQueue", "recordHandoff"]) assert.equal(typeof api[name], "function", name);
  assert.equal(api.MAX_DEPTH, 4);
  const { config, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  assert.deepEqual(queueData(api.requestQueue(config)).pending[0].handoff.type, "route");
});

/* ── seisin run --handoff: the policy picks the role, not the caller ──── */

test("run --handoff refuses a role the request is not handed to, and starts nothing", () => {
  const { dir, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  record(file, { role: "frontend", action: "write", target: "docs/x.md", owners: [] });
  const before = readFileSync(file, "utf8");

  const wrong = cli(dir, "run", "qa", "--handoff", "frontend:write:src/api", "--", "true");
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /handed to backend, not qa/);

  const nobody = cli(dir, "run", "qa", "--handoff", "frontend:write:docs", "--", "true");
  assert.equal(nobody.status, 2);
  assert.match(nobody.stderr, /not handed to anybody: a person decides: no role owns this/);

  const unknown = cli(dir, "run", "backend", "--handoff", "frontend:write:nowhere", "--", "true");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no pending request has the id/);

  const bare = cli(dir, "run", "backend", "--handoff");
  assert.equal(bare.status, 2);
  assert.equal(readFileSync(file, "utf8"), before, "a refused --handoff wrote to the queue");
});

const skip = srtSkip() || (process.platform !== "darwin" && "macOS: the kernel's refusal is what files the request there");

test("end to end: the receiver takes the work, and reaching back is stopped as a cycle", { skip }, () => {
  const { dir, file } = repo();
  const one = cli(dir, "run", "frontend", "--", "sh", "-c", "echo x > src/api/x.ts");
  assert.notEqual(one.status, 0, "the kernel let frontend write backend's file");
  const id = keyOf({ role: "frontend", action: "write", target: "src/api/x.ts" });
  assert.match(one.stderr.replace(/\x1b\[[0-9;]*m/g, ""), /handed to backend/);

  const two = cli(dir, "run", "backend", "--handoff", id, "--", "sh", "-c", "echo x > src/api/x.ts; echo y > src/web/app.ts");
  const said = two.stderr.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(said, /backend took frontend:write:src\/api — handoff chain frontend → backend, 1 of 4/);
  assert.match(said, /handoff stopped: frontend is already in this handoff chain/);
  assert.equal(readFileSync(join(dir, "src/api/x.ts"), "utf8"), "x\n");

  const { pending } = JSON.parse(cli(dir, "requests", "--json").stdout);
  const first = pending.find((p) => p.id === id);
  assert.equal(first.attempt.outcome, "route");
  assert.equal(first.attempt.role, "backend");
  const back = pending.find((p) => p.id === "backend:write:src/web");
  assert.equal(back.handoff.type, "cycle");
  assert.equal(back.handoff.chainId, id);
});

test("recordHandoff is what whatever starts roles writes when it holds one back", () => {
  const { config, file } = repo();
  record(file, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  const [r] = queueOf(config);
  recordHandoff(file, r.key, decideHandoff({ request: r, config, limits: { receiverConcurrent: 1 }, load: { receiverRunning: 1 } }));
  const t = cli(join(file, "..", ".."), "requests").stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(t, /handoff held: backend already running 1\/1 — still to do/);
});
