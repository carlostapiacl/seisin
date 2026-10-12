/**
 * `private = ["dir/**"]`: a folder one role reads and writes, and no other.
 *
 * Asked for from use: keys are read and never written, and a territory is
 * read by every role — so material that had to be written by one role ended
 * up readable by all of them the moment it was moved where it could be
 * written. These hold the policy, the sentence and the kernel to one answer:
 * the owner reads and writes, everyone else is denied both, in every read
 * mode and under isolate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { explain, ownersOf, privateOwner } from "../src/owners.js";
import { inspect } from "../src/inspect.js";
import { decide } from "../src/hook.js";
import { refuseIfBarred } from "../src/requests.js";
import { atSessionStart } from "../src/diagnose.js";
import { srtSkip, repoWith, CLI } from "./_tmp.js";

const POLICY = (runtime = "writes = []") =>
  `[runtime]\n${runtime}\n\n` +
  `[roles.owner]\nwrites = ["src/**"]\nprivate = ["vault/**"]\n\n` +
  `[roles.other]\nwrites = ["**"]\n`;

const repo = (runtime) => repoWith("private-", POLICY(runtime), ["src/", "vault/"]);
const load = (root) => loadConfig(join(root, "seisin.toml"));

/* ── the policy ─────────────────────────────────────────────────────── */

test("private is part of the owner's territory, and only the owner's", () => {
  const config = load(repo());
  assert.deepEqual(config.roles.owner.private, ["vault/**"]);
  assert.ok(config.roles.owner.writes.includes("vault/**"));
  assert.deepEqual(config.roles.owner.writesDeclared, ["src/**"]);
  // other's `**` covers vault, and still does not own it
  assert.deepEqual(ownersOf(config, "vault/notes.md"), ["owner"]);
  assert.deepEqual(ownersOf(config, "src/a.js").sort(), ["other", "owner"]);
  assert.deepEqual(privateOwner(config, `${config.root}/vault/x`), { role: "owner", entry: "vault/**" });
  assert.equal(privateOwner(config, "vaultx/y"), null, "a sibling with the same prefix is not inside");
});

test("a private entry that cannot be one folder in the repo is refused at load", () => {
  const bad = (entry) => {
    const root = repoWith("private-bad-", `[roles.a]\nprivate = ["${entry}"]\n`);
    return () => load(root);
  };
  assert.throws(bad("/etc/**"), /absolute/);
  assert.throws(bad("../up/**"), /"\.\."/);
  assert.throws(bad("**"), /whole repo/);
  assert.throws(bad("."), /whole repo/);
  assert.throws(bad("docs/*.md"), /pattern.*"docs\/\*\*"/);
});

test("two roles cannot own the same private folder, nor one inside the other", () => {
  const same = repoWith("private-same-", `[roles.a]\nprivate = ["vault/**"]\n\n[roles.b]\nprivate = ["vault"]\n`);
  assert.throws(() => load(same), /roles\.a\.private "vault\/\*\*" and roles\.b\.private "vault" are the same folder/);
  const nested = repoWith("private-nested-", `[roles.a]\nprivate = ["vault/**"]\n\n[roles.b]\nprivate = ["vault/b/**"]\n`);
  assert.throws(() => load(nested), /roles\.a\.private .* and roles\.b\.private .* overlap/);
  // One role may list two, and two roles may each have their own.
  const fine = repoWith("private-fine-", `[roles.a]\nprivate = ["one/**", "two"]\n\n[roles.b]\nprivate = ["three/**"]\n`);
  assert.doesNotThrow(() => load(fine));
});

/* ── the settings ───────────────────────────────────────────────────── */

