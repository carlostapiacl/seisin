/**
 * Deciding in the console: token, grants, declines and what the page is told.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { record, settle, pending } from "../src/requests.js";
import { serve } from "../src/serve.js";
import { symlinkSync, mkdirSync } from "node:fs";
import { requestsPath } from "../src/requests.js";
import { loadConfig } from "../src/config.js";

/** Starts the console on a fake repo and returns how to talk to it. */
async function startConsole(t) {
  const box = scratch("seisin-ui-");
  writeFileSync(join(box, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\nkeys   = []\n');
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "frontend", action: "write", target: "src/api/checkout/a.ts", owners: ["backend"] });

  const server = await serve(join(box, "seisin.toml"), 0);
  const port = server.address().port;
  t.after(() => server.close());

  // The token no longer travels in the page: `seisin ui` puts it in the link's
  // fragment. The test takes it from where `ui` takes it.
  const token = server.seisinToken;
  const post = (body, tok = token) =>
    fetch(`http://127.0.0.1:${port}/api/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok ? { "x-seisin-token": tok } : {}) },
      body: JSON.stringify(body),
    });
  const key = pending(q)[0].key;
  return { box, port, token, post, key, q };
}

test("the console refuses a write without the token", async (t) => {
  // Loopback is not a boundary against the browser: any open tab can POST to
  // 127.0.0.1. What it cannot do is read this token.
  const { token, post, box, key } = await startConsole(t);
  assert.match(token ?? "", /^[a-f0-9]{48}$/);

  const noToken = await post({ key, decision: "granted" }, null);
  assert.equal(noToken.status, 403);
  const wrongToken = await post({ key, decision: "granted" }, "0".repeat(48));
  assert.equal(wrongToken.status, 403);
  // and nothing changed on disk
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
});

test("granting in the console writes the policy, with its reason", async (t) => {
  const { post, box, key } = await startConsole(t);
  const r = await post({ key, decision: "granted", reason: "takes over checkout" });
  assert.equal(r.status, 200);

  const toml = readFileSync(join(box, "seisin.toml"), "utf8");
  assert.match(toml, /src\/api\/checkout\/\*\*/);
  assert.match(toml, /takes over checkout/);     // the provenance travels with the line
  assert.equal(pending(join(box, ".seisin", "requests.jsonl")).length, 0);
});

test("declining in the console settles the request and grants nothing", async (t) => {
  const { post, box, key } = await startConsole(t);
  assert.equal((await post({ key, decision: "declined", reason: "not theirs" })).status, 200);
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
  assert.equal(pending(join(box, ".seisin", "requests.jsonl")).length, 0);
});

test("the console stores a decline as \"declined\", and refuses the old \"denied\"", async (t) => {
  // A person declines; the boundary denies. The console used to post "denied"
  // for a decline and the queue stored it; since 0.6.0 neither does.
  const { post, box, key } = await startConsole(t);
  const old = await post({ key, decision: "denied", reason: "not theirs" });
  assert.equal(old.status, 400);
  assert.match((await old.json()).error, /granted or declined/);
  assert.equal((await post({ key, decision: "declined", reason: "not theirs" })).status, 200);
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
  const lines = readFileSync(join(box, ".seisin", "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).kind, "declined");
});

test("the console refuses a decision it does not understand", async (t) => {
  const { post, box, key } = await startConsole(t);
  for (const body of [{ key: "frontend:write:nope/**", decision: "granted", reason: "x" }, { key, decision: "maybe", reason: "x" }, { number: 1, decision: "granted", reason: "x" }])
    assert.equal((await post(body)).status, 400);
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
});

test("SEC-03 the console decides the request on screen, not whatever moved into its place", async (t) => {
  // Before: /api/decide took a row number counted against the queue as it
  // stood at the moment of the POST. If another channel settled the first one,
  // "grant #2" granted the third, with the reason written for another; resending
  // granted the next one.
  const { post, box, q } = await startConsole(t);
  record(q, { role: "frontend", action: "write", target: "lib/a.ts", owners: [] });
  record(q, { role: "frontend", action: "write", target: "src/api/orders/b.ts", owners: ["backend"] });
  const [a, b, c] = pending(q);
  settle(q, a.key, "denied", "otro canal");             // the queue moved
  assert.equal((await post({ key: b.key, decision: "granted", reason: "approving lib" })).status, 200);
  const toml = readFileSync(join(box, "seisin.toml"), "utf8");
  assert.match(toml, /"lib\/\*\*"/);
  assert.ok(!toml.includes("src/api/orders"), "approved the request that moved into its place");
  // resending does not grant the next one
  assert.equal((await post({ key: b.key, decision: "granted", reason: "again" })).status, 400);
  assert.deepEqual(pending(q).map((r) => r.key), [c.key]);
});

test("the page never carries the token, and every /api/ route asks for it", async (t) => {
  // Review of 2026-09-22: with local_binding a role read the token from `GET /`
  // and granted its own requests; /api/state handed it the policy without a token.
  const { port, token } = await startConsole(t);
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.ok(!page.includes(token), "the token is in the page again");
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 403);
  const ok = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-seisin-token": token } });
  assert.equal(ok.status, 200);
});

test("the console answers an error, not ok, for a decision the queue could not take", { skip: process.getuid?.() === 0 }, async (t) => {
  const { box, port, token } = await startConsole(t);
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "backend", action: "write", target: "src/web/b.ts", owners: ["frontend"] });
  const [{ key }] = pending(q);
  const before = readFileSync(join(box, "seisin.toml"), "utf8");
  chmodSync(q, 0o444);
  t.after(() => chmodSync(q, 0o644));
  const post = (route, body) => fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: "POST", headers: { "content-type": "application/json", "x-seisin-token": token }, body: JSON.stringify(body),
  });
  for (const r of [
    await post("decide", { key, decision: "granted", reason: "why" }),
    await post("decide", { key, decision: "declined", reason: "why" }),
    await post("decline-all", { keys: [key], reason: "why" }),
  ]) {
    assert.equal(r.status, 500);
    assert.equal((await r.json()).ok, undefined);
  }
  assert.equal(readFileSync(join(box, "seisin.toml"), "utf8"), before);
});

test("decline all that stops partway says how many it had already closed", async (t) => {
  const { box, port, token } = await startConsole(t);
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "backend", action: "write", target: "src/web/b.ts", owners: ["frontend"] });
  const keys = pending(q).map((p) => p.key);
  assert.equal(keys.length, 2);
  const real = fs.appendFileSync;
  let lines = 0;
  fs.appendFileSync = (file, ...rest) => {
    if (file === q && ++lines === 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC", syscall: "write" });
    return real(file, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.appendFileSync = real; syncBuiltinESMExports(); });
  const r = await fetch(`http://127.0.0.1:${port}/api/decline-all`, {
    method: "POST", headers: { "content-type": "application/json", "x-seisin-token": token },
    body: JSON.stringify({ keys, reason: "why" }),
  });
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /1 already declined/);
  assert.equal(pending(q).length, 1);
});

