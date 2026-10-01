/**
 * Codex under seisin, the follow-up of 2026-09-30 (night).
 *
 * Four things measured with codex 0.150.1 signed in with ChatGPT:
 *
 * - every role could read ~/.codex/auth.json, the ChatGPT tokens, because the
 *   runtime granted ~/.codex (and ~/.claude) to every run whatever it ran. An
 *   agent's home now goes to a run of that agent, and the other agents'
 *   sign-in files are closed to it;
 * - `codex plugin add` installs from ~/.codex/.tmp/plugins exactly as it is on
 *   disk, so that copy is protected like plugins/;
 * - `CODEX_HOME` moves every file Codex runs or obeys, so it is protected where
 *   it points too;
 * - with a ChatGPT sign-in Codex needs chatgpt.com and auth.openai.com, and
 *   without the first it hangs in silence: `check` says so.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { agentOf, runtimeWritesFor, otherAgentsCredentials, expand, roleHome, realOrSelf } from "../src/grants.js";
import { settingsFor } from "../src/srt.js";
import { agentFor } from "../src/commands/run.js";
import { explain, explainFileRead } from "../src/owners.js";
import { denyFor, protectedBy } from "../src/surface.js";
import { inspect, codexSignIn } from "../src/inspect.js";
import { loadConfig } from "../src/config.js";
import { boxed, CLI, scratch, srtSkip } from "./_tmp.js";

/* ── a home of our own, so the files exist on every platform ─────────── */