for (const runtime of ["writes = []", 'read = "territory"\nwrites = []', 'isolate = "home"', 'isolate = "credentials"\nwrites = []']) {
  test(`the settings: every other role is denied the folder both ways, the owner neither (${runtime.replace(/\n/g, ", ")})`, () => {
    const config = load(repo(runtime));
    const dir = join(config.root, "vault");
    const other = settingsFor(config, "other").filesystem;
    assert.ok(other.denyRead.includes(dir), "other: denyRead");
    assert.ok(other.denyWrite.includes(dir), "other: denyWrite");
    assert.ok(!other.allowRead.some((p) => p === dir || p.startsWith(dir + "/")), "deny-only: no allow anywhere near it");
    const owner = settingsFor(config, "owner").filesystem;
    assert.ok(!owner.denyRead.includes(dir) && !owner.denyWrite.includes(dir), "owner: not denied");
    assert.ok(owner.allowWrite.includes(dir), "owner: writes it");
  });
}

/* ── the sentence ───────────────────────────────────────────────────── */

test("explain: denied to another role for reading and writing, and why; allowed to the owner", () => {
  const config = load(repo());
  for (const action of ["read", "write"]) {
    const v = explain(config, "other", action, "vault/plan.md");
    assert.equal(v.allowed, false, action);
    assert.equal(v.privateTo, "owner");
    assert.match(v.reason, /owner's private folder \(private = \["vault\/\*\*"\]\)/);
    assert.match(v.reason, /nothing to grant/);
    assert.equal(explain(config, "owner", action, "vault/plan.md").allowed, true, `owner ${action}`);
  }
  assert.match(explain(config, "owner", "read", "vault/plan.md").reason, /no other role does/);
  // The rest of other's territory is untouched.
  assert.equal(explain(config, "other", "write", "src/a.js").allowed, true);
  assert.equal(explain(config, "other", "read", "src/a.js").allowed, true);
});

test("check: the map shows the private folder, and warns that it is inside another role's territory", () => {
  const config = load(repo());
  const report = inspect(config);
  assert.deepEqual(report.roles.find((r) => r.name === "owner").private, ["vault/**"]);
  const w = report.warnings.find((x) => x.kind === "private-inside-territory");
  assert.ok(w, "warned");
  assert.match(w.headline, /owner: private "vault\/\*\*" is inside other's writes \("\*\*"\)/);
  assert.ok(!report.shared.includes("vault/**"), "not reported as shared: it has one owner");
});

test("the hook refuses another role's read of the folder before the kernel does, and queues nothing", () => {
  const config = load(repo());
  const asked = [];
  const opts = { now: () => {}, ask: (_q, r) => asked.push(r) };
  const evt = (file_path) => ({ tool_name: "Read", tool_input: { file_path } });
  const out = decide(config, "other", evt(join(config.root, "vault", "plan.md")), opts);
  assert.equal(out.decision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /private folder.*Nothing was queued/);
  assert.equal(asked.length, 0, "no request: no grant opens it");
  assert.equal(decide(config, "owner", evt(join(config.root, "vault", "plan.md")), opts).decision, null);
  assert.equal(decide(config, "other", evt(join(config.root, "src", "a.js")), opts).decision, null);
});

test("a grant into another role's private folder is refused: it would open nothing", () => {
  const config = load(repo());
  assert.throws(() => refuseIfBarred(config, { role: "other", action: "write", target: "vault/x" }), /owner's private folder/);
  assert.doesNotThrow(() => refuseIfBarred(config, { role: "owner", action: "write", target: "vault/x" }));
});

test("the session-start map tells each role what is private, to it and to others", () => {
  const config = load(repo());
  const text = (role) => atSessionStart(config, role, {}).hookSpecificOutput.additionalContext;
  assert.match(text("owner"), /Private to you.*vault\/\*\*/);
  assert.match(text("other"), /Private to another role — you can neither read nor write it: vault\/\*\* \(owner\)/);
});

/* ── the kernel ─────────────────────────────────────────────────────── */

const skip = srtSkip();
const LINUX = process.platform === "linux";
const run = (cwd, role, script) => new Promise((ok) => {
  let out = "";
  const p = spawn(process.execPath, [CLI, "run", role, "--agent", "none", "--", "/bin/sh", "-c", script], { cwd });
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => ok({ out, code }));
});

for (const runtime of ["writes = []", 'read = "territory"\nwrites = []', 'isolate = "home"', 'isolate = "credentials"\nwrites = []']) {
  test(`against the kernel: only the owner reads and writes its private folder (${runtime.replace(/\n/g, ", ")})`, { skip }, async () => {
    const root = repo(runtime);
    writeFileSync(join(root, "vault", "secret.md"), "PRIVATE-CONTENT\n");
    writeFileSync(join(root, "src", "open.md"), "OPEN-CONTENT\n");

    const other = await run(root, "other",
      `cat vault/secret.md 2>/dev/null; ls vault 2>/dev/null | grep -q secret && echo LISTED; ` +
      `(echo x > vault/new) 2>/dev/null && echo WROTE-VAULT; ` +
      `(echo x >> vault/secret.md) 2>/dev/null && echo APPENDED; ` +
      `cat src/open.md; echo y > src/by-other && echo GRANT-OK`);
    assert.equal(other.code, 0, other.out);
    assert.doesNotMatch(other.out, /PRIVATE-CONTENT/, "other cannot read the private file");
    assert.doesNotMatch(other.out, /LISTED/, "other cannot list the private folder");
    // What reaches the folder is the measure. macOS refuses the write; Linux
    // answers a read-denied directory with an empty tmpfs (the runtime's
    // shape), so the shell's write succeeds there into memory that is thrown
    // away with the run — and the folder on disk is untouched either way.
    if (LINUX) assert.match(other.out, /WROTE-VAULT/, "Linux: the write lands in a throwaway tmpfs");
    else assert.doesNotMatch(other.out, /WROTE-VAULT|APPENDED/, "macOS: other cannot write into it");
    assert.ok(!existsSync(join(root, "vault", "new")), "nothing other wrote reaches the folder");
    assert.equal(readFileSync(join(root, "vault", "secret.md"), "utf8"), "PRIVATE-CONTENT\n", "nor changes what is in it");
    assert.match(other.out, /OPEN-CONTENT/, "positive control: other reads outside it");
    assert.match(other.out, /GRANT-OK/, "positive control: other writes its territory");
    // The refusals the kernel reports (macOS) are the policy, not a missing
    // grant: none of them becomes a request a person is asked to approve.
    const queue = join(root, ".seisin", "requests.jsonl");
    const queued = existsSync(queue) ? readFileSync(queue, "utf8") : "";
    assert.doesNotMatch(queued, /vault/, "nothing queued for the private folder");

    const owner = await run(root, "owner",
      `cat vault/secret.md && echo z > vault/by-owner && echo OWNER-WROTE`);
    assert.equal(owner.code, 0, owner.out);
    assert.match(owner.out, /PRIVATE-CONTENT/, "positive control: the owner reads it");
    assert.match(owner.out, /OWNER-WROTE/, "positive control: the owner writes it");
    assert.equal(readFileSync(join(root, "vault", "by-owner"), "utf8"), "z\n");
  });
}

test("against the kernel: a private folder that does not exist yet is shut to the others once it does", { skip }, async () => {
  const root = repoWith("private-late-", POLICY(), ["src/"]);
  // Linux makes it first (bubblewrap cannot deny a missing path without
  // planting something); macOS denies the pattern whether it exists or not.
  const other = await run(root, "other", `mkdir -p vault 2>/dev/null; (echo x > vault/f) 2>/dev/null && echo WROTE; echo done`);
  assert.match(other.out, /done/, other.out);
  if (!LINUX) assert.doesNotMatch(other.out, /WROTE/);
  assert.ok(!existsSync(join(root, "vault", "f")), "nothing other wrote reaches the folder");
  mkdirSync(join(root, "vault"), { recursive: true });
  const owner = await run(root, "owner", `echo y > vault/f && echo OWNER-WROTE`);
  assert.match(owner.out, /OWNER-WROTE/, owner.out);
});
