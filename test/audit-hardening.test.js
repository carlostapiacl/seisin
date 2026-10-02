import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { scratch } from "./_tmp.js";
import { loadConfig } from "../src/config.js";
import { renderObserved } from "../src/commands/init.js";
import { grant } from "../src/commands/requests.js";
import { record, pending, requestsPath, applyGrant } from "../src/requests.js";
import { redactor } from "../src/redact.js";
import { readFileRef, parseKey, resolveKeys } from "../src/keys.js";
import { scan } from "../src/scan.js";
import { serveMcp } from "../src/mcp.js";

function policy(text) {
  const root = scratch("seisin-audit-");
  const path = join(root, "seisin.toml");
  writeFileSync(path, text);
  return loadConfig(path);
}

test("an observation proposal preserves every policy setting and its comments", () => {
  const text = `# policy chosen by a person
[runtime]
isolate = "credentials"
writes = []
redact = false
[protect]
instructions = true
[scan]
ignore = ["archive/**"]
[keys]
dir = [".secrets", "shared"]
[keys.providers.vault]
command = ["vault", "read", "{ref}"]
mode = "scratch"
[network]
allow = ["api.example.test"]
  [roles.dev] # developer
  writes = ["src/**"] # approved territory
keys = ["TOKEN=vault://token"]
key_mode = "scratch"
env = ["BUILD_FLAG"]
network = []
never_writes = ["src/private/**"]
mcp = []
local_ports = [8001]
local_binding = false
trustd = false
control_files = ["ide"]
[roles.idle]
writes = ["api/**"]
keys = []
never_writes = ["api/private/**"]
`;
  const cfg = policy(text);
  const { toml } = renderObserved(cfg, [{ role: "dev", action: "write", target: "docs/a.md" }]);
  const after = loadConfig(cfg.path, toml);
  assert.deepEqual({ ...after, roles: null }, { ...cfg, roles: null });
  assert.deepEqual(after.roles.idle, cfg.roles.idle);
  const strip = ({ writes, writesDeclared, ...rest }) => rest;
  assert.deepEqual(strip(after.roles.dev), strip(cfg.roles.dev));
  assert.deepEqual(after.roles.dev.writes, ["src/**", "docs/**"]);
  assert.ok(toml.includes("# approved territory"));
  assert.ok(toml.includes("# policy chosen by a person"));
  assert.ok(toml.includes("  [roles.dev] # developer"));
});

test("an observation proposal keeps a read in its declared key directory", () => {
  const cfg = policy('[keys]\ndir = [".secrets", "shared"]\n[roles.dev]\nwrites = []\nkeys = []\n');
  const { toml } = renderObserved(cfg, [
    { role: "dev", action: "read", kind: "key", target: "shared/token.txt" },
    { role: "dev", action: "read", kind: "key", target: ".secrets/one.txt" },
  ]);
  assert.deepEqual(loadConfig(cfg.path, toml).roles.dev.keys, ["shared/token.txt", "one.txt"]);
});

