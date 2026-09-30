/**
 * Pre-release review of 0.5.0, round x: what a person's decision writes, and
 * what it refuses to pretend it wrote.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, lstatSync, symlinkSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { loadConfig } from "../src/config.js";
import { record, pending, requestsPath, policyLockBase } from "../src/requests.js";
import { grant } from "../src/commands/requests.js";

const TOML = '[roles.a]\nwrites = ["a/**"]\nkeys = []\n';

function repo(prefix, toml = TOML) {
  const box = scratch(prefix);
  writeFileSync(join(box, "seisin.toml"), toml);
  return box;
}

test("a symlink planted at the old temp name does not become the policy", () => {
  const box = repo("seisin-x-tmp-");
  // What a role that writes the root could leave: the old predictable temp
  // name, for this pid and a few others, pointing into its own territory.
  mkdirSync(join(box, "a"));
  const bait = join(box, "a", "mine.toml");
  writeFileSync(bait, "# the role's\n");
  for (const pid of [process.pid, process.pid + 1, 1])
    symlinkSync(bait, join(box, `seisin.toml.tmp-${pid}`));
  record(requestsPath(box), { role: "a", action: "write", target: "b/x.ts", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));

  grant(cfg, ["1"]);

  const policy = join(box, "seisin.toml");
  assert.ok(lstatSync(policy).isFile() && !lstatSync(policy).isSymbolicLink(), "the policy must stay a regular file");
  assert.match(readFileSync(policy, "utf8"), /b\/\*\*/);
  assert.equal(readFileSync(bait, "utf8"), "# the role's\n", "the grant was written through the planted link");
  assert.equal(pending(requestsPath(box)).length, 0);
  // Nothing left behind in the state dir.
  assert.deepEqual(readdirSync(join(box, ".seisin")).filter((f) => f.includes("tmp")), []);
});

test("a lock file beside the policy no longer blocks a grant", () => {
  const box = repo("seisin-x-lock-");
  // A live pid (this process) in the old lock: withLock would have waited it out
  // and failed with ELOCKED.
  writeFileSync(join(box, "seisin.toml.lock"), `${process.pid} deadbeef\n`);
  record(requestsPath(box), { role: "a", action: "write", target: "b/x.ts", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));

  grant(cfg, ["1"]);

  assert.match(readFileSync(join(box, "seisin.toml"), "utf8"), /b\/\*\*/);
  assert.equal(pending(requestsPath(box)).length, 0);
});

test("the policy's lock lives in the state dir, which every role is denied", () => {
  const box = repo("seisin-x-where-");
  const cfg = loadConfig(join(box, "seisin.toml"));
  const base = policyLockBase(cfg);
  assert.equal(base, join(box, ".seisin", "policy"));
  assert.ok(existsSync(join(box, ".seisin")));
});

/* ── a protected file is not something to ask for ─────────────────────── */

const WEB = '[roles.web]\nwrites = ["web/**"]\nkeys = []\n';

test("the hook files no request for a protected file, and says nothing was queued", async () => {
  const { decide } = await import("../src/hook.js");
  const box = repo("seisin-x-hookprot-", WEB);
  mkdirSync(join(box, "web", ".vscode"), { recursive: true });
  writeFileSync(join(box, "web", ".vscode", "settings.json"), "{}");
  const cfg = loadConfig(join(box, "seisin.toml"));
  const asked = [];
  const out = decide(cfg, "web",
    { tool_name: "Write", tool_input: { file_path: join(box, "web", ".vscode", "settings.json") } },
    { now: () => true, ask: (_f, r) => asked.push(r) });
  assert.equal(out.decision, "deny");
  assert.deepEqual(asked, [], "a request no grant can satisfy was queued");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Nothing was queued/);
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /Already queued/);
});

test("a grant for a family the role is not handed is refused, naming control_files", () => {
  const box = repo("seisin-x-grantfam-", WEB);
  mkdirSync(join(box, "web", ".vscode"), { recursive: true });
  // A request queued before the hook stopped filing these.
  record(requestsPath(box), { role: "web", action: "write", target: "web/.vscode/settings.json", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));
  const before = readFileSync(join(box, "seisin.toml"), "utf8");
  assert.throws(() => grant(cfg, ["1"]), /control_files = \["ide"\]/);
  assert.equal(readFileSync(join(box, "seisin.toml"), "utf8"), before, "the policy was edited anyway");
  assert.equal(pending(requestsPath(box)).length, 1, "left for a person to decline");
});

test("a grant for a file no role can have says it can never be granted", () => {
  const box = repo("seisin-x-grantclaude-", WEB);
  mkdirSync(join(box, "web", ".claude"), { recursive: true });
  record(requestsPath(box), { role: "web", action: "write", target: "web/.claude/settings.json", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));
  assert.throws(() => grant(cfg, ["1"]), /no role can ever be granted it/);
});

test("once the policy hands the family, the same grant goes through", () => {
  const box = repo("seisin-x-grantide-", '[roles.web]\nwrites = ["src/**"]\nkeys = []\ncontrol_files = ["ide"]\n');
  record(requestsPath(box), { role: "web", action: "write", target: "web/.vscode/settings.json", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));
  grant(cfg, ["1"]);
  assert.match(readFileSync(join(box, "seisin.toml"), "utf8"), /web\/\.vscode/);
});

/* ── "already has it" closes the request on every channel ─────────────── */

async function consoleOn(t, box) {
  const { serve } = await import("../src/serve.js");
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { "x-seisin-token": server.seisinToken };
  return {
    get: (path, headers = {}) => fetch(base + path, { headers: { ...auth, ...headers } }),
    post: (path, body) => fetch(base + path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body }),
  };
}

test("`seisin grant` for something the role already has closes it as granted", () => {
  const box = repo("seisin-x-already-cli-");
  const q = requestsPath(box);
  // Asked before a person edited the policy by hand to give it.
  record(q, { role: "a", action: "write", target: "a/x.ts", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));
  const before = readFileSync(join(box, "seisin.toml"), "utf8");
  const r = grant(cfg, ["1"]);
  assert.equal(r.changed, false);
  assert.equal(readFileSync(join(box, "seisin.toml"), "utf8"), before);
  assert.equal(pending(q).length, 0, "left pending forever");
  assert.equal(pending(q, { includeSettled: true })[0].state, "granted");
});

test("the console closes the same request the same way", async (t) => {
  const box = repo("seisin-x-already-ui-");
  const q = requestsPath(box);
  record(q, { role: "a", action: "write", target: "a/x.ts", owners: [] });
  const { post } = await consoleOn(t, box);
  const r = await post("/api/decide", JSON.stringify({ key: pending(q)[0].key, decision: "granted" }));
  assert.equal(r.status, 200, await r.text());
  assert.equal(pending(q).length, 0);
  assert.equal(pending(q, { includeSettled: true })[0].state, "granted");
});

test("from the CLI it exits 0 and says it was already granted", async () => {
  const { spawnSync } = await import("node:child_process");
  const { CLI } = await import("./_tmp.js");
  const box = repo("seisin-x-already-exit-");
  record(requestsPath(box), { role: "a", action: "write", target: "a/x.ts", owners: [] });
  const r = spawnSync(process.execPath, [CLI, "grant", "1"], { cwd: box, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already granted/);
  assert.equal(pending(requestsPath(box)).length, 0);
});
