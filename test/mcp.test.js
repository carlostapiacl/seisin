/**
 * The MCP server: read only, with schemas, and a session nothing can kill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { serveMcp, TOOLS, HANDLERS, PROTOCOLS } from "../src/mcp.js";

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
