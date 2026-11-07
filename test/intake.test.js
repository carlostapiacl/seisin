/**
 * The parent's intake: what the hook and the kernel say during a run, checked
 * against the policy the run started with and written down with the run's id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { intake, policyId } from "../src/intake.js";
import { effectiveConfig } from "../src/narrow.js";
import { markStale, runsAfter, pending, requestsPath } from "../src/requests.js";
import { scratch, noFilesystem as settings } from "./_tmp.js";

function setup() {
  const dir = scratch("seisin-intake-");
  mkdirSync(join(dir, ".secrets"));
  writeFileSync(join(dir, ".secrets", "db.txt"), "x\n");
  writeFileSync(join(dir, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n' +
    '[roles.dev]\nwrites = ["**"]\n\n' +
    '[roles.web]\nwrites = ["web/**"]\n\n' +
    '[roles.backend]\nwrites = ["api/**"]\nkeys = ["db.txt"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const lines = () => existsSync(join(dir, ".seisin", "log.jsonl"))
    ? readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  const queue = () => pending(requestsPath(dir));
  return { dir, config, lines, queue };
}

test("every line carries the run and the policy it ran under", () => {
  const { config, lines } = setup();
  const take = intake({ config, role: "web", runId: "1234abcd-0000", settings });
  take.fromHook("log", { at: new Date().toISOString(), tool: "Write", action: "write", target: "web/a.ts", verdict: "allowed" });
  const [line] = lines();
  assert.equal(line.run, "1234abcd");
  assert.equal(line.policy, policyId(config));
  assert.match(line.policy, /^[0-9a-f]{12}$/);
});

test("a hook line that the policy does not back is marked disputed", () => {
  // The verdict is the hook's account, and a process inside the box can send
  // any account it likes. Before, an "allowed" for somebody else's file went
  // into the log as a fact.
  const { config, lines } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromHook("log", { at: new Date().toISOString(), tool: "Write", action: "write", target: "api/x.ts", verdict: "allowed" });
  take.fromHook("log", { at: new Date().toISOString(), tool: "Write", action: "write", target: "web/y.ts", verdict: "allowed" });
  const [forged, honest] = lines();
  assert.equal(forged.disputed, "denied");
  assert.equal(honest.disputed, undefined);
});

test("the policy id follows the file", () => {
  const { dir, config } = setup();
  const before = policyId(config);
  writeFileSync(join(dir, "seisin.toml"), readFileSync(join(dir, "seisin.toml"), "utf8") + "\n# edited\n");
  assert.notEqual(policyId(config), before);
});

test("no request is filed for a protected path, however wide the role", () => {
  // Before: `narrow wants write on seisin.toml (owned by dev)` sat in the
  // queue, and granting it would have granted nothing.
  const { dir, config, queue, lines } = setup();
  // Present on disk, because on Linux only what exists can be denied — and
  // only what the kernel denies is called protected.
  mkdirSync(join(dir, "api", ".claude"), { recursive: true });
  writeFileSync(join(dir, "api", ".claude", "settings.json"), "{}");
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromHook("requests", { action: "write", target: "seisin.toml" });
  take.fromHook("requests", { action: "write", target: "api/.claude/settings.json" });
  assert.deepEqual(queue(), []);
  // The same call for an ordinary path does file one, so the empty queue
  // above is the protection and not a broken queue.
  take.fromHook("requests", { action: "write", target: "api/x.ts" });
  assert.equal(queue().length, 1);
  take.fromKernel({ action: "write", path: join(config.root, "seisin.toml"), operation: "file-write-data" });
  assert.equal(queue().length, 1);
  assert.equal(lines().at(-1).protected, "the policy");
});

test("a request for a key names who declares it, not who writes its directory", () => {
  // Before: `dev wants read on .secrets/db.txt (owned by dev)` — dev writes
  // `**`, so it "owned" backend's key.
  const { config, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromHook("requests", { action: "read", target: ".secrets/db.txt" });
  assert.deepEqual(queue()[0].owners, ["backend"]);
});

test("runs are counted by id, not guessed from gaps", () => {
  // Three runs started a minute apart by an orchestrator: the 10-minute gap
  // rule counted them as one, so a request the role stopped asking for never
  // went stale.
  const t0 = Date.parse("2026-09-23T10:00:00Z");
  const at = (m) => new Date(t0 + m * 60_000).toISOString();
  const entries = [
    { role: "web", at: at(1), run: "aaaa" },
    { role: "web", at: at(2), run: "bbbb" },
    { role: "web", at: at(3), run: "cccc" },
  ];
  assert.equal(runsAfter(entries, t0), 3);
  const queue = markStale([{ role: "web", last: at(0) }], entries);
  assert.equal(queue[0].stale?.runs, 3);
  // Lines from before the marker existed still count the old way.
  assert.equal(runsAfter([{ at: at(1) }, { at: at(2) }, { at: at(30) }], t0), 2);
});

test("SEC-18 a request's target is capped, not stored unbounded", () => {
  const { config, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  const huge = "api/" + "a".repeat(5000) + ".ts";   // outside web's territory, so it queues
  take.fromHook("queue", { at: new Date().toISOString(), tool: "Write", action: "write", target: huge, verdict: "denied" });
  const q = queue();
  assert.equal(q.length, 1);
  assert.ok(q[0].target.length <= 1000, `target was ${q[0].target.length} chars`);
});

test("SEC-19 seisin.toml.observed is protected from every role", async () => {
  const { config } = setup();
  const { protectedBy } = await import("../src/surface.js");
  // dev writes ** — the .observed proposal a person promotes must still be denied.
  assert.ok(protectedBy(config, "seisin.toml.observed"), ".observed was writable");
});

test("what only the run's narrowing denied is logged and asks nobody", () => {
  const { dir, config, lines, queue } = setup();
  const held = effectiveConfig(config, "dev", { only: ["web/**"], deny: [] });
  const take = intake({ config: held.config, role: "dev", runId: "r", settings, ceiling: config });
  take.fromKernel({ action: "write", path: join(dir, "api", "x.ts"), operation: "file-write-create" });
  take.fromHook("requests", { action: "write", target: "api/y.ts" });
  assert.deepEqual(queue(), []);
  assert.ok(lines().some((l) => l.target === "api/x.ts" && l.verdict === "denied"));
});

test("a narrowed run still asks for what its role does not have at all", () => {
  const { dir, config, queue } = setup();
  const held = effectiveConfig(config, "web", { only: ["web/a/**"], deny: [] });
  const take = intake({ config: held.config, role: "web", runId: "r", settings, ceiling: config });
  take.fromKernel({ action: "write", path: join(dir, "api", "x.ts"), operation: "file-write-create" });
  assert.equal(queue().length, 1);
});

/* ── a line from inside the sandbox is a claim ─────────────────────────── */

