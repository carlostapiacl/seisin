/**
 * `local_ports`: a role may connect to the local ports it names, and to no
 * others. The narrow form of `local_binding`, which opens every port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { settingsFor, loopbackVia, localPortDomains, NO_PROXY_WITHOUT_LOOPBACK } from "../src/srt.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { resolveSrt } from "../src/commands/run.js";

const require_ = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const BOX = join(HERE, ".sandbox-box");

function repoWith(toml) {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "ports-"));
  writeFileSync(join(dir, "seisin.toml"), toml);
  mkdirSync(join(dir, "app"), { recursive: true });
  return dir;
}
const load = (toml) => loadConfig(join(repoWith(toml), "seisin.toml"));

const TWO =
  '[network]\nallow = ["example.com"]\n\n' +
  '[roles.e2e]\nwrites = ["app/**"]\nlocal_ports = [8001, "8081", 8001]\n\n' +
  '[roles.docs]\nwrites = ["docs/**"]\n';

test("absent means no local port, and the domain list is untouched", () => {
  const cfg = load(TWO);
  assert.deepEqual(cfg.roles.docs.localPorts, []);
  assert.deepEqual(settingsFor(cfg, "docs").network.allowedDomains, ["example.com"]);
});

test("each port becomes three allowlist entries, next to the domains", () => {
  const cfg = load(TWO);
  assert.deepEqual(cfg.roles.e2e.localPorts, [8001, 8081], "a quoted port is a port; a repeat is one");
  assert.deepEqual(settingsFor(cfg, "e2e").network.allowedDomains,
    ["example.com", ...localPortDomains([8001, 8081])]);
  assert.deepEqual(localPortDomains([3307]), ["localhost:3307", "127.0.0.1:3307", "[::1]:3307"]);
  // Not the kernel's answer, which has only "none" or "every port".
  assert.equal(settingsFor(cfg, "e2e").network.allowLocalBinding, false);
});

test("anything that is not a port refuses to load", () => {
  for (const bad of ["0", "70000", '"80a"', "true", '["8001x"]'])
    assert.throws(() => load(`[roles.e2e]\nwrites = ["app/**"]\nlocal_ports = ${bad.startsWith("[") ? bad : `[${bad}]`}\n`),
      /not a port|not a whole number|array items/, bad);
});

test("numbers are allowed only where a number means something", () => {
  assert.throws(() => load('[roles.e2e]\nwrites = ["app/**", 8001]\n'), /array of strings/);
});

test("loopback goes through the proxy only for a role that names ports", () => {
  const cfg = load(TWO);
  assert.deepEqual(loopbackVia(cfg.roles.docs, ["claude", "-p"]), ["claude", "-p"]);
  assert.deepEqual(loopbackVia(cfg.roles.e2e, ["claude", "-p"]),
    ["env", `NO_PROXY=${NO_PROXY_WITHOUT_LOOPBACK}`, `no_proxy=${NO_PROXY_WITHOUT_LOOPBACK}`, "claude", "-p"]);
});

test("NO_PROXY stays in step with the pinned runtime, minus loopback", () => {
  // If the runtime adds a range, seisin taking loopback out must not also take
  // that range back into the proxy by accident — or leave it out.
  const src = readFileSync(join(dirname(require_.resolve("@anthropic-ai/sandbox-runtime/package.json")),
    "dist", "sandbox", "sandbox-utils.js"), "utf8");
  const block = /const noProxyAddresses = \[([\s\S]*?)\]\.join/.exec(src);
  assert.ok(block, "the runtime no longer builds NO_PROXY the way this test reads it");
  const theirs = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const loopback = ["localhost", "127.0.0.1", "::1"];
  assert.deepEqual(theirs.filter((x) => !loopback.includes(x)), NO_PROXY_WITHOUT_LOOPBACK.split(","));
});

test("check shows the ports, and says so when local_binding makes them moot", () => {
  const report = inspect(load(TWO));
  assert.ok(!report.warnings.some((w) => w.kind === "unknown-role-key"));
  assert.match(renderReport(report), /reach.*localhost 8001 8081/);
  const both = inspect(load('[roles.e2e]\nwrites = ["app/**"]\nlocal_ports = [8001]\nlocal_binding = true\n'));
  assert.equal(both.warnings.some((w) => w.kind === "local-ports-moot"), process.platform === "darwin");
});

const skip = resolveSrt() !== null ? false : "sandbox runtime not installed";

test("against the kernel: the named port answers, the next one does not", { skip }, async (t) => {
  const servers = await Promise.all([0, 1].map(() => new Promise((ok) => {
    const s = createServer((q, r) => r.end("open")).listen(0, "127.0.0.1", () => ok(s));
  })));
  t.after(() => servers.forEach((s) => s.close()));
  const [allowed, other] = servers.map((s) => s.address().port);
  const dir = repoWith(`[roles.e2e]\nwrites = ["app/**"]\nlocal_ports = [${allowed}]\n\n[roles.docs]\nwrites = ["docs/**"]\n`);
  const probe = (port) => `fetch("http://127.0.0.1:${port}/").then(r=>r.text()).then(t=>console.log("${port}",t),e=>console.log("${port}","refused"))`;
  const as = (role) => new Promise((ok) => {
    let out = "";
    const p = spawn(process.execPath, [CLI, "run", role, "--", process.execPath, "-e", `${probe(allowed)};${probe(other)}`], { cwd: dir });
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => ok(out));
  });
  const e2e = await as("e2e");
  assert.match(e2e, new RegExp(`${allowed} open`), e2e);
  assert.match(e2e, new RegExp(`${other} refused`), `an unlisted port answered: ${e2e}`);
  const docs = await as("docs");
  assert.match(docs, new RegExp(`${allowed} refused`), `a role without the key reached it: ${docs}`);
});

/* ── refused connections, in the record ─────────────────────────────── */

