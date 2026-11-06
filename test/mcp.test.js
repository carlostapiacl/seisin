/**
 * The MCP server: read only, with schemas, and a session nothing can kill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { serveMcp, TOOLS, HANDLERS, PROTOCOLS } from "../src/mcp.js";
import { PassThrough } from "node:stream";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { loadConfig } from "../src/config.js";

test("the MCP surface has no tool that changes anything", () => {
  // The invariant, as a test and not as a comment. If someone adds a
  // seisin_grant, this goes red before it reaches a release.
  const names = TOOLS.map((t) => t.name);
  const mutating = names.filter((n) => /grant|deny|approve|apply|set|write|update|delete/.test(n));
  assert.deepEqual(mutating, ["seisin_draft_grant"]);   // draft: it writes up, it does not apply
  assert.ok(names.every((n) => typeof HANDLERS[n] === "function"));
});

test("every MCP tool declares a schema a client can render", () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.description, "string");
    assert.equal(t.inputSchema.type, "object");
    for (const req of t.inputSchema.required ?? [])
      assert.ok(t.inputSchema.properties[req], `${t.name}: requires "${req}" but never declares it`);
  }
});

test("version negotiation echoes a known version and offers the newest otherwise", async () => {
  const NL = String.fromCharCode(10);
  const talk = async (version) => {
    const said = [];
    const req = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } };
    await serveMcp("9.9.9", Readable.from([JSON.stringify(req) + NL]), { write: (s) => said.push(s) });
    return JSON.parse(said[0]).result;
  };
  const known = await talk("2025-06-18");
  const unknown = await talk("1999-01-01");
  assert.equal(known.protocolVersion, "2025-06-18");   // known: echoed back as is
  assert.equal(unknown.protocolVersion, PROTOCOLS[0]);   // unknown: ours is offered
  assert.equal(known.serverInfo.version, "9.9.9");
  assert.deepEqual(Object.keys(known.capabilities), ["tools"]);
});

test("a notification is never answered", async () => {
  // Answering a notification is a protocol error some clients tolerate and
  // others hang on.
  const NL = String.fromCharCode(10);
  const said = [];
  const note = { jsonrpc: "2.0", method: "notifications/initialized" };
  await serveMcp("1.0.0", Readable.from([JSON.stringify(note) + NL]), { write: (s) => said.push(s) });
  assert.deepEqual(said, []);
});

test("unparseable input does not kill the session", async () => {
  const NL = String.fromCharCode(10);
  const said = [];
  const ping = { jsonrpc: "2.0", id: 7, method: "ping" };
  await serveMcp("1.0.0", Readable.from(["esto no es json" + NL, JSON.stringify(ping) + NL]),
    { write: (s) => said.push(s) });
  assert.equal(JSON.parse(said[0]).id, 7);   // the junk is dropped and it keeps serving
});

test("SEC-23 tools/call rejects an inherited name and a null params, and coerces no role", async () => {
  const NL = String.fromCharCode(10);
  const call = async (msg) => {
    const said = [];
    await serveMcp("1.0.0", Readable.from([JSON.stringify(msg) + NL]), { write: (s) => said.push(s) });
    return said.map((s) => JSON.parse(s));
  };
  // "constructor" resolves to Object.prototype's — must be an unknown tool, not invoked.
  const [ctor] = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "constructor", arguments: {} } });
  assert.equal(ctor.error?.code, -32602, "an inherited name was treated as a tool");
  // params: null must still get an answer, not hang the request.
  const [nullp] = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: null });
  assert.ok(nullp && (nullp.error || nullp.result), "null params left the request unanswered");
  // role as an array must be refused, not coerced to a string that then answers wrong.
  const [arr] = await call({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "seisin_explain", arguments: { role: ["frontend"], action: "write", target: "x" } } });
  assert.ok(arr.result?.isError, "an array role was coerced instead of refused");
})

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

/* ── the MCP shares the console's arithmetic, and reads the log once ───── */

test("seisin_walls without a role equals asking role by role", async () => {
  const { HANDLERS } = await import("../src/mcp.js");
  const { walls } = await import("../src/walls.js");
  const dir = scratch("seisin-audit-mcp-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.a]\nwrites = ["src/**"]\n\n[roles.b]\nwrites = ["deploy/**"]\n');
  mkdirSync(join(dir, ".seisin"));
  const d = (role, target) => JSON.stringify({ at: "2026-09-28T10:00:00.000Z", role, action: "write", target, verdict: "denied", owners: [] });
  writeFileSync(join(dir, ".seisin", "log.jsonl"),
    [d("a", "deploy/x"), d("a", "deploy/x"), d("a", "deploy/x"), d("b", "src/y"), d("b", "src/y"), d("b", "lib/z")].join("\n") + "\n");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const every = HANDLERS.seisin_walls({});
    const cfg = loadConfig(join(dir, "seisin.toml"));
    for (const r of ["a", "b"]) {
      assert.deepEqual(every.roles[r].walls, walls(cfg, r, { file: join(dir, ".seisin", "log.jsonl") }));
      assert.deepEqual(HANDLERS.seisin_walls({ role: r }).roles[r], every.roles[r]);
    }
    assert.equal(every.spentRetrying, 3);
  } finally { process.chdir(cwd); }
});

test("the MCP server no longer loads node:http to answer", async () => {
  const src = readFileSync(new URL("../src/mcp.js", import.meta.url), "utf8");
  assert.ok(!/from "\.\/serve\.js"/.test(src));
  assert.ok(!/grantFor/.test(src));
});
