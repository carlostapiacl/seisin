/**
 * What the hook reads from a tool call and what it answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { targetsOf, decide } from "../src/hook.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { loadConfig } from "../src/config.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

test("the hook reads a file tool's target, and a shell redirect's", () => {
  assert.deepEqual(targetsOf("Write", { file_path: "src/a.ts" }), [{ action: "write", path: "src/a.ts" }]);
  assert.deepEqual(targetsOf("Bash", { command: "echo x > src/api/hack.ts" }),
    [{ action: "write", path: "src/api/hack.ts" }]);
  assert.deepEqual(targetsOf("Bash", { command: "cat a && tee out.txt" }),
    [{ action: "write", path: "out.txt" }]);
});

test("a command whose target the hook cannot see goes unexplained, not unblocked", () => {
  // The point of the split: this returns nothing, and the kernel still refuses
  // the write. An enforcer with this hole would be broken; an explainer is not.
  assert.deepEqual(targetsOf("Bash", { command: "python -c \"open('src/api/x','w')\"" }), []);
});

test("the hook denies with the owner's name, and says something different for a key", () => {
  const cfg2 = { ...cfg, root: "/repo" };
  const noop = () => true;
  const w = decide(cfg2, "frontend", { tool_name: "Write", tool_input: { file_path: "src/api/s.ts" } }, { now: noop });
  assert.match(w.hookSpecificOutput.permissionDecisionReason, /belongs to backend/);
  const r = decide(cfg2, "frontend", { tool_name: "Read", tool_input: { file_path: ".secrets/database.txt" } }, { now: noop });
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /declared for backend/);
  assert.doesNotMatch(r.hookSpecificOutput.permissionDecisionReason, /to change/);
});

test("observe records the same decisions and returns none of them", () => {
  const seen = [];
  const out = decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Write", tool_input: { file_path: "src/api/s.ts" } },
    { observe: true, now: (_f, e) => seen.push(e) });
  assert.equal(out.decision, null);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(seen[0].verdict, "observed");
});

test("reading an ordinary file is never denied", () => {
  // Territory divides who may change something. An agent that cannot read the
  // rest of the repo cannot work, and the hook denying a plain Read produced a
  // log full of tidy `denied` lines that looked exactly like success.
  const seen = [];
  const out = decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Read", tool_input: { file_path: "src/api/server.ts" } },
    { now: (_f, e) => seen.push(e) });
  assert.equal(out.decision, null);
  assert.deepEqual(seen, []);
});

test("reading a key still is a policy question", () => {
  const seen = [];
  const out = decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Read", tool_input: { file_path: ".secrets/database.txt" } },
    { now: (_f, e) => seen.push(e) });
  assert.equal(out.decision, "deny");
  assert.equal(seen[0].verdict, "denied");
});

test("shell debris does not become a log entry", () => {
  // Reading a command with regular expressions picks up things that are not
  // paths. Each one is a line claiming a role was denied something it never
  // asked for, and a log with invented entries in it stops being read.
  const junk = targetsOf("Bash", { command: 'if [ -w x ] && test -f y; then echo a 2>&1 > /dev/null; fi' });
  assert.deepEqual(junk.map((t) => t.path).filter((p) => ["test", "2>", "2>&1", "/dev/null"].includes(p)), []);
  // and a real target still comes through
  assert.deepEqual(targetsOf("Bash", { command: "echo x > src/api/real.ts" }),
    [{ action: "write", path: "src/api/real.ts" }]);
});

test("the hook answers Claude Code with a denial that names the owner", () => {
  // seisin's side of the promise the README opens with. The kernel only says
  // "Operation not permitted"; this is the only thing that carries the owner
  // into the agent's context.
  const cfg2 = { ...cfg, root: "/repo" };
  for (const tool of ["Write", "Edit"]) {
    const out = decide(cfg2, "frontend", { tool_name: tool, tool_input: { file_path: "src/api/s.ts" } },
                       { now: () => true, ask: () => true });
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", tool);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /belongs to backend/, tool);
  }
});

/** A minimal config to exercise the hook without touching disk. */
function cfgHook() {
  return { root: "/repo", path: "/repo/seisin.toml", keyDirs: [".secrets"], allowedDomains: [],
           roles: { frontend: { name: "frontend", writes: ["src/web/**"], keys: [], network: null },
                    backend: { name: "backend", writes: ["src/api/**"], keys: ["db.txt"], network: null } } };
}

test("a refusal tells the agent the request is already queued", () => {
  // `ask()` filed the request silently: nobody inside the sandbox knew something
  // was pending, so the agent could not tell whoever sent it.
  const out = decide(cfgHook(), "frontend",
    { tool_name: "Write", tool_input: { file_path: "/repo/src/api/orders.ts" } },
    { now() {}, ask() {} });
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Already queued as a handoff to backend/);
});

test("the refusal closes the retry loop and the wait, in both branches", () => {
  const cfg = cfgHook();
  const writeDenial = decide(cfg, "frontend",
    { tool_name: "Write", tool_input: { file_path: "/repo/src/api/orders.ts" } }, { now() {}, ask() {} });
  const keyDenial = decide(cfg, "frontend",
    { tool_name: "Read", tool_input: { file_path: "/repo/.secrets/db.txt" } }, { now() {}, ask() {} });
  for (const o of [writeDenial, keyDenial]) {
    assert.match(o.hookSpecificOutput.permissionDecisionReason, /retrying or waiting/);
  }
  // And the key branch still says nothing about changing anything, which is not
  // what a read is about.
  assert.doesNotMatch(keyDenial.hookSpecificOutput.permissionDecisionReason, /to change/);
});

test("the refusal does not name the MCP server, because the hook cannot know it exists", () => {
  // `wire` writes .claude/settings.json; MCP servers live in another file.
  // Naming a tool the agent may not have costs it a step to find that out. An
  // agent that does have it finds it by its description.
  const out = decide(cfgHook(), "frontend",
    { tool_name: "Write", tool_input: { file_path: "/repo/src/api/orders.ts" } },
    { now() {}, ask() {} });
  assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /mcp|seisin_/i);
});

test("observing says nothing about a queue, because it filed none", () => {
  let asked = 0;
  const out = decide(cfgHook(), "frontend",
    { tool_name: "Write", tool_input: { file_path: "/repo/src/api/orders.ts" } },
    { observe: true, now() {}, ask() { asked++; } });
  assert.equal(out.decision, null);
  assert.equal(asked, 0);
});

const TOML = '[roles.a]\nwrites = ["a/**"]\nkeys = []\n';

function repo(prefix, toml = TOML) {
  const box = scratch(prefix);
  writeFileSync(join(box, "seisin.toml"), toml);
  return box;
}

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