test("the console says when what was declined stays in the policy", async (t) => {
  const { box, port, token } = await startConsole(t);
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "frontend", action: "write", target: "src/web/owned.ts", owners: ["frontend"] });
  record(q, { role: "frontend", action: "write", target: "src/web/deep/also.ts", owners: ["frontend"] });
  const [first, second] = pending(q).filter((p) => p.grant.startsWith("src/web"));
  const post = (route, body) => fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: "POST", headers: { "content-type": "application/json", "x-seisin-token": token }, body: JSON.stringify(body),
  });
  assert.ok((await (await post("decide", { key: first.key, decision: "declined", reason: "why" })).json()).stillAllowed);
  assert.equal((await (await post("decline-all", { keys: [second.key], reason: "why" })).json()).stillAllowed, 1);
});

test("decline all refuses exactly what the page showed, grants nothing, and asks for the token", async (t) => {
  const { box, port, token } = await startConsole(t);
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "backend", action: "write", target: "src/web/b.ts", owners: ["frontend"] });
  const shown = pending(q).map((p) => p.key);
  // A new one arrives after the page rendered: it is not declined unseen.
  record(q, { role: "frontend", action: "write", target: "docs/late.md", owners: [] });
  const url = `http://127.0.0.1:${port}/api/decline-all`;
  const body = JSON.stringify({ keys: shown, reason: "ruido de un bug ya arreglado" });
  assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 403);
  const before = readFileSync(join(box, "seisin.toml"), "utf8");
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-seisin-token": token }, body });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).declined, 2);
  const left = pending(q);
  assert.equal(left.length, 1);
  assert.match(left[0].target, /late\.md/);
  assert.equal(readFileSync(join(box, "seisin.toml"), "utf8"), before, "declining changed the policy");
});

