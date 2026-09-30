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