import { parseChunk, actionOf } from "../src/violations.js";
import { explain } from "../src/owners.js";
import { review } from "../src/review.js";

// Captured 2026-09-23 from `log stream`, one per shape the kernel writes.
const line = (detail) =>
  "2026-09-23 04:27:07.182 E  kernel[0:2b6708] (Sandbox) Sandbox: curl(53468) deny(1) " +
  `network-outbound ${detail}\nCMD64_c2g=_END__qlvxb5sax_SBX`;

test("a refused dial is a connect to a port, named without a host the kernel did not give", () => {
  assert.equal(actionOf("network-outbound"), "connect");
  const d = parseChunk(line("remote:*:18787"));
  assert.deepEqual([d.action, d.path, d.pid], ["connect", "tcp:18787", 53468]);
  assert.equal(parseChunk(line("/Users/me/.docker/run/docker.sock")).path, "/Users/me/.docker/run/docker.sock");
});

test("DNS through mDNSResponder, and the empty lines, are not recorded", () => {
  // Every name lookup inside the box is one of these; recording them would
  // bury the refusals that mean something (the file-read-metadata lesson).
  assert.equal(parseChunk(line("/private/var/run/mDNSResponder")), null);
  assert.equal(parseChunk(line("/var/run/syslog")), null);
  assert.equal(parseChunk(line("").trimEnd()), null);
});

test("the sentence tells the three cases apart, and none has an owner", () => {
  const cfg = load('[roles.e2e]\nwrites = ["app/**"]\nlocal_ports = [8001]\n');
  const missing = explain(cfg, "e2e", "connect", "tcp:8787");
  assert.equal(missing.allowed, false);
  assert.match(missing.reason, /port 8787.*local_ports \(has 8001\)/);
  // The kernel names no host, so an outside host is the other reading, not a
  // footnote: 443 is almost always a client that skipped the proxy.
  assert.match(missing.reason, /host unknown/);
  assert.match(missing.reason, /skipped HTTP_PROXY/);
  const direct = explain(cfg, "e2e", "connect", "tcp:8001");
  assert.equal(direct.listed, true);
  assert.match(direct.reason, /skipped the proxy/);
  const docker = explain(cfg, "e2e", "connect", "/Users/me/.docker/run/docker.sock");
  assert.match(docker.reason, /mount any directory/);
  for (const v of [missing, direct, docker]) assert.deepEqual(v.owners, []);
});

test("review keeps connections out of the territory advice and out of the map's holes", () => {
  const dir = repoWith('[roles.e2e]\nwrites = ["app/**"]\n');
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  const e = { role: "e2e", action: "connect", kind: "network", target: "tcp:8787", verdict: "denied", owners: [], source: "kernel" };
  writeFileSync(join(dir, ".seisin", "log.jsonl"),
    [1, 2, 3].map((i) => JSON.stringify({ ...e, at: `2026-09-23T00:00:0${i}Z` })).join("\n") + "\n");
  const r = review(loadConfig(join(dir, "seisin.toml")));
  assert.equal(r.friction.length, 0, "a port landed under 'grant, or move the territory'");
  assert.deepEqual(r.connects.map((c) => [c.where, c.times]), [["tcp:8787", 3]]);
  assert.equal(r.unowned.length, 0, "a port was reported as a hole in the map");
});

test("a short refusal by a role with local_ports reaches the log", { skip: skip || (process.platform !== "darwin" && "kernel denials are read on macOS only") }, async () => {
  // The command that runs is `env NO_PROXY=… <cmd>`, and the watcher recognises
  // a denial by that command. It was handed <cmd> instead, recognised nothing,
  // and every short refusal of these roles — the kind an agent runs most — left
  // no line: 0 of 5 measured, against 5 of 5 for a role without the key.
  const dir = repoWith('[roles.e2e]\nwrites = ["app/**"]\nlocal_ports = [8001]\n');
  await new Promise((ok) => spawn(process.execPath, [CLI, "run", "e2e", "--", "sh", "-c", "nc -z 127.0.0.1 38787"], { cwd: dir, stdio: "ignore" }).on("close", ok));
  const log = readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8");
  assert.match(log, /"action":"connect".*"target":"tcp:38787"/, log);
});