test("decline all takes a queue of hundreds in one request", async (t) => {
  // With 109 keys (9.3 KB) the flat 4 KB cap cut the connection.
  const { box, port, token } = await startConsole(t);
  const q = join(box, ".seisin", "requests.jsonl");
  for (let i = 0; i < 500; i++) record(q, { role: "frontend", action: "write", target: `src/api/d${i}/f.ts`, owners: ["backend"] });
  const keys = pending(q).map((p) => p.key);
  assert.ok(JSON.stringify({ keys }).length > 3 * 4096, "not over the old 4 KB cap");
  const r = await fetch(`http://127.0.0.1:${port}/api/decline-all`, {
    method: "POST", headers: { "content-type": "application/json", "x-seisin-token": token },
    body: JSON.stringify({ keys, reason: "cola grande" }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).declined, keys.length);
  assert.equal(pending(q).length, 0);
});

test("the console only answers to its own host name", async (t) => {
  // DNS rebinding: a foreign domain pointed at 127.0.0.1 arrives with another Host.
  const { port, token } = await startConsole(t);
  const { request } = await import("node:http");
  const status = await new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path: "/api/state",
      headers: { host: `evil.example:${port}`, "x-seisin-token": token } }, (res) => ok(res.statusCode));
    r.on("error", fail); r.end();
  });
  assert.equal(status, 403);
});

test("the console's state carries the queue the page renders", async (t) => {
  const { port, token } = await startConsole(t);
  const s = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-seisin-token": token } })).json();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].grant, "src/api/checkout/**");
  assert.deepEqual(s.requests[0].owners, ["backend"]);
});

const TOML = '[roles.a]\nwrites = ["a/**"]\nkeys = []\n';

function repo(prefix, toml = TOML) {
  const box = scratch(prefix);
  writeFileSync(join(box, "seisin.toml"), toml);
  return box;
}

/* ── "already has it" closes the request on every channel ─────────────── */

async function consoleOn(t, box) {
  const { serve } = await import("../src/serve.js");
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { "x-seisin-token": server.seisinToken };
  return {
    get: (path, headers = {}) => fetch(base + path, { headers: { ...auth, ...headers } }),
    post: (path, body) => fetch(base + path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body }),
  };
}

/* ── the console's memory expires with what it depends on ─────────────── */

test("the console re-reads the disk around the policy after a minute, not never", async (t) => {
  const { realpathSync } = await import("node:fs");
  const box = repo("seisin-x-memo-",
    '[roles.a]\nwrites = ["a/**"]\nkeys = ["TOK=file://cred/t.txt"]\n');
  const { get } = await consoleOn(t, box);
  const settings = async () => JSON.stringify((await (await get("/api/settings?role=a")).json()).settings);

  const first = await get("/api/state");
  const tag = first.headers.get("etag");
  await first.text();
  await settings();
  // Nothing moved: the same tag, a 304.
  assert.equal((await get("/api/state", { "if-none-match": tag })).status, 304);

  // The key file becomes a link to somewhere else. Its destination is what the
  // kernel meets, so it must be denied too — but nothing the key hashes moved.
  const elsewhere = join(box, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "t.txt"), "x");
  mkdirSync(join(box, "cred"));
  symlinkSync(join(elsewhere, "t.txt"), join(box, "cred", "t.txt"));
  const dest = realpathSync(join(elsewhere, "t.txt"));
  assert.ok(!(await settings()).includes(dest), "precondition: still the first reading");

  const real = Date.now;
  Date.now = () => real() + 61_000;
  try {
    assert.ok((await settings()).includes(dest), "a disk change was never seen");
    assert.equal((await get("/api/state", { "if-none-match": tag })).status, 200, "the old tag was still served");
  } finally { Date.now = real; }
});

/* ── the console's server ──────────────────────────────────────────────── */

