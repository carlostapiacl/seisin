/**
 * What crosses from inside the sandbox runs on the parent's one thread, where a
 * run's signals are handled too. Its cost is capped: a line's length, and the
 * matching done on what is on the line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { join } from "node:path";
import { spool } from "../src/spool.js";
import { mcpServer, decide } from "../src/hook.js";
import { destinationOf } from "../src/intake.js";
import { trimEnd } from "../src/lines.js";
import { defaultName } from "../src/keys.js";
import { normalize } from "../src/owners.js";
import { boxed, scratch } from "./_tmp.js";

const send = (path, text) => new Promise((ok) => {
  const c = createConnection(path, () => c.end(text));
  c.on("close", ok);
  c.on("error", () => {});
});

test("a line longer than any path is dropped with its connection; the next connection is heard", async () => {
  const got = [];
  const s = await spool((to, entry) => got.push(entry.target), join(scratch("sc-"), "s.sock"));
  const line = (target) => JSON.stringify({ to: "log", entry: { target } }) + "\n";
  await send(s.path, line("../".repeat(300_000)));
  await send(s.path, line("x".repeat(4096)));
  await send(s.path, line("src/a.ts"));
  s.close();
  assert.deepEqual(got.map((t) => t.length), [4096, 8]);
});

test("mcpServer reads what it read, in linear time", () => {
  for (const [tool, server] of [
    ["mcp__wapentake__get_task", "wapentake"], ["mcp__claude_ai_Gmail__send", "claude_ai_Gmail"],
    ["mcp__a__b__c", "a"], ["mcp____b", null], ["mcp__a__", null], ["mcp__a", null], ["mcp__", null],
    ["Read", null], ["mcp__a__b\n", null], [42, null],
  ]) assert.equal(mcpServer(tool), server, String(tool));
  const at = performance.now();
  mcpServer("mcp__a__" + "a__a".repeat(250_000) + "\n");
  assert.ok(performance.now() - at < 200);
});

test("destinationOf reads what it read, in linear time", () => {
  for (const [t, d] of [
    ["src/health.ts.tmp.48213.3fa9", "src/health.ts"], ["src/a.tmp.b.tmp.c", "src/a.tmp.b"], ["ab.tmp.c.tmp.", "ab"],
    ["src/.tmp.x", null], ["a/.tmp.b/c", null], ["src/a.tmp.", null], ["src/a.tmp/b", null], ["a.tmp.b", null],
  ]) assert.equal(destinationOf(t), d, t);
  const at = performance.now();
  destinationOf("a" + ".tmp.x".repeat(170_000) + "/");
  assert.ok(performance.now() - at < 200);
});

test("apply_patch names the same files", () => {
  const dir = boxed("spool-patch-");
  const seen = [];
  decide({ root: dir, roles: { r: { name: "r", writes: ["**"], neverWrites: [], keys: [] } }, keyDirs: [] }, "r",
    { hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: dir,
      tool_input: { command: "*** Begin Patch\n*** Update File: a.ts  \n*** Move to: b.ts\r\n+*** Add File: no.ts\n*** Add File:   \n*** Delete File: a.ts\n*** End Patch" } },
    { now: (_, e) => seen.push(e.target), ask: () => {} });
  assert.deepEqual(seen, ["a.ts", "b.ts"]);
});

test("the trims leave what they left", () => {
  assert.equal(trimEnd("a//"), "a");
  assert.equal(trimEnd("a/b"), "a/b");
  assert.equal(trimEnd("//"), "");
  assert.equal(trimEnd("A__", "_"), "A");
  assert.equal(normalize("a//b///"), "a/b");
  assert.equal(defaultName("vault/__my-key__"), "MY_KEY");
});
