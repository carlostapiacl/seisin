import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, chmodSync, statSync, lstatSync, symlinkSync, readdirSync, cpSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scratch, CLI } from "./_tmp.js";
import { redactor } from "../src/redact.js";
import { loadConfig } from "../src/config.js";
import { writeUiLink, readUiLink } from "../src/uilink.js";
import { runsRoot } from "../src/rundir.js";
import { notifier } from "../src/notify.js";
import { record, requestsPath } from "../src/requests.js";

async function masked(secrets, chunks) {
  const stream = redactor(secrets);
  let text = "";
  stream.on("data", (c) => { text += c; });
  const done = once(stream, "end");
  for (const c of chunks) stream.write(c);
  stream.end();
  await done;
  return text;
}

test("overlapping credentials are masked identically at every byte split", async () => {
  for (const prefix of ["shared-prefix", "préfixe-étroit"]) {
    const secret = prefix + "-credential-0123456789";
    const bytes = Buffer.from(`before ${secret} after ${prefix} end`);
    for (let i = 0; i <= bytes.length; i++) {
      assert.equal(await masked([prefix, secret], [bytes.subarray(0, i), bytes.subarray(i)]),
        "before ‹redacted› after ‹redacted› end", `split ${i} of ${prefix}`);
    }
  }
});

test("redaction markers are output, never input to another credential replacement", async () => {
  const secret = "prefix-complete-synthetic-secret";
  const secrets = [secret, "redacted"];
  assert.equal(await masked(secrets, [secret + " redacted"]), "‹redacted› ‹redacted›");
  assert.equal(await masked(secrets, [secret, " finish"]), "‹redacted› finish");
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

const LIVE_URL = "http://127.0.0.1:4178/#t=synthetic-token";

test("replacing an existing console record makes the new file private", () => {
  const base = scratch("seisin-link-audit-");
  const dir = runsRoot(base);
  const file = join(dir, "ui-4178.url");
  writeFileSync(file, "old\n");
  chmodSync(file, 0o644);
  writeUiLink(4178, LIVE_URL, base);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readUiLink(4178, base).url, LIVE_URL);
  assert.deepEqual(readdirSync(dir), ["ui-4178.url"]);
});

test("writing a console record replaces a planted symlink without touching its target", () => {
  const base = scratch("seisin-link-alias-");
  const dir = runsRoot(base);
  const outside = join(base, "keep.txt");
  writeFileSync(outside, "keep this content\n");
  const file = join(dir, "ui-4178.url");
  symlinkSync(outside, file);
  writeUiLink(4178, LIVE_URL, base);
  assert.equal(readFileSync(outside, "utf8"), "keep this content\n");
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("a console writer that cannot be signalled is not reported as gone", () => {
  const base = scratch("seisin-link-live-");
  writeUiLink(4178, LIVE_URL, base);
  const kill = process.kill;
  process.kill = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
  try { assert.equal(readUiLink(4178, base).alive, true); }
  finally { process.kill = kill; }
});

test("run help honours the agent option's value and the child command's own flags", () => {
  const root = scratch("seisin-help-agent-");
  writeFileSync(join(root, "seisin.toml"), '[roles.dev]\nwrites = []\n');
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: "utf8", timeout: 2000 });
  for (const args of [["run", "dev", "--agent", "codex", "--help"], ["run", "dev", "--agent", "codex", "-h", "--", "true"]]) {
    const r = cli(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage:/);
  }
  const value = cli("run", "dev", "--agent", "--help", "--", "true");
  assert.equal(value.status, 2);
  assert.doesNotMatch(value.stdout, /usage:/);
  const child = cli("run", "missing", "--agent", "codex", "echo", "--help");
  assert.equal(child.status, 2);
  assert.match(child.stderr, /unknown role/);
});

test("the launcher drains redacted pipes after the runtime exits", () => {
  // A fake runtime isolates process/stdio ordering. This is not a test of
  // confinement; the real runtime's output/status tests remain in run-exit.
  const root = scratch("seisin-output-audit-");
  cpSync(fileURLToPath(new URL("../src", import.meta.url)), join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module","version":"0.0.0"}\n');
  writeFileSync(join(root, "seisin.toml"), '[roles.dev]\nwrites = []\nkeys = ["TOKEN=file://token.txt"]\nkey_mode = "env"\n');
  const secret = "synthetic-output-credential";
  writeFileSync(join(root, "token.txt"), secret + "\n");
  const runtime = join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "package.json"), '{"bin":{"srt":"cli.cjs"}}\n');
  const late = "setTimeout(() => { process.stdout.write('tail=' + process.env.TOKEN + '\\n'); process.stderr.write('last stderr\\n'); }, 120)";
  const script = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const late = ${JSON.stringify(late)};
spawn(process.execPath, ['-e', late], { stdio: ['ignore', 1, 2] }).unref();
process.stdout.write('begin\\n');
setTimeout(() => process.exit(3), 20);
`;
  writeFileSync(join(runtime, "cli.cjs"), script, { mode: 0o755 });
  const r = spawnSync(process.execPath, [join(root, "src", "cli.js"), "run", "dev", "--", process.execPath, "-e", ""],
    { cwd: root, encoding: "utf8", timeout: 4000 });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /tail=‹redacted›\n/);
  assert.match(r.stderr, /last stderr\n/);
  assert.doesNotMatch(r.stdout, new RegExp(secret));
});

test("the CI sandbox gate rejects real skipped results in both Node reporter formats", () => {
  // Test the workflow's actual shell block using native Node output. These
  // fixtures exercise the gate, not the confinement boundary itself.
  const root = scratch("seisin-ci-gate-");
  const fixture = join(root, "fixture.test.js");
  const log = join(root, "sandbox.log");
  const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  const block = workflow.match(/- name: the sandbox half actually ran\n        run: \|\n([\s\S]*)$/)[1]
    .replace(/^          /gm, "");
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This subprocess is its own test runner.
  for (const reporter of ["tap", "spec"]) {
    for (const skip of [false, true]) {
      writeFileSync(fixture, `const {test} = require('node:test');\ntest('fixture', {skip: ${skip}}, () => {});\n`);
      const script = block
        .replace("node --test test/sandbox.test.js 2>&1",
          `${quote(process.execPath)} --test --test-reporter=${reporter} ${quote(fixture)} 2>&1`)
        .replaceAll("/tmp/sandbox.log", quote(log));
      const r = spawnSync("sh", ["-c", script], { env, encoding: "utf8", timeout: 3000 });
      assert.equal(r.status, skip ? 1 : 0, `${reporter}, skip=${skip}: ${r.stdout}\n${r.stderr}`);
      if (skip) assert.match(r.stdout, /sandbox tests skipped/);
    }
  }
});