async function console_(t) {
  const { serve } = await import("../src/serve.js");
  const box = scratch("seisin-audit-ui-");
  writeFileSync(join(box, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n[network]\nallow = ["example.org"]\n\n[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\nkeys   = []\n');
  const q = requestsPath(box);
  record(q, { role: "frontend", action: "write", target: "src/api/checkout/a.ts", owners: ["backend"] });
  const server = await serve(join(box, "seisin.toml"), 0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { "x-seisin-token": server.seisinToken };
  const get = (path, headers = {}) => fetch(base + path, { headers: { ...auth, ...headers } });
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body });
  return { box, q, base, auth, get, post, key: pending(q)[0].key };
}

test("the poll carries no settings; one role's are served on demand, with the token", async (t) => {
  const { get, base } = await console_(t);
  const s = await (await get("/api/state")).json();
  assert.ok(s.roles.every((r) => !("settings" in r)), "settings are back in the poll");
  const { settingsFor } = await import("../src/srt-settings.js");
  const one = await get("/api/settings?role=frontend");
  assert.equal(one.status, 200);
  const body = await one.json();
  assert.equal(body.role, "frontend");
  assert.deepEqual(body.settings, settingsFor(loadConfig(s.config), "frontend"));
  assert.ok(JSON.stringify(body.settings).includes("example.org"), "the policy's domains, not a hand-built github.com");
  assert.equal((await get("/api/settings?role=nobody")).status, 404);
  assert.equal((await get("/api/settings?role=__proto__")).status, 404);
  assert.equal((await fetch(base + "/api/settings?role=frontend")).status, 403);
});

test("an unchanged state answers 304 to its own tag, and a change is a new tag", async (t) => {
  const { get, q } = await console_(t);
  const first = await get("/api/state");
  const tag = first.headers.get("etag");
  assert.ok(tag);
  assert.equal((await get("/api/state", { "if-none-match": tag })).status, 304);
  record(q, { role: "backend", action: "write", target: "src/web/x.ts", owners: ["frontend"] });
  const next = await get("/api/state", { "if-none-match": tag });
  assert.equal(next.status, 200);
  assert.equal((await next.json()).requests.length, 2);
});

test("HEAD on the API is refused, not computed", async (t) => {
  const { base, auth } = await console_(t);
  const r = await fetch(base + "/api/state", { method: "HEAD", headers: auth });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "GET");
});

test("a body over the cap gets a 413 before the connection closes", async (t) => {
  const { post } = await console_(t);
  const r = await post("/api/decide", JSON.stringify({ key: "x", decision: "denied", reason: "y".repeat(8000) }));
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /too large/);
});

test("a decision the policy file cannot take is a 500; a bad one is a 400", async (t) => {
  const { chmodSync } = await import("node:fs");
  const { post, box, key, q } = await console_(t);
  assert.equal((await post("/api/decide", "{not json")).status, 400);
  assert.equal((await post("/api/decide", JSON.stringify({ key, decision: "maybe" }))).status, 400);
  // The directory the policy lives in cannot be written: no lock, no temp file.
  chmodSync(box, 0o555);
  try {
    const r = await post("/api/decide", JSON.stringify({ key, decision: "granted", reason: "r" }));
    assert.equal(r.status, 500, await r.text());
  } finally { chmodSync(box, 0o755); }
  assert.equal(pending(q).length, 1, "the request is still open: nothing was written");
});

test("a decision is looked up, applied and settled under the policy lock", async (t) => {
  const { spawn } = await import("node:child_process");
  const { post, box, key, q } = await console_(t);
  const policy = join(box, "seisin.toml");
  // Another process — a `seisin grant` or `decline` in a terminal — holds the
  // policy lock and declines the request while holding it. The console must
  // look the request up after that, not before. The lock is `.seisin/policy.lock`
  // (requests.js, policyLockBase), where no role can plant one.
  const log = new URL("../src/log.js", import.meta.url).href;
  const reqs = new URL("../src/requests.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { withLock } from ${JSON.stringify(log)}; import { settle } from ${JSON.stringify(reqs)};
     withLock(${JSON.stringify(join(box, ".seisin", "policy"))}, () => {
       process.stdout.write("locked\\n");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
       settle(${JSON.stringify(q)}, ${JSON.stringify(key)}, "denied", "the other channel");
     });`]);
  // Listened for before anything is awaited: the holder exits as soon as it
  // lets go of the lock, often before the console answers, and a listener
  // added after that waits forever — the suite once hung here for hours.
  const closed = new Promise((ok) => child.once("close", ok));
  await Promise.race([
    new Promise((ok) => child.stdout.once("data", ok)),
    closed.then(() => { throw new Error("the lock holder exited without taking the lock"); }),
  ]);
  const r = await post("/api/decide", JSON.stringify({ key, decision: "granted", reason: "r" }));
  await closed;
  assert.equal(r.status, 400, "the request had been settled by the lock holder");
  assert.ok(!readFileSync(policy, "utf8").includes("checkout"), "granted what the other channel declined");
});
