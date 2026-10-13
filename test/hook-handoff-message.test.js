/**
 * What a denied agent is told comes from the handoff decision: the PreToolUse
 * hook, the sentence after a failed tool call and `seisin whose` say where the
 * work goes — handed to its owner, a person decides, or stopped by the chain —
 * and none of them offers the agent a role to choose.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, boxed, srtSkip } from "./_tmp.js";

import { loadConfig } from "../src/config.js";
import { decide } from "../src/hook.js";
import { afterTool } from "../src/diagnose.js";
import { logPath } from "../src/log.js";
import { requestsPath, queueOf } from "../src/requests.js";
import { decideHandoff, toAgent, describeHandoff, chainFromEnv, CHAIN_ENV, ELSEWHERE } from "../src/handoff.js";

const POLICY =
  '[keys]\ndir = ".secrets"\n\n' +
  '[roles.frontend]\nwrites = ["src/web/**"]\n\n' +
  '[roles.backend]\nwrites = ["src/api/**"]\nkeys = ["db.txt"]\n\n' +
  '[roles.platform]\nwrites = ["src/shared/**"]\n\n' +
  '[roles.infra]\nwrites = ["src/shared/**"]\n\n' +
  '[roles.qa]\nwrites = ["test/**"]\nnever_writes = ["test/fixtures/**"]\n';

// Under the test directory, not the temp dir: a run's TMPDIR is writable to it.
function repo() {
  const dir = boxed("hookmsg-");
  for (const d of ["src/api", "src/web", "src/shared", "test", "docs", ".secrets"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, ".secrets", "db.txt"), "x\n");
  writeFileSync(join(dir, "seisin.toml"), POLICY);
  return { dir, config: loadConfig(join(dir, "seisin.toml")) };
}

const write = (dir, rel) => ({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(dir, rel), content: "x" } });
const said = (r) => r.hookSpecificOutput.permissionDecisionReason;
const quiet = { now: () => {}, ask: () => {} };
const CHAIN = { id: "frontend:write:src/api", depth: 1, visited: ["frontend", "backend"] };

/* ── the PreToolUse sentence, one per decision type ───────────────────── */

test("an owned path is handed to its owner", () => {
  const { dir, config } = repo();
  const s = said(decide(config, "frontend", write(dir, "src/api/x.ts"), quiet));
  assert.match(s, /^src\/api\/x\.ts belongs to backend\. It is not frontend's to change\. It is handed to backend: hand it over/);
  // Ends on the role it goes to, not on "a person": two owners in one sentence
  // is what an agent repeated wrong in a measured run.
  assert.match(s, /Already queued as a handoff to backend: a run of backend, or a person, picks it up/);
  assert.doesNotMatch(s, /for a person/);
});

test("two owners: a person decides, and the agent is told not to pick one", () => {
  const { dir, config } = repo();
  const s = said(decide(config, "frontend", write(dir, "src/shared/x.ts"), quiet));
  assert.match(s, /belongs to platform, infra/);
  assert.match(s, /a person decides who takes it\. Do not pick one/);
  assert.doesNotMatch(s, /handed to/);
});

test("no owner: a person decides", () => {
  const { dir, config } = repo();
  const s = said(decide(config, "frontend", write(dir, "docs/x.md"), quiet));
  assert.match(s, /^docs\/x\.md has no owner\. A person decides who takes it/);
});

test("a key is never handed over", () => {
  const { dir, config } = repo();
  const ev = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(dir, ".secrets/db.txt") } };
  const s = said(decide(config, "frontend", ev, quiet));
  assert.match(s, /\.secrets\/db\.txt is declared for backend, not frontend\. Ask for what you need/);
  assert.doesNotMatch(s, /handed to/);
});