test("an observation proposal inserts an omitted list without dropping other settings", () => {
  const cfg = policy('[roles.dev]\nmcp = []\nnetwork = []\n');
  const { toml } = renderObserved(cfg, [{ role: "dev", action: "write", target: "docs/a.md" }]);
  const after = loadConfig(cfg.path, toml);
  assert.deepEqual(after.roles.dev.writes, ["docs/**"]);
  assert.deepEqual(after.roles.dev.mcp, []);
  assert.deepEqual(after.roles.dev.network, []);
  assert.match(toml, /# set from observation/);
  assert.doesNotMatch(toml, /set in the console/);
});

test("older observations cannot resurrect a removed role or turn a host path into territory", () => {
  const cfg = policy('[roles.dev]\nwrites = []\nkeys = []\n');
  const { toml } = renderObserved(cfg, [
    { role: "removed", action: "write", target: "elsewhere/a.md" },
    { role: "dev", action: "write", target: "/outside/seisin-observation/a.md" },
    { role: "dev", action: "write", target: "../outside/a.md" },
  ]);
  const after = loadConfig(cfg.path, toml);
  assert.deepEqual(Object.keys(after.roles), ["dev"]);
  assert.deepEqual(after.roles.dev.writes, []);
});

test("grant checks the policy under the lock, including a newly added subtraction", () => {
  const cfg = policy('[roles.dev]\nwrites = []\nkeys = []\n');
  mkdirSync(join(cfg.root, "private"));
  record(requestsPath(cfg.root), { role: "dev", action: "write", target: "private/a.md" });
  const before = '[roles.dev]\nwrites = []\nkeys = []\nnever_writes = ["private/**"]\n';
  writeFileSync(cfg.path, before);
  assert.throws(() => grant(cfg, ["1"]), /never_writes/);
  assert.equal(readFileSync(cfg.path, "utf8"), before);
  assert.equal(pending(requestsPath(cfg.root)).length, 1);
});

test("an invalid grant leaves both the policy and the pending decision untouched", () => {
  const cfg = policy('[roles.dev]\nwrites = []\nkeys = []\n');
  record(requestsPath(cfg.root), { role: "dev", action: "write", target: "/outside/seisin-audit/a.md" });
  const before = readFileSync(cfg.path, "utf8");
  assert.throws(() => grant(cfg, ["1"]), /absolute/);
  assert.equal(readFileSync(cfg.path, "utf8"), before);
  assert.equal(pending(requestsPath(cfg.root)).length, 1);
});

test("grant reads commented headers and indented lists, keeping CRLF and the next role", () => {
  const before = '  [roles.dev] # current\r\n  writes = ["src/**"] # keep\r\nkeys = []\r\n  [roles.other] # next\r\nwrites = ["api/**"]\r\n';
  const { toml } = applyGrant(before, { role: "dev", action: "write", grant: "docs/**", times: 1 });
  const cfg = policy(toml);
  assert.deepEqual(cfg.roles.dev.writes, ["src/**", "docs/**"]);
  assert.deepEqual(cfg.roles.other.writes, ["api/**"]);
  assert.ok(toml.endsWith('  [roles.other] # next\r\nwrites = ["api/**"]\r\n'));
  assert.doesNotMatch(toml, /(?<!\r)\n/);
});

test("atomic policy edits retain the policy's private file mode", () => {
  const cfg = policy('[roles.dev]\nwrites = []\nkeys = []\n');
  chmodSync(cfg.path, 0o600);
  record(requestsPath(cfg.root), { role: "dev", action: "write", target: "docs/a.md" });
  grant(cfg, ["1"]);
  assert.equal(statSync(cfg.path).mode & 0o777, 0o600);
});

test("a directory at the lock name respects the deadline instead of spinning forever", () => {
  const base = join(scratch("seisin-audit-lock-"), "log");
  mkdirSync(base + ".lock");
  const module = new URL("../src/log.js", import.meta.url).href;
  const script = `import { withLock } from ${JSON.stringify(module)};
    try { withLock(${JSON.stringify(base)}, () => {}, { waitMs: 30 }); process.exit(9); }
    catch (e) { if (e.code !== 'ELOCKED') throw e; }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 2000 });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr);
});

test("the public redactor masks split credentials even when the caller gives an unsorted list", async () => {
  const secret = "synthetic-long-credential-for-test";
  const r = redactor(["short", secret, "", secret]);
  let output = "";
  r.on("data", (c) => { output += c; });
  const end = once(r, "end");
  for (const part of ["before ", secret.slice(0, 20), secret.slice(20), " after short"]) r.write(part);
  r.end();
  await end;
  assert.equal(output, "before ‹redacted› after ‹redacted›");
});

test("a JSON credential fragment resolves only properties that are present in the file", () => {
  const cfg = policy('[roles.dev]\nwrites = []\n');
  writeFileSync(join(cfg.root, "key.json"), '{"credentials":{"token":"synthetic-token"}}');
  assert.equal(readFileRef(parseKey("T=file://key.json#credentials.token"), cfg.root), "synthetic-token");
  for (const key of ["credentials.toString", "credentials.constructor.name", "credentials.__proto__.constructor.name"])
    assert.throws(() => readFileRef(parseKey(`T=file://key.json#${key}`), cfg.root), /has no/);
});

test("dotenv syntax errors do not echo the credential text after a closing quote", () => {
  const cfg = policy('[roles.dev]\nwrites = []\n');
  writeFileSync(join(cfg.root, "keys.env"), 'TOKEN="prefix" synthetic-secret-after-quote\n');
  assert.throws(() => readFileRef(parseKey("T=file://keys.env#TOKEN"), cfg.root), (e) => {
    assert.match(e.message, /text after its closing quote/);
    assert.doesNotMatch(e.message, /synthetic-secret/);
    return true;
  });
});

test("reference resolution accepts the same hand-built role shape as the public settings API", () => {
  const cfg = { root: ".", keyProviders: { p: { command: ["provider", "{ref}"], mode: "env" } } };
  const role = { name: "dev", keys: ["T=p://token"] };
  const got = resolveKeys(cfg, role, { run: () => ({ status: 0, stdout: "synthetic-value", stderr: "" }) });
  assert.equal(got[0].value, "synthetic-value");
});

test("scan treats an absolute protected directory exactly like its relative spelling", () => {
  const root = scratch("seisin-audit-scan-");
  mkdirSync(join(root, ".secrets"));
  writeFileSync(join(root, ".secrets", "token.txt"), "ghp_" + "a".repeat(30));
  assert.deepEqual(scan(root, [join(root, ".secrets")]), scan(root, [".secrets"]));
  assert.equal(scan(root).hits.filter((h) => h.level === "certain").length, 1);
});

async function mcpReplies(chunks) {
  const input = new PassThrough();
  let out = "";
  const done = serveMcp("test", input, { write(s) { out += s; } });
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await done;
  return out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("MCP answers each bounded message in a burst larger than the per-message cap", async () => {
  const ping = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping", padding: "x".repeat(600_000) }) + "\n";
  const replies = await mcpReplies([ping(1) + ping(2)]);
  assert.deepEqual(replies.map((r) => r.id), [1, 2]);
});

test("MCP discards a whole oversized frame and recovers only after its newline", async () => {
  const ping = (id) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n";
  const replies = await mcpReplies(["x".repeat(1_000_001), ping(1) + ping(2)]);
  assert.deepEqual(replies.map((r) => r.id), [2]);
});

test("MCP's frame cap counts UTF-8 bytes, and a later valid message still works", async () => {
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "ñ".repeat(600_000) });
  const replies = await mcpReplies([big + '\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n']);
  assert.deepEqual(replies.map((r) => r.id), [2]);
});
