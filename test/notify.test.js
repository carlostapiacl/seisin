/**
 * Telling a person a request was filed (src/notify.js), without handing the
 * way to do it to the role that filed it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { boxed, CLI, sandboxSkip } from "./_tmp.js";

import { loadConfig } from "../src/config.js";
import { notifier, message } from "../src/notify.js";
import { record, requestsPath } from "../src/requests.js";
import { buildEnv } from "../src/env.js";
import { symlinkSync } from "node:fs";
import { scratch } from "./_tmp.js";


const BASE = '[keys]\ndir = ".secrets"\n\n[roles.web]\nwrites = ["src/web/**"]\n\n[roles.api]\nwrites = ["src/api/**"]\n';

function repo(extra = '[notify]\nurl_file = ".secrets/notify-url.txt"\n', url = "http://127.0.0.1:9/") {
  const dir = boxed("notify-");
  writeFileSync(join(dir, "seisin.toml"), BASE + "\n" + extra);
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  mkdirSync(join(dir, "src", "api"), { recursive: true });
  mkdirSync(join(dir, "src", "web"), { recursive: true });
  writeFileSync(join(dir, ".secrets", "notify-url.txt"), url + "\n");
  return dir;
}

test("a URL written into seisin.toml refuses to load: every role can read that file", () => {
  const dir = repo('[notify]\nurl = "https://ntfy.sh/secret-topic"\n');
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /url is readable by every role/);
});

test("url_file outside a key directory, or held by a role, refuses to load", () => {
  const out = repo('[notify]\nurl_file = "notify-url.txt"\n');
  assert.throws(() => loadConfig(join(out, "seisin.toml")), /not inside a key directory/);
  const held = boxed("notify-");
  writeFileSync(join(held, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n[roles.web]\nwrites = ["src/web/**"]\nkeys = ["notify-url.txt"]\n\n[notify]\nurl_file = ".secrets/notify-url.txt"\n');
  assert.throws(() => loadConfig(join(held, "seisin.toml")), /declared as a key by web/);
});

test("one message per new request, naming the owner and the command that answers it", async () => {
  const dir = repo();
  const cfg = loadConfig(join(dir, "seisin.toml"));
  const sent = [];
  const n = notifier(cfg, { env: {}, fetchImpl: async (url, init) => { sent.push({ url, ...init }); return { ok: true }; } });
  const req = { role: "web", action: "write", target: "src/api/x.ts", owners: ["api"] };
  record(requestsPath(dir), req);
  assert.equal(n.maybe(req), true);
  record(requestsPath(dir), req);
  assert.equal(n.maybe(req), false, "a repeat pinged again");
  await n.settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://127.0.0.1:9/");
  assert.equal(sent[0].redirect, "error");
  assert.match(sent[0].body, /web was denied write on src\/api\/x\.ts\. It belongs to api\. Handed to api\. Grant: seisin grant 'web:write:src\/api'/);
});

test("formats: slack and json carry the same sentence", () => {
  const cfg = loadConfig(join(repo(), "seisin.toml"));
  const req = { role: "web", action: "write", target: "src/api/x.ts", owners: ["api"] };
  // By id, not by position: the queue moves between the message and the reply.
  assert.match(JSON.parse(message(cfg, req, 2, "slack").body).text, /seisin grant 'web:write:src\/api'/);
  const j = JSON.parse(message(cfg, req, 2, "json").body);
  assert.deepEqual([j.number, j.id, j.role, j.grant, j.owners], [2, "web:write:src/api", "web", "src/api/**", ["api"]]);
});

test("the notify URL never reaches the role, even when it names it", () => {
  const { env, dropped } = buildEnv({ SEISIN_NOTIFY_URL: "https://ntfy.sh/x" }, { env: ["SEISIN_NOTIFY_URL"] });
  assert.equal(env.SEISIN_NOTIFY_URL, undefined);
  assert.ok(dropped.includes("SEISIN_NOTIFY_URL"));
});

const skip = sandboxSkip();

test("a role can neither read nor rewrite the URL file", { skip }, () => {
  const dir = repo();
  const as = (line) => spawnSync(process.execPath, [CLI, "run", "web", "--", "sh", "-c", line], { cwd: dir, encoding: "utf8" });
  const read = as("cat .secrets/notify-url.txt");
  assert.notEqual(read.status, 0, "the role read the URL");
  assert.doesNotMatch(read.stdout, /127\.0\.0\.1/);
  const write = as("echo http://evil.example/ > .secrets/notify-url.txt");
  // The file on disk is what the parent reads, so that is the assertion. On
  // Linux the runtime denies reading a directory by mounting an empty tmpfs
  // over it, and the write lands in that throwaway copy: exit 0 inside the
  // box, the real file untouched (checked in Docker, 2026-09-23). On macOS the
  // kernel refuses the write itself.
  if (process.platform === "darwin") assert.notEqual(write.status, 0, "the role rewrote the URL");
  assert.match(readFileSync(join(dir, ".secrets", "notify-url.txt"), "utf8"), /127\.0\.0\.1:9/);
});

test("a real refusal sends one message, from the parent, saying whose it is", { skip: (skip || process.platform !== "darwin") && "macOS: the kernel's refusal is what files the request there" }, async (t) => {
  const got = [];
  const server = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push(b); res.end("ok"); }); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const dir = repo(undefined, `http://127.0.0.1:${server.address().port}/`);
  const code = await new Promise((ok) => {
    const p = spawn(process.execPath, [CLI, "run", "web", "--", "sh", "-c", "echo x > src/api/real.ts"], { cwd: dir });
    p.on("close", ok);
  });
  assert.notEqual(code, 0, "the kernel let it through");
  assert.equal(got.length, 1, `expected one message, got ${got.length}`);
  assert.match(got[0], /web was denied write on src\/api\/real\.ts\. It belongs to api/);
});

function notificationPolicy(root, keys, urlFile = ".secrets/endpoint.txt", keyDir = ".secrets") {
  return loadConfig(join(root, "seisin.toml"),
    `[keys]\ndir = ${JSON.stringify(keyDir)}\n[roles.dev]\nwrites = []\nkeys = ${JSON.stringify(keys)}\n` +
    `[notify]\nurl_file = ${JSON.stringify(urlFile)}\n`);
}

function notificationRoot() {
  const root = scratch("seisin-notify-audit-");
  mkdirSync(join(root, ".secrets"));
  writeFileSync(join(root, ".secrets", "endpoint.txt"), "https://notify.example.test/synthetic-topic\n");
  return root;
}

test("notification validation recognises path aliases on either side of a file declaration", () => {
  const root = notificationRoot();
  for (const key of [".secrets/./endpoint.txt", ".secrets//endpoint.txt", ".secrets/sub/../endpoint.txt"])
    assert.throws(() => notificationPolicy(root, [key]), /declared as a key by dev/);
  assert.throws(() => notificationPolicy(root, ["endpoint.txt"], ".secrets/./endpoint.txt"), /declared as a key by dev/);
});

test("notification files cannot be delivered to a role through a builtin file reference", () => {
  const root = notificationRoot();
  for (const key of ["N=file://.secrets/endpoint.txt", "file://.secrets/./endpoint.txt", "N=file://.secrets/endpoint.txt#TOPIC"])
    assert.throws(() => notificationPolicy(root, [key]), /declared as a key by dev/);
  assert.equal(notificationPolicy(root, ["N=file://.secrets/other.txt"]).notify.urlFile, ".secrets/endpoint.txt");
});

test("a directory read declaration cannot include the notification file", () => {
  const root = notificationRoot();
  for (const key of [".", ".secrets/", ".secrets/."])
    assert.throws(() => notificationPolicy(root, [key]), /declared as a key by dev/);
  assert.equal(notificationPolicy(root, [".secrets"]).notify.urlFile, ".secrets/endpoint.txt");
});

test("notification files must resolve inside a protected directory", () => {
  const root = notificationRoot();
  writeFileSync(join(root, "readable.txt"), "https://notify.example.test/synthetic-topic\n");
  symlinkSync(join(root, "readable.txt"), join(root, ".secrets", "outside.txt"));
  assert.throws(() => notificationPolicy(root, [], ".secrets/outside.txt"), /not inside a key directory/);
  symlinkSync(join(root, ".secrets", "endpoint.txt"), join(root, ".secrets", "alias.txt"));
  assert.throws(() => notificationPolicy(root, ["alias.txt"]), /declared as a key by dev/);
});

test("an absolute protected directory inside the repo can hold a private notification file", () => {
  const root = notificationRoot();
  const cfg = notificationPolicy(root, [], ".secrets/endpoint.txt", join(root, ".secrets"));
  assert.equal(cfg.notify.urlFile, ".secrets/endpoint.txt");
});

test("a failed notification does not return a credential-bearing URL in its diagnostic", async () => {
  const root = notificationRoot();
  const cfg = notificationPolicy(root, []);
  const n = notifier(cfg, { env: { SEISIN_NOTIFY_URL: "https://notify.example.test:bad/synthetic-secret-topic" } });
  const request = { role: "dev", action: "write", target: "docs/a.md", owners: [] };
  record(requestsPath(root), request);
  assert.equal(n.maybe(request), true);
  const failures = await n.settle();
  assert.equal(failures.length, 1);
  assert.doesNotMatch(failures[0], /synthetic-secret-topic|notify\.example/);
});

test("a completed notification does not keep its process alive until the settlement cap", () => {
  const root = scratch("seisin-notify-drain-");
  const module = new URL("../src/notify.js", import.meta.url).href;
  const requests = new URL("../src/requests.js", import.meta.url).href;
  const script = `import {notifier} from ${JSON.stringify(module)};
import {record,requestsPath} from ${JSON.stringify(requests)};
const config = {root: ${JSON.stringify(root)}};
const req = {role:'dev',action:'write',target:'docs/a.md',owners:[]};
const n = notifier(config,{env:{SEISIN_NOTIFY_URL:'https://notify.example.test/topic'},fetchImpl:async()=>({ok:true})});
record(requestsPath(config.root),req);
if (!n.maybe(req)) throw new Error('notification was not queued');
await n.settle();process.stdout.write('done');`;
  // The old, referenced timer kept even a completed request alive for 3.5 s.
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 3000 });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "done");
});

/* ── Slack's markup is not the agent's to use ──────────────────────────── */

test("a slack message escapes & < > in what the agent chose", () => {
  const cfg = { root: "/repo" };
  const req = { role: "web", action: "write", target: "src/<https://evil.example|approve here>&<!channel>.ts", owners: ["api"] };
  const { body } = message(cfg, req, 1, "slack");
  const { text } = JSON.parse(body);
  assert.ok(!/[<>]/.test(text), text);
  assert.match(text, /&lt;https:\/\/evil\.example\|approve here&gt;&amp;&lt;!channel&gt;/);
  // The other formats are not Slack's and stay as they were.
  assert.match(message(cfg, req, 1, "text").body, /<https:\/\/evil/);
});