test("a use line with no target, or a verdict nobody gives, is dropped", () => {
  const { config, lines } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  for (const target of [undefined, 42, "   "]) take.fromHook("log", { action: "use", tool: "x", target, verdict: "denied" });
  take.fromHook("log", { action: "use", tool: "x", target: "mcp__db__query", verdict: "permitted" });
  assert.deepEqual(lines(), []);
});

test("a use line is checked against the role's mcp list, and a name that does not parse is refused", () => {
  const { dir, lines } = setup();
  writeFileSync(join(dir, "seisin.toml"), '[roles.web]\nwrites = ["web/**"]\nmcp = ["docs"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromHook("log", { action: "use", tool: "x", target: "mcp__db__query", verdict: "denied" });
  take.fromHook("log", { action: "use", tool: "x", target: "mcp__db__query", verdict: "allowed" });
  take.fromHook("log", { action: "use", tool: "x", target: "not-a-tool-name", verdict: "allowed" });
  const [honest, forged, unparsed] = lines();
  assert.equal(honest.disputed, undefined);
  assert.equal(forged.disputed, "denied");
  assert.equal(unparsed.disputed, "denied");
});

test("a file line about anything but a read or a write, with no target, or with an invented verdict, is dropped", () => {
  const { config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  for (const to of ["log", "queue"]) {
    take.fromHook(to, { action: "exec", target: "api/x.ts", verdict: "denied" });
    take.fromHook(to, { action: "write", target: 42, verdict: "denied" });
    take.fromHook(to, { action: "write", target: "   ", verdict: "denied" });
  }
  take.fromHook("log", { action: "write", target: "api/x.ts", verdict: "permitted" });
  assert.deepEqual(lines(), []);
  assert.deepEqual(queue(), []);
});

test("a filed request for something no grant can open puts nothing in front of a person", () => {
  const dir = scratch("seisin-intake-");
  writeFileSync(join(dir, "seisin.toml"),
    '[roles.web]\nwrites = ["web/**"]\nnever_writes = ["web/generated/**"]\n\n' +
    '[roles.owner]\nwrites = ["api/**"]\nprivate = ["vault/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromHook("queue", { action: "write", target: "web/a.ts" });
  take.fromHook("queue", { action: "write", target: "web/generated/a.ts" });
  take.fromHook("queue", { action: "write", target: ".git/config" });
  take.fromHook("queue", { action: "write", target: "seisin.toml" });
  take.fromHook("queue", { action: "read", target: "vault/a.txt" });
  assert.deepEqual(pending(requestsPath(dir)), []);
  // And the same shape of line, for a path a person can give, does reach them.
  take.fromHook("queue", { action: "write", target: "api/x.ts" });
  assert.deepEqual(pending(requestsPath(dir)).map((r) => r.target), ["api/x.ts"]);
});

/* ── what the kernel refused ───────────────────────────────────────────── */

test("a refused service is one line, and asks nobody", () => {
  const { config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromKernel({ action: "system", operation: "mach-lookup", path: "com.example.svc" });
  assert.equal(lines().length, 1);
  assert.deepEqual(queue(), []);
  assert.equal(take.stats.offPolicy, 0, "a service is not a path outside the policy");
});

test("a refused port is one line however many times it is dialled, and asks nobody", () => {
  const { config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  for (let i = 0; i < 3; i++) take.fromKernel({ action: "connect", operation: "network-outbound", path: "tcp:3306" });
  take.fromKernel({ action: "connect", operation: "network-outbound", path: "tcp:5432" });
  assert.deepEqual(lines().map((l) => l.target), ["tcp:3306", "tcp:5432"]);
  assert.deepEqual(queue(), []);
  assert.equal(take.stats.offPolicy, 0, "a port is not a path outside the policy");
});

test("a write the kernel refused in git's metadata is recorded and asks nobody", () => {
  const { dir, config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromKernel({ action: "write", operation: "file-write-create", path: join(dir, ".git", "objects", "aa") });
  assert.equal(lines().length, 1);
  assert.deepEqual(queue(), []);
});

test("a refusal on a path the policy says nothing about is counted, not logged", () => {
  const { config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromKernel({ action: "read", operation: "file-read-data", path: "/nowhere/the/policy/mentions" });
  assert.deepEqual(lines(), []);
  assert.deepEqual(queue(), []);
  assert.equal(take.stats.offPolicy, 1);
});

test("a read the kernel refused of a file the policy leaves open is logged, and asks nobody", () => {
  // Granting a read adds a key, and a file outside every key directory cannot
  // be one: the grant left the role with a policy that check and run refuse.
  const { dir, config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromKernel({ action: "read", operation: "file-read-data", path: join(dir, "web", "a.ts") });
  assert.deepEqual(queue(), []);
  assert.deepEqual(lines().map((l) => [l.action, l.target, l.verdict]), [["read", "web/a.ts", "denied"]]);
});

test("a key the kernel refused is logged as a key, and the queue names who holds it", () => {
  // Who a write lookup finds for `.secrets/x` is nobody, or whoever writes `**`.
  const { dir, config, lines, queue } = setup();
  const take = intake({ config, role: "web", runId: "r", settings });
  take.fromKernel({ action: "read", operation: "file-read-data", path: join(dir, ".secrets", "db.txt") });
  assert.equal(lines()[0].kind, "key");
  assert.deepEqual(queue()[0].owners, ["backend"]);
});
