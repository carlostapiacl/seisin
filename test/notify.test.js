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

import { loadConfig } from "../src/config.js";
import { notifier, message } from "../src/notify.js";
import { record, requestsPath } from "../src/requests.js";
import { buildEnv } from "../src/env.js";
import { resolveSrt } from "../src/commands/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const BOX = join(HERE, ".sandbox-box");

const BASE = '[keys]\ndir = ".secrets"\n\n[roles.web]\nwrites = ["src/web/**"]\n\n[roles.api]\nwrites = ["src/api/**"]\n';

function repo(extra = '[notify]\nurl_file = ".secrets/notify-url.txt"\n', url = "http://127.0.0.1:9/") {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "notify-"));
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
  mkdirSync(BOX, { recursive: true });
  const held = mkdtempSync(join(BOX, "notify-"));
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
  assert.match(sent[0].body, /web was refused write on src\/api\/x\.ts\. It belongs to api\. Approve: seisin grant 1/);
});

test("formats: slack and json carry the same sentence", () => {
  const cfg = loadConfig(join(repo(), "seisin.toml"));
  const req = { role: "web", action: "write", target: "src/api/x.ts", owners: ["api"] };
  assert.match(JSON.parse(message(cfg, req, 2, "slack").body).text, /seisin grant 2/);
  const j = JSON.parse(message(cfg, req, 2, "json").body);
  assert.deepEqual([j.number, j.role, j.grant, j.owners], [2, "web", "src/api/**", ["api"]]);
});

test("the notify URL never reaches the role, even when it names it", () => {
  const { env, dropped } = buildEnv({ SEISIN_NOTIFY_URL: "https://ntfy.sh/x" }, { env: ["SEISIN_NOTIFY_URL"] });
  assert.equal(env.SEISIN_NOTIFY_URL, undefined);
  assert.ok(dropped.includes("SEISIN_NOTIFY_URL"));
});

const skip = resolveSrt() !== null ? false : "sandbox runtime not installed";

test("a role can neither read nor rewrite the URL file", { skip }, () => {
  const dir = repo();
  const as = (line) => spawnSync(process.execPath, [CLI, "run", "web", "--", "sh", "-c", line], { cwd: dir, encoding: "utf8" });
  const read = as("cat .secrets/notify-url.txt");
  assert.notEqual(read.status, 0, "the role read the URL");
  assert.doesNotMatch(read.stdout, /127\.0\.0\.1/);
  assert.notEqual(as("echo http://evil.example/ > .secrets/notify-url.txt").status, 0, "the role rewrote the URL");
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
  assert.match(got[0], /web was refused write on src\/api\/real\.ts\. It belongs to api/);
});
