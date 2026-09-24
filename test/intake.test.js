/**
 * The parent's intake: what the hook and the kernel say during a run, checked
 * against the policy the run started with and written down with the run's id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { intake, policyId } from "../src/intake.js";
import { markStale, runsAfter, pending, requestsPath } from "../src/requests.js";
import { scratch } from "./_tmp.js";

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

const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };

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
