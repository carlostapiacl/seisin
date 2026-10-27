/**
 * A launcher that keeps the policy and seisin's state out of the repo it runs
 * in (an orchestrator with a folder per run): `--policy`, `--state-dir` and
 * `run --run-id`. Before these, wapentake wrote seisin.toml into each worktree,
 * hid it from git, and copied `.seisin/` out before deleting the worktree, and
 * one `.seisin/` mixed up to twelve runs under ids it did not know.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxed, CLI, srtSkip } from "./_tmp.js";
import { runIdOf } from "../src/commands/run.js";

const skip = srtSkip();

let repo, folder;
before(() => {
  repo = boxed("orch-repo-");
  mkdirSync(join(repo, "src"), { recursive: true });
  // The run's folder, outside the repo: where the launcher keeps the policy and wants the record.
  folder = boxed("orch-run-");
  writeFileSync(join(folder, "policy.toml"), '[roles.dev]\nwrites = ["src/**"]\n');
});

const seisin = (args, cwd = repo) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });

test("--policy reads the policy from elsewhere and roots it where the command runs", () => {
  assert.equal(existsSync(join(repo, "seisin.toml")), false);
  const r = seisin(["whose", "src/a.js", "--policy", join(folder, "policy.toml")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dev/);
  // Without it there is no policy here.
  assert.notEqual(seisin(["whose", "src/a.js"]).status, 0);
});

test("--policy is seisin's only before the agent's part of the line", { skip }, () => {
  const r = seisin(["run", "dev", "--policy", join(folder, "policy.toml"), "--state-dir", join(folder, "state-echo"),
    "--", "echo", "--policy", "x"]);
  // The second --policy is echo's: it reaches the command as written.
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--policy x/);
});

test("a value is required", () => {
  const r = seisin(["check", "--policy"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--policy needs a value/);
});

test("--run-id: letters, digits, - and _ only", () => {
  assert.equal(runIdOf(["--run-id", "01J9Z3K8R4W2"]), "01J9Z3K8R4W2");
  assert.equal(runIdOf([]), null);
  assert.throws(() => runIdOf(["--run-id", "../x"]), /letters, digits/);
  assert.throws(() => runIdOf(["--run-id"]), /letters, digits/);
});

test("a run with --policy, --state-dir and --run-id leaves its record in the run's folder, under that id", { skip }, () => {
  const state = join(folder, "state");
  const r = seisin(["run", "dev", "--policy", join(folder, "policy.toml"), "--state-dir", state,
    "--run-id", "01J9Z3K8R4W2", "--agent", "none", "--", "sh", "-c", "echo ok > src/a && echo x > outside.txt; true"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(repo, "src", "a"), "utf8").trim(), "ok");
  // The policy's territory is the repo it ran in: a write outside src/ is still denied.
  assert.equal(existsSync(join(repo, "outside.txt")), false);
  // Nothing of seisin's in the repo; the log is in the state directory, named by the launcher's id.
  assert.equal(existsSync(join(repo, ".seisin")), false);
  const log = readFileSync(join(state, "log.jsonl"), "utf8");
  assert.match(log, /"run":"01J9Z3K8R4W2"/);
});

test("check --json says what this seisin can do and which sandbox each role gets", () => {
  const r = seisin(["check", "--json", "--policy", join(folder, "policy.toml")]);
  const j = JSON.parse(r.stdout);
  for (const c of ["policy-flag", "state-dir", "run-id", "check-json"]) assert.ok(j.capabilities.includes(c), c);
  assert.equal(j.root, repo);
  assert.equal(j.roles[0].role, "dev");
  assert.ok("sandbox" in j.roles[0] && "version" in j.roles[0]);
  assert.equal(typeof j.ok, "boolean");
});

test("a JSON policy reads like the TOML one, holds a quote, and refuses what the TOML reader refuses", async () => {
  const { loadConfig, parseJsonPolicy } = await import("../src/config.js");
  const p = join(folder, "policy.json");
  writeFileSync(p, JSON.stringify({ roles: { dev: { writes: ["src/**"], verify: 'sh -c "test -d src"' } } }));
  const c = loadConfig(p, undefined, { root: repo });
  assert.deepEqual(c.roles.dev.writes, ["src/**"]);
  assert.equal(c.root, repo);
  assert.throws(() => parseJsonPolicy('{"roles":{"dev":{"writes":["a"]},"dev":{"writes":["**"]}}}'), /written twice/);
  assert.throws(() => parseJsonPolicy('{"roles":{"__proto__":{"writes":["**"]}}}'), /not a name/);
  assert.throws(() => parseJsonPolicy('{"roles":{"dev":{"writes":[null]}}}'), /array items/);
  assert.throws(() => parseJsonPolicy('{"roles":{"dev":{"local_ports":[1.5]}}}'), /array items/);
  assert.throws(() => parseJsonPolicy('[1]'), /the policy is an object/);
  // An unknown name is refused, as in TOML.
  assert.throws(() => loadConfig(p.replace(".json", "-bad.json"), '{"rolez":{}}'), /not a setting/);
  // Escaped quotes inside a key do not confuse the duplicate check.
  assert.doesNotThrow(() => parseJsonPolicy('{"a\\"b":{"x":"1"},"ab":{"x":"2"}}'));
  const r = seisin(["whose", "src/a.js", "--policy", p]);
  assert.equal(r.status, 0, r.stderr);
});

test("the hosts a sandbox's broker refused come back as one entry per target", async () => {
  const { brokerDenials } = await import("../src/commands/run.js");
  const f = join(folder, "sandbox-log.jsonl");
  writeFileSync(f, [
    { axis: "network", action: "broker-connect", target: "ok.example:443", outcome: "allowed" },
    { axis: "network", action: "broker-connect-denied", target: "bad.example:443", outcome: "denied" },
    { axis: "network", action: "broker-connect-denied", target: "bad.example:443", outcome: "denied" },
    { axis: "network", action: "broker-egress-denied", target: "169.254.169.254:80/", outcome: "denied" },
    { axis: "filesystem", action: "write", target: "/x", outcome: "denied" },
    { axis: "network", action: "broker-terminate-refused", target: "api.github.com:443 (POST /repos/evil is not allowed by the request rules for api.github.com)", outcome: "denied" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
  assert.deepEqual(brokerDenials(f), [
    { target: "bad.example:443", reason: "broker-connect-denied", times: 2 },
    { target: "169.254.169.254:80", reason: "broker-egress-denied", times: 1 },
    { target: "api.github.com:443", reason: "POST /repos/evil is not allowed by the request rules for api.github.com", times: 1 },
  ]);
  assert.deepEqual(brokerDenials(join(folder, "missing.jsonl")), []);
});

test("--egress-log is passed only to a tartaros that takes it", async () => {
  const { tartarosArgv } = await import("../src/sandboxes/tartaros.js");
  const old = join(folder, "tartaros-old"), now = join(folder, "tartaros-new");
  writeFileSync(old, "#!/bin/sh\necho 'usage: tartaros run --log FILE'\n", { mode: 0o755 });
  writeFileSync(now, "#!/bin/sh\necho 'usage: tartaros run --egress-log FILE'\n", { mode: 0o755 });
  assert.ok(!tartarosArgv(old, "s.json", ["true"], { log: "/l" }).includes("--egress-log"));
  assert.ok(tartarosArgv(now, "s.json", ["true"], { log: "/l" }).includes("--egress-log"));
  assert.ok(!tartarosArgv(now, "s.json", ["true"], {}).includes("--egress-log"));
});

test("handoff_exempt: validated, handed to tartaros only, and a role srt cannot hold", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { tartarosSettings } = await import("../src/sandboxes/tartaros.js");
  const dir = boxed("orch-exempt-");
  const ok = join(dir, "seisin.toml");
  writeFileSync(ok, '[roles.prepare]\nwrites = ["**"]\nhandoff_exempt = ["vendor", "web/node_modules"]\n');
  assert.deepEqual(loadConfig(ok).roles.prepare.handoffExempt, ["vendor", "web/node_modules"]);
  for (const bad of ["/abs", "../up", "a/../b", "v*", "~/x"]) {
    writeFileSync(ok, `[roles.prepare]\nwrites = ["**"]\nhandoff_exempt = ["${bad}"]\n`);
    assert.throws(() => loadConfig(ok), /relative, with no "\.\." and no globs/, bad);
  }
  const s = tartarosSettings({ filesystem: { allowWrite: ["/r"] }, network: {} }, { handoffExempt: ["/r/vendor"] });
  assert.deepEqual(s.filesystem.handoffExempt, ["/r/vendor"]);
  assert.deepEqual(s.filesystem.allowWrite, ["/r"]);
  // Nothing asked, nothing added: the settings object is the same one.
  const plain = { filesystem: {}, network: {} };
  assert.equal(tartarosSettings(plain, {}), plain);
});

test("requests: parsed, the host must be in network, handed to tartaros only", async () => {
  const { loadConfig } = await import("../src/config.js");
  const { tartarosSettings } = await import("../src/sandboxes/tartaros.js");
  const dir = boxed("orch-requests-");
  const p = join(dir, "seisin.toml");
  writeFileSync(p, '[roles.d]\nwrites = ["src/**"]\nnetwork = ["api.github.com"]\nrequests = ["GET api.github.com", "POST,PATCH api.github.com/repos/acme/"]\n');
  const r = loadConfig(p).roles.d.requests;
  assert.deepEqual(r, [
    { host: "api.github.com", methods: ["GET"], paths: [] },
    { host: "api.github.com", methods: ["POST", "PATCH"], paths: ["/repos/acme/"] },
  ]);
  writeFileSync(p, '[roles.d]\nwrites = ["src/**"]\nnetwork = ["api.github.com"]\nrequests = ["GET example.com"]\n');
  assert.throws(() => loadConfig(p), /not in roles\.d\.network/);
  for (const bad of ["get api.github.com", "GET https://api.github.com", "GET api.github.com/a/../b"]) {
    writeFileSync(p, `[roles.d]\nwrites = ["src/**"]\nnetwork = ["api.github.com"]\nrequests = ["${bad}"]\n`);
    assert.throws(() => loadConfig(p), /METHODS host\[\/path\]/, bad);
  }
  const s = tartarosSettings({ filesystem: {}, network: { allowedDomains: ["api.github.com"] } }, { requests: r });
  assert.deepEqual(s.network.requestRules, r);
  assert.deepEqual(s.network.allowedDomains, ["api.github.com"]);
});
