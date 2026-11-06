/**
 * How an entry reaches the parent, and what a spool does when nobody can listen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { tmpdir } from "node:os";
import { spool, send, flush } from "../src/spool.js";

test("the spool carries an entry to the parent, and the parent picks the file", async (t) => {
  // The only verb reachable from inside is "send a line": there is no
  // descriptor, so there is no seek, truncate or unlink. And the sender does
  // not pick the path — it names a destination and the parent decides what it
  // means.
  const got = [];
  const s = await spool((to, entry) => got.push([to, entry]), join(tmpdir(), `seisin-t${process.pid}.sock`));
  t.after(() => s.close());

  send("log", { role: "frontend", verdict: "denied" }, s.path);
  send("requests", { role: "qa", action: "write" }, s.path);
  send("otro-lado", { role: "qa" }, s.path);            // made-up destination
  send("log", "no soy un objeto", s.path);
  await flush();
  // Until they arrive, not a fixed 60 ms: on a loaded machine (load 165) and on
  // Linux, 60 ms was not enough and the test failed with nothing wrong.
  for (const end = Date.now() + 5000; got.length < 3 && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(got.map((g) => g[0]), ["log", "requests", "log"]);
  assert.equal(got[0][1].role, "frontend");
  assert.ok(got[0][1].at, "the timestamp is from the moment of the decision, not from when the parent read it");
});

test("closing the spool removes the socket and nothing around it", async (t) => {
  // A regression with teeth. close() removed dirname(path) on the reasoning
  // that spoolPath() had just created that directory — but a caller passing its
  // own path makes dirname the system temp, so closing the spool removed all of
  // it. CI found it: everything after it failed with ENOENT on mkdtemp.
  const dir = scratch("seisin-vecino-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const neighbour = join(dir, "no-me-toques.txt");
  writeFileSync(neighbour, "acá estaba\n");

  const s = await spool(() => {}, join(dir, "spool.sock"));
  s.close();

  assert.ok(existsSync(dir), "the spool took the caller's directory with it");
  assert.ok(existsSync(neighbour), "the spool took a file that was not its own");
  assert.ok(!existsSync(join(dir, "spool.sock")), "the socket was left behind");
});

test("with no parent listening, send says so instead of pretending", () => {
  // With no parent, append() falls back to the file. If send() lied, the hook
  // would believe it had recorded and the log would stay empty for a run that
  // worked — which is exactly how this instrument broke the first time.
  assert.equal(send("log", { role: "x" }, undefined), false);
  assert.equal(send("log", { role: "x" }, ""), false);
});

/**
 * The regression that hid behind Node's "unsettled top-level await": a spool
 * that cannot bind used to leave the promise pending forever instead of
 * failing, so the caller died with rc=13 and no reason given.
 */
test("a spool that cannot bind rejects instead of hanging", async () => {
  await assert.rejects(
    () => spool(() => {}, "/no-such-directory-for-seisin/spool.sock"),
    (e) => typeof e.code === "string",
  );
});