const realHome = process.env.HOME;
const realCodexHome = process.env.CODEX_HOME;
let home;
before(() => {
  // Not under the temp dir: it is runtime scratch for every role, and a
  // home there would be writable for the wrong reason.
  home = boxed("codex2-home-");
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  mkdirSync(join(home, ".codex", ".tmp", "plugins"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{"refresh_token":"rt-codex-2"}}\n');
  writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{}}\n');
});
after(() => {
  process.env.HOME = realHome;
  if (realCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = realCodexHome;
});

const mk = (extra = {}) => ({
  root: "/repo", path: "/repo/seisin.toml", keyDirs: [],
  roles: { dev: { name: "dev", writes: ["src/**"], keys: [] } },
  ...extra,
});
const at = (p) => expand(p);

/* ── which agent a command runs ──────────────────────────────────────── */

test("the agent is read off the command: the program, through env, a launcher, or sh -c", () => {
  const cases = [
    [["codex", "exec", "hi"], "codex"],
    [["/usr/local/bin/codex", "exec"], "codex"],
    [["claude", "-p", "x"], "claude"],
    [["env", "A=1", "codex"], "codex"],
    [["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "exec"], "codex"],
    [["npx", "@anthropic-ai/claude-code", "-p", "x"], "claude"],
    [["sh", "-c", "FOO=1 codex exec hi"], "codex"],
    [["bash", "-lc", "claude -p hola"], "claude"],
  ];
  for (const [cmd, want] of cases) assert.equal(agentOf(cmd), want, cmd.join(" "));
});

test("a command that only mentions an agent is not that agent", () => {
  // A prompt that names claude must not turn a `cat` into a Claude run.
  for (const cmd of [["cat", "x"], ["sh", "-c", "echo claude"], ["echo", "codex"],
    ["node", "script.js"], ["opencode", "run", "claude"], ["./wrapper.sh", "codex"]])
    assert.equal(agentOf(cmd), null, cmd.join(" "));
});

test("--agent names it when the command cannot: a wrapper script, or none", () => {
  assert.equal(agentFor(["--agent", "codex"], ["./wrapper.sh"]), "codex");
  assert.equal(agentFor(["--agent", "none"], ["codex", "exec"]), null);
  assert.equal(agentFor([], ["claude"]), "claude");
  assert.throws(() => agentFor(["--agent", "gpt"], ["x"]), /seisin knows claude, codex and none/);
  assert.throws(() => agentFor(["--agent"], ["x"]), /seisin knows/);
});

/* ── what a run gets ─────────────────────────────────────────────────── */

test("an agent's home is scratch only for a run of that agent", () => {
  const w = (agent) => settingsFor(mk(), "dev", null, false, { agent }).filesystem.allowWrite;
  assert.ok(w("codex").includes(at("~/.codex")) && !w("codex").includes(at("~/.claude")));
  assert.ok(w("claude").includes(at("~/.claude")) && !w("claude").includes(at("~/.codex")));
  assert.ok(!w(null).includes(at("~/.claude")) && !w(null).includes(at("~/.codex")), "a cat gets neither");
  // The rest of the scratch is everybody's, whatever runs.
  for (const a of ["codex", "claude", null]) assert.ok(w(a).includes(at("~/.cache")), String(a));
});

test("the other agents' sign-in is closed both ways; a run's own is not", () => {
  const fs = (agent) => settingsFor(mk(), "dev", null, false, { agent }).filesystem;
  const codexAuth = join(home, ".codex", "auth.json");
  const claudeCreds = join(home, ".claude", ".credentials.json");
  for (const [agent, closed, open] of [["claude", [codexAuth], [claudeCreds]], ["codex", [claudeCreds], [codexAuth]],
    [null, [codexAuth, claudeCreds], []]]) {
    const f = fs(agent);
    for (const p of closed) {
      assert.ok(f.denyRead.includes(p), `${agent}: read ${p}`);
      assert.ok(f.denyWrite.includes(p), `${agent}: write ${p} (swapping in another account)`);
    }
    for (const p of open) assert.ok(!f.denyRead.includes(p), `${agent} reads its own ${p}`);
  }
});

test("without a command — check, console, explain — the settings are the most a run can get", () => {
  const f = settingsFor(mk(), "dev").filesystem;
  assert.ok(f.allowWrite.includes(at("~/.codex")) && f.allowWrite.includes(at("~/.claude")));
  assert.deepEqual(otherAgentsCredentials(undefined), []);
  // and the protected list is every agent's, because a role can be run as either
  const paths = denyFor(loadPolicy('[roles.a]\nwrites = ["a/**"]\n'), { name: "a", writes: ["a/**"], keys: [] },
    { platform: "darwin" }).map((e) => e.path);
  assert.ok(paths.includes(join(home, ".codex", "hooks.json")));
  assert.ok(paths.includes(join(home, ".claude", "settings.json")));
});

test("an explicit [runtime] writes goes through the same filter", () => {
  const cfg = mk({ runtimeWrites: ["~/.codex", "~/.claude", "$TMPDIR"] });
  assert.ok(!runtimeWritesFor(cfg, "claude").includes(at("~/.codex")));
  assert.ok(runtimeWritesFor(cfg, "codex").includes(at("~/.codex")));
  assert.ok(runtimeWritesFor(cfg, null).every((p) => p !== at("~/.codex") && p !== at("~/.claude")));
  // A path under another agent's home is that agent's too.
  assert.deepEqual(runtimeWritesFor(mk({ runtimeWrites: ["~/.codex/sessions"] }), "claude"), []);
  // writes = [] stays empty for everyone.
  assert.deepEqual(runtimeWritesFor(mk({ runtimeWrites: [] }), "codex"), []);
});

test("isolate = \"home\": the sign-in looked for is the one in the role's own home", () => {
  const cfg = mk({ root: scratch("codex2-iso-"), isolate: "home" });
  const f = settingsFor(cfg, "dev", null, false, { agent: "claude" }).filesystem;
  const theirs = join(roleHome(cfg, "dev"), ".codex", "auth.json");
  // On Linux only an existing file is denied (bubblewrap would plant one).
  if (process.platform !== "linux") assert.ok(f.denyRead.includes(theirs));
  assert.ok(!f.allowWrite.includes(at("~/.codex")), "the real home stays out of reach");
});

/* ── what explain and walls say ──────────────────────────────────────── */

test("explain names a sign-in for what it is, never as a key to declare", () => {
  const cfg = mk();
  const target = join(home, ".codex", "auth.json");
  for (const r of [explain(cfg, "dev", "read", target), explainFileRead(cfg, "dev", target)]) {
    assert.equal(r.allowed, false);
    assert.match(r.reason, /codex's sign-in/);
    assert.match(r.reason, /nothing to grant/);
    assert.doesNotMatch(r.reason, /keys =/, "the old advice handed the token to a role by policy");
  }
});

/* ── the files that make Codex run something ─────────────────────────── */

test("the curated plugin copy Codex installs from is protected; its .sha and locks are not", () => {
  const cfg = loadPolicy('[roles.a]\nwrites = ["a/**"]\n');
  const c = join(home, ".codex");
  assert.match(protectedBy(cfg, join(c, ".tmp", "plugins", "plugins", "x", "hooks", "hooks.json"),
    { platform: "darwin" }).why, /^\.codex\/\.tmp\/plugins,/);
  // Changing the .sha makes Codex fetch a clean copy: it repairs, it does not plant.
  for (const f of [".tmp/plugins.sha", ".tmp/plugins.sync.lock", ".tmp/rollout-maintenance.lock"])
    assert.equal(protectedBy(cfg, join(c, f), { platform: "darwin" }), null, f);
  const paths = denyFor(cfg, cfg.roles.a, { platform: "darwin" }).map((e) => e.path);
  assert.ok(paths.includes(join(c, ".tmp", "plugins")));
});

test("every file that can declare a Codex hook is protected, home and project", () => {
  // --dangerously-bypass-hook-trust runs every enabled hook of every layer
  // without the trust stored in config.toml. These are the layers.
  const cfg = loadPolicy('[roles.a]\nwrites = ["**"]\n');
  const c = join(home, ".codex");
  writeFileSync(join(c, "work.config.toml"), "");
  for (const f of [join(c, "hooks.json"), join(c, "config.toml"), join(c, "managed_config.toml"),
    join(c, "work.config.toml"), join(c, "plugins", "cache", "m", "p", "v", "hooks", "hooks.json"),
    join(c, ".tmp", "plugins", "plugins", "p", "hooks", "hooks.json"),
    ".codex/hooks.json", ".codex/config.toml", "a/b/c/.codex/hooks.json", "p/.codex/config.toml"])
    assert.ok(protectedBy(cfg, f, { platform: "darwin" }), f);
});

test("CODEX_HOME moves what Codex obeys, and the protection goes with it", () => {
  const cfg = loadPolicy('[roles.a]\nwrites = ["ch/**"]\n');
  mkdirSync(join(cfg.root, "ch", "rules"), { recursive: true });
  const ch = realOrSelf(join(cfg.root, "ch"));
  writeFileSync(join(ch, "hooks.json"), "{}");
  const env = { ...process.env, CODEX_HOME: ch };
  const paths = denyFor(cfg, cfg.roles.a, { platform: "darwin", env }).map((e) => e.path);
  for (const f of ["hooks.json", "config.toml", "rules", "plugins", ".tmp/plugins"])
    assert.ok(paths.includes(join(ch, f)), f);
  assert.match(protectedBy(cfg, join(ch, "hooks.json"), { platform: "darwin", env }).why, /^CODEX_HOME\/hooks\.json,/);
  assert.equal(protectedBy(cfg, join(ch, "sessions", "x.jsonl"), { platform: "darwin", env }), null);
  // Without CODEX_HOME the same directory is ordinary territory.
  assert.equal(protectedBy(cfg, join(ch, "hooks.json"), { platform: "darwin", env: {} }), null);
});

/* ── check: the endpoint a ChatGPT sign-in needs ─────────────────────── */

function signedIn(auth) {
  const ch = scratch("codex2-auth-");
  writeFileSync(join(ch, "auth.json"), JSON.stringify(auth));
  process.env.CODEX_HOME = ch;
}
const kinds = (cfg) => inspect(cfg, null, "x").warnings.map((w) => w.kind);

test("check warns a role set up for OpenAI that a ChatGPT sign-in cannot reach", () => {
  try {
    signedIn({ OPENAI_API_KEY: null, tokens: { refresh_token: "x" } });
    assert.equal(codexSignIn(), "chatgpt");
    const cfg = (domains, env = []) => mk({ allowedDomains: domains,
      roles: { dev: { name: "dev", writes: ["src/**"], keys: [], env } } });
    assert.ok(kinds(cfg(["api.openai.com", "github.com"])).includes("codex-chatgpt-endpoint"));
    assert.ok(kinds(cfg(["api.openai.com", "chatgpt.com"])).includes("codex-chatgpt-endpoint"), "auth.openai.com too");
    assert.ok(!kinds(cfg(["api.openai.com", "chatgpt.com", "auth.openai.com"])).includes("codex-chatgpt-endpoint"));
    assert.ok(!kinds(cfg(["*.openai.com", "chatgpt.com"])).includes("codex-chatgpt-endpoint"), "a wildcard covers it");
    assert.ok(!kinds(cfg(["api.anthropic.com"])).includes("codex-chatgpt-endpoint"), "not a list written for OpenAI");
    assert.ok(!kinds(cfg(["api.openai.com"], ["OPENAI_API_KEY"])).includes("codex-chatgpt-endpoint"),
      "a role given an API key is set up for the API");
    const w = inspect(cfg(["api.openai.com"]), null, "x").warnings.find((x) => x.kind === "codex-chatgpt-endpoint");
    assert.doesNotMatch(JSON.stringify(w), /refresh_token|"x"/, "nothing from auth.json is printed");
    // Signed in with an API key, or not at all: nothing to say.
    signedIn({ OPENAI_API_KEY: "sk-test-not-real" });
    assert.equal(codexSignIn(), "apikey");
    assert.ok(!kinds(cfg(["api.openai.com"])).includes("codex-chatgpt-endpoint"));
    process.env.CODEX_HOME = scratch("codex2-none-");
    assert.equal(codexSignIn(), null);
  } finally {
    delete process.env.CODEX_HOME;
  }
});

test("check lists, among its standing limits, that an agent's home is that agent's", () => {
  const w = inspect(mk(), null, "x").limits.find((x) => x.kind === "agent-sign-in");
  assert.ok(w);
  assert.match(w.detail, /--agent codex/);
  assert.match(w.detail, /cli_auth_credentials_store/);
});

/* ── against the kernel ──────────────────────────────────────────────── */

let repo;
function loadPolicy(toml) {
  const dir = scratch("codex2-pol-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return loadConfig(join(dir, "seisin.toml"));
}

const skip = srtSkip();
function runAs(args, line) {
  return spawnSync(process.execPath, [CLI, "run", "dev", ...args, "--", "sh", "-c", line],
    { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: home } });
}

test("a run that is not Codex cannot read Codex's sign-in; a Codex run can", { skip }, () => {
  repo = boxed("codex2-repo-");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "seisin.toml"), '[roles.dev]\nwrites = ["src/**"]\n');
  const auth = join(home, ".codex", "auth.json");
  const creds = join(home, ".claude", ".credentials.json");
  // The control: a write the role is entitled to, so a run that failed for
  // another reason cannot pass as a refusal.
  const plain = runAs([], `echo ok > src/c1; cat "${auth}"`);
  assert.ok(existsSync(join(repo, "src", "c1")), plain.stderr);
  assert.notEqual(plain.status, 0);
  assert.doesNotMatch(plain.stdout, /rt-codex-2/);
  const asClaude = runAs(["--agent", "claude"], `cat "${creds}" >/dev/null && cat "${auth}"`);
  assert.notEqual(asClaude.status, 0, "claude reads its own, never codex's");
  assert.doesNotMatch(asClaude.stdout, /rt-codex-2/);
  assert.match(asClaude.stderr, /runs claude/);
  const asCodex = runAs(["--agent", "codex"], `cat "${auth}"`);
  assert.equal(asCodex.status, 0, asCodex.stderr);
  assert.match(asCodex.stdout, /rt-codex-2/, "what stays open, said in check: a Codex run reads its own");
  assert.match(asCodex.stderr, /runs codex/);
});
