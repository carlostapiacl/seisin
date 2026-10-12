/**
 * Granting the one file instead of its folder — from the console and from
 * `seisin grant --file`.
 *
 * The queue keys a write by its folder, so granting is a widening unless the
 * person chooses otherwise. Choosing the file must take the same road as the
 * folder (editPolicy, refuseIfBarred, applyGrant), land in the policy as a
 * literal path, and not swallow a later ask for a sibling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { boxed, CLI } from "./_tmp.js";

import { serve } from "../src/serve.js";
import { record, requestsPath, pending, asFileGrant, lastAgentOf, fileOnlyNote } from "../src/requests.js";
import { append, logPath } from "../src/log.js";
import { renderHelp } from "../src/help.js";

const POLICY =
  '[keys]\ndir = ".secrets"\n\n' +
  '[roles.frontend]\nwrites = ["src/web/**"]\nkeys = []\n\n' +
  '[roles.backend]\nwrites = ["src/api/**"]\nkeys = []\n';

function repo({ agent } = {}) {
  const box = boxed("seisin-grantfile-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  mkdirSync(join(box, ".seisin"), { recursive: true });
  mkdirSync(join(box, "src/web/.vscode"), { recursive: true });
  const q = requestsPath(box);
  record(q, { role: "backend", action: "write", target: "docs/api.md", owners: [] });
  if (agent !== undefined)
    append(logPath(box), { event: "canary", role: "backend", run: "r1", agent, confined: true, reasons: [] });
  const toml = () => readFileSync(join(box, "seisin.toml"), "utf8");
  return { box, q, toml };
}

async function consoleOf(t, box) {
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const port = server.address().port;
  return (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-seisin-token": server.seisinToken },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

const cli = (box, ...args) => execFileSync(process.execPath, [CLI, ...args], {
  cwd: box, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
});

test("the console grants the one file as a literal path when asked to", async (t) => {
  const { box, q, toml } = repo();
  const call = await consoleOf(t, box);
  const key = pending(q)[0].key;
  const r = await call("/api/decide", { key, decision: "granted", reason: "only the API page", scope: "file" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.grant, "docs/api.md");
  assert.match(out.line.text, /^"docs\/api\.md"\s+# granted/);
  assert.ok(!toml().includes('"docs/**"'), "the folder was granted anyway");
  assert.equal(pending(q).length, 0);
});

test("the folder is still the default, and a scope that is neither is refused", async (t) => {
  const { box, q, toml } = repo();
  const call = await consoleOf(t, box);
  const key = pending(q)[0].key;
  const bad = await call("/api/decide", { key, decision: "granted", reason: "x", scope: "everything" });
  assert.equal(bad.status, 400);
  assert.equal(toml(), POLICY);
  const ok = await (await call("/api/decide", { key, decision: "granted", reason: "the docs" })).json();
  assert.equal(ok.grant, "docs/**");
});

test("after a one-file grant, a sibling reopens the request; the same file does not", () => {
  const { q } = repo();
  const key = pending(q)[0].key;
  // What a grant writes, without the policy: the queue is the subject here.
  writeFileSync(q, readFileSync(q, "utf8") + JSON.stringify({ at: new Date().toISOString(), kind: "granted", key, reason: "x", only: "docs/api.md" }) + "\n");
  assert.equal(pending(q).length, 0);
  record(q, { role: "backend", action: "write", target: "docs/api.md", owners: [] });
  assert.equal(pending(q).length, 0, "the granted file came back as a question");
  record(q, { role: "backend", action: "write", target: "docs/guide.md", owners: [] });
  const open = pending(q);
  assert.equal(open.length, 1, "a sibling folded into the settled request");
  assert.equal(open[0].key, key);
  assert.equal(open[0].target, "docs/guide.md");
  assert.equal(open[0].grant, "docs/**");
  assert.equal(open[0].times, 1);
});

test("a protected file is refused as a file too, through the same check", async (t) => {
  const { box, q, toml } = repo();
  record(q, { role: "frontend", action: "write", target: "src/web/.vscode/settings.json", owners: ["frontend"] });
  const call = await consoleOf(t, box);
  const key = pending(q).find((r) => r.role === "frontend").key;
  const r = await call("/api/decide", { key, decision: "granted", reason: "x", scope: "file" });
  assert.notEqual(r.status, 200);
  assert.match((await r.json()).error, /protected/);
  assert.equal(toml(), POLICY);
});

test("seisin grant --file writes the file and names the Claude Code caveat for a role that runs it", () => {
  const { box, toml, q } = repo({ agent: "claude" });
  const said = cli(box, "grant", "1", "--file", "--reason", "only this page");
  assert.match(said, /granted\s+backend → docs\/api\.md/);
  assert.match(said, /backend runs Claude Code/);
  assert.match(toml(), /"docs\/api\.md"\s+# granted .*«only this page»/);
  assert.equal(pending(q).length, 0);
});

test("seisin grant --file says nothing about Claude Code for a role that runs another agent", () => {
  const { box } = repo({ agent: "codex" });
  assert.doesNotMatch(cli(box, "grant", "--file", "1"), /Claude Code/);
});

test("--file is refused for a key, which is already one file", () => {
  assert.throws(() => asFileGrant({ key: "a:read:x", action: "read", target: "stripe.txt" }), /already one file/);
  assert.throws(() => asFileGrant({ key: "a:write:d", action: "write", target: "d/**" }), /not one file/);
});

test("the console's state carries the caveat once per narrowable request", async (t) => {
  const { box } = repo({ agent: "claude" });
  const call = await consoleOf(t, box);
  const s = await (await call("/api/state")).json();
  assert.match(s.requests[0].fileNote, /backend runs Claude Code/);
});

test("the last agent is read off the canary line, and unknown is said conditionally", () => {
  const log = [{ event: "canary", role: "a", agent: "claude" }, { event: "canary", role: "a", agent: "codex" }, { event: "canary", role: "b" }];
  assert.equal(lastAgentOf(log, "a"), "codex");
  assert.equal(lastAgentOf(log, "b"), null);
  assert.equal(fileOnlyNote("a", "codex"), "");
  assert.match(fileOnlyNote("b", null), /^If b runs Claude Code/);
});

test("help and the page offer the choice", () => {
  assert.match(renderHelp("grant", new Proxy({}, { get: () => "" })), /--file/);
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /value="file"> only the file/);
  assert.match(html, /scope: granting \? pick\.scope : "folder"/);
});