test("in a handoff chain, reaching back is a cycle and a long chain stops", () => {
  const { dir, config } = repo();
  const back = said(decide(config, "backend", write(dir, "src/web/app.ts"), { ...quiet, chain: CHAIN }));
  assert.match(back, /^src\/web\/app\.ts is not backend's to change, and its handoff chain stops here: handing it on would send it back the way it came\. A person decides\./);
  // Not told whose it is, nor the chain: told the owner, two runs of three added it after the sentence.
  assert.doesNotMatch(back, /frontend/);
  // And nothing after the sentence: it is the last thing the agent reads.
  assert.match(back, /seisin requests\."$/);
  // The words to pass on, literally: told what not to say, an agent in one run of two sent its user to frontend.
  // What not to add comes first, so the quote is the last thing the agent reads.
  assert.match(back, /About this file, tell whoever sent you one sentence and add nothing to it: not whose file it is, who should do it or where else it could go\. The sentence, word for word and whole, even where your line already names the file: "Not written: src\/web\/app\.ts\. A person has to decide who does it; the request backend:write:src\/web is waiting in seisin requests\."$/);
  const deep = said(decide(config, "backend", write(dir, "test/a.ts"), { ...quiet, chain: { id: "c", depth: 4, visited: ["a", "b", "c", "backend"] } }));
  assert.match(deep, /its handoff chain stops here: 5 of 4 deep\. A person decides/);
  assert.doesNotMatch(deep, /belongs to|qa/);
  assert.match(deep, /seisin requests\."$/);
  // The same request outside any chain is an ordinary route.
  assert.match(said(decide(config, "backend", write(dir, "src/web/app.ts"), quiet)), /It is handed to frontend/);
});

test("a handed run's route names the chain it extends", () => {
  const { dir, config } = repo();
  const s = said(decide(config, "backend", write(dir, "test/a.ts"), { ...quiet, chain: CHAIN }));
  assert.match(s, /It is handed to qa \(handoff chain frontend → backend → qa, 2 of 4 deep\): hand it over/);
  // Outside a chain there is none to name.
  assert.doesNotMatch(said(decide(config, "backend", write(dir, "test/a.ts"), quiet)), /handoff chain/);
});

test("only a route ends on a role; every other queued denial ends on a person", () => {
  const { dir, config } = repo();
  // A stopped chain ends on the sentence to pass on instead (above).
  for (const [role, rel] of [["frontend", "src/shared/x.ts"], ["frontend", "docs/x.md"]]) {
    const s = said(decide(config, role, write(dir, rel), quiet));
    assert.match(s, /Already queued for a person to answer/, rel);
    assert.doesNotMatch(s, /queued as a handoff/, rel);
  }
});

test("a refused write says that putting it elsewhere is working around it; a refused key does not", () => {
  const { dir } = repo();
  mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
  writeFileSync(join(dir, "test", "fixtures", "a.json"), "{}\n");
  const config = loadConfig(join(dir, "seisin.toml"));
  // Measured: an agent that never retried still offered to leave the file in a folder of its own.
  for (const [role, rel] of [["frontend", "src/api/x.ts"], ["frontend", "src/shared/x.ts"], ["frontend", "docs/x.md"], ["qa", "test/fixtures/a.json"]])
    assert.ok(said(decide(config, role, write(dir, rel), quiet)).includes(ELSEWHERE), rel);
  const key = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: join(dir, ".secrets/db.txt") } };
  assert.ok(!said(decide(config, "frontend", key, quiet)).includes(ELSEWHERE));
});

test("a route gets no words to pass on: the role it goes to is the answer", () => {
  const { dir, config } = repo();
  assert.doesNotMatch(said(decide(config, "frontend", write(dir, "src/api/x.ts"), quiet)), /word for word/);
});

test("the request a chain started from says where the chain stopped", () => {
  const { dir, config } = repo();
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const line = (o) => appendFileSync(requestsPath(dir), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
  line({ kind: "asked", key: "frontend:write:src/api", role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] });
  line({ kind: "handoff", key: "frontend:write:src/api", outcome: "route", role: "backend", depth: 1, chainId: "frontend:write:src/api" });
  // The run of backend that took it was denied src/web, back in frontend's territory: a cycle.
  line({ kind: "asked", key: "backend:write:src/web", role: "backend", action: "write", target: "src/web/app.ts", owners: ["frontend"], chain: CHAIN });
  const q = queueOf(config);
  const original = q.find((r) => r.key === "frontend:write:src/api");
  assert.equal(q.find((r) => r.key === "backend:write:src/web").handoff.type, "cycle");
  assert.deepEqual(original.chainStopped, ["backend:write:src/web"]);
  assert.equal(describeHandoff(original.handoff, original.attempt, original.chainStopped),
    "handed to backend — a run of backend took it; its handoff chain stopped at backend:write:src/web, which needs a person");
  const out = spawnSync(process.execPath, [CLI, "requests"], { cwd: dir, encoding: "utf8" }).stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(out, /its handoff chain stopped at backend:write:src\/web, which needs a person/);
});

test("a denial that files no request keeps its own reason, with no handoff in it", () => {
  const { dir } = repo();
  // Exists, so never_writes is enforced on Linux too (bubblewrap denies what it can mount over).
  mkdirSync(join(dir, "test", "fixtures"), { recursive: true });
  writeFileSync(join(dir, "test", "fixtures", "a.json"), "{}\n");
  const config = loadConfig(join(dir, "seisin.toml"));
  const s = said(decide(config, "qa", write(dir, "test/fixtures/a.json"), quiet));
  assert.match(s, /never_writes/);
  assert.doesNotMatch(s, /handed|a person decides/);
});

test("the sentence is the one the queue's decision gives, word for word", () => {
  const { dir, config } = repo();
  const d = decideHandoff({ request: { role: "frontend", action: "write", target: "src/shared/x.ts" }, config });
  assert.ok(said(decide(config, "frontend", write(dir, "src/shared/x.ts"), quiet)).startsWith(toAgent(d, { target: "src/shared/x.ts", role: "frontend" })));
});

/* ── the chain is words, never authority ──────────────────────────────── */

test("a chain in the environment is read only when well formed", () => {
  assert.deepEqual(chainFromEnv({ [CHAIN_ENV]: JSON.stringify(CHAIN) }), CHAIN);
  for (const bad of ["", "{", "null", '{"id":1,"depth":0,"visited":[]}', '{"id":"x","depth":-1,"visited":[]}', '{"id":"x","depth":0,"visited":[3]}'])
    assert.equal(chainFromEnv({ [CHAIN_ENV]: bad }), null, bad);
  assert.equal(chainFromEnv({}), null);
});

test("the real hook words a cycle from the run's chain, and the request it files carries no chain", () => {
  const { dir } = repo();
  const r = spawnSync(process.execPath, [CLI, "hook"], {
    cwd: dir, encoding: "utf8", input: JSON.stringify(write(dir, "src/web/app.ts")),
    env: { ...process.env, SEISIN_ROLE: "backend", SEISIN_CONFIG: join(dir, "seisin.toml"), [CHAIN_ENV]: JSON.stringify(CHAIN) },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(said(JSON.parse(r.stdout)), /handoff chain stops here: handing it on would send it back the way it came/);
  // The words came from the variable; the record did not. Only the parent of
  // a `--handoff` run writes a chain into the queue (intake.js).
  const line = JSON.parse(readFileSync(requestsPath(dir), "utf8").trim());
  assert.equal(line.chain, undefined);
  assert.equal(queueOf(loadConfig(join(dir, "seisin.toml")))[0].handoff.type, "route");
});

test("a policy cannot deliver a key under the chain's name", () => {
  const dir = boxed("hookmsg-");
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.k]\ncommand = ["printf", "%s", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["${CHAIN_ENV}=k://x"]\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), new RegExp(`would arrive as ${CHAIN_ENV}`));
});

/* ── after a failed tool call, and seisin whose ───────────────────────── */

test("after a failed command, the kernel's denial is worded from the same decision", async () => {
  const { dir, config } = repo();
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  for (const target of ["src/shared/x.ts", "src/web/app.ts"])
    appendFileSync(logPath(dir), JSON.stringify({
      at: new Date().toISOString(), role: "backend", tool: "kernel", source: "kernel",
      action: "write", kind: "file", target, verdict: "denied", owners: [], reason: "file-write-create",
    }) + "\n");
  const ev = { hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "sh: Operation not permitted" };
  const text = (await afterTool(config, "backend", ev, { file: logPath(dir), wait: [0], chain: CHAIN })).hookSpecificOutput.additionalContext;
  assert.match(text, /src\/shared\/x\.ts belongs to platform, infra\. It is not backend's to change\. With more than one owner, a person decides/);
  assert.match(text, /src\/web\/app\.ts is not backend's to change, and its handoff chain stops here/);
});

test("seisin whose, asked from inside a run, says where the work goes", () => {
  const { dir } = repo();
  const ask = (role, path, extra = {}) => spawnSync(process.execPath, [CLI, "whose", path],
    { cwd: dir, encoding: "utf8", env: { ...process.env, SEISIN_ROLE: role, ...extra } }).stdout.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(ask("frontend", "src/api/x.ts"), /you are frontend\. It is handed to backend: hand it over/);
  assert.match(ask("frontend", "src/shared/x.ts"), /you are frontend\. With more than one owner, a person decides/);
  assert.match(ask("backend", "src/web/a.ts", { [CHAIN_ENV]: JSON.stringify(CHAIN) }), /It is not handed back/);
});

/* ── the run sets it, and only a handed run ───────────────────────────── */

const skip = srtSkip();

test("a --handoff run carries its chain to the hook; any other run never does", { skip }, () => {
  const { dir } = repo();
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  appendFileSync(requestsPath(dir), JSON.stringify({
    at: new Date().toISOString(), kind: "asked", key: "frontend:write:src/api", role: "frontend",
    action: "write", target: "src/api/x.ts", owners: ["backend"],
  }) + "\n");
  const show = `printf '%s' "\${${CHAIN_ENV}:-none}"`;
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, "run", ...args, "--", "sh", "-c", show],
    { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });

  const handed = run(["backend", "--handoff", "frontend:write:src/api"]);
  assert.equal(handed.status, 0, handed.stderr);
  assert.deepEqual(JSON.parse(handed.stdout), CHAIN);

  // A value in the parent's environment does not reach a run nobody handed.
  const plain = run(["frontend"], { [CHAIN_ENV]: JSON.stringify(CHAIN) });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout, "none");
});

test("the hook counts this run's tries, and names the earlier runs' apart", () => {
  const { dir, config } = repo();
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const line = (o) => appendFileSync(logPath(dir), JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
  const denial = { role: "frontend", tool: "Write", action: "write", kind: "file", target: "src/api/x.ts", verdict: "denied" };
  for (let i = 0; i < 3; i++) line(denial);
  line({ event: "canary", role: "frontend", run: "feedbeef", confined: true });
  const first = said(decide(config, "frontend", write(dir, "src/api/x.ts"), { ...quiet, run: "feedbeef-1111" }));
  assert.match(first, /It was denied 3 time\(s\) in earlier runs too; this run gets the same answer\./);
  assert.doesNotMatch(first, /4 times/, "a fresh run is not told about its fourth try");
  line(denial);
  const second = said(decide(config, "frontend", write(dir, "src/api/x.ts"), { ...quiet, run: "feedbeef-1111" }));
  assert.match(second, /You have been denied this 2 times in this run \(and 3 in earlier runs\); it is not going to work on the third try\./);
  // Outside a run nothing marks where this one began: the count is the log's.
  assert.match(said(decide(config, "frontend", write(dir, "src/api/x.ts"), { ...quiet, run: null })), /You have been denied this 5 times now/);
});
