/**
 * TLS inside the macOS sandbox: what seisin sets so tools verify certificates
 * without the system verifier, and the per-role `trustd = true` for the ones
 * that cannot do without it.
 *
 * Measured on 2026-09-22 (sandbox-runtime 0.0.76): Go and Dart fail TLS inside
 * the box with a plain CONNECT tunnel — no MITM — because on macOS they ask
 * com.apple.trustd.agent, which the profile closes. Go 1.27+ honors
 * SSL_CERT_FILE and skips it; Dart has no such switch; Node's fetch() ignores
 * the proxy until NODE_USE_ENV_PROXY=1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildEnv, DEFAULTS } from "../src/env.js";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX = join(HERE, ".sandbox-box");
const BUNDLE = "/etc/ssl/cert.pem";

function repoWith(toml) {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "tls-"));
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

test("node's fetch is told to use the proxy the sandbox routes through", () => {
  assert.equal(buildEnv({}, { env: [] }).env.NODE_USE_ENV_PROXY, "1");
});

test("SSL_CERT_FILE points at the system bundle, only where the bundle exists", () => {
  const { env } = buildEnv({}, { env: [] });
  if (existsSync(BUNDLE)) assert.equal(env.SSL_CERT_FILE, BUNDLE);
  else assert.equal(env.SSL_CERT_FILE, undefined, "never point TLS clients at a file that is not there");
});

test("a trust store the parent chose wins, named or not, and is not reported as dropped", () => {
  const a = buildEnv({ SSL_CERT_FILE: "/corp/ca.pem" }, { env: [] });
  assert.equal(a.env.SSL_CERT_FILE, "/corp/ca.pem");
  assert.ok(!a.dropped.includes("SSL_CERT_FILE"));
  const b = buildEnv({ SSL_CERT_DIR: "/corp/certs" }, { env: [] });
  assert.equal(b.env.SSL_CERT_DIR, "/corp/certs");
  assert.equal(b.env.SSL_CERT_FILE, undefined, "the default must not sit next to a directory the parent chose");
});

test("a role that names SSL_CERT_FILE without a parent value opts out of the default", () => {
  assert.equal(buildEnv({}, { env: ["SSL_CERT_FILE"] }).env.SSL_CERT_FILE, undefined);
});

test("the defaults list is what the tests above assume", () => {
  assert.equal(DEFAULTS.NODE_USE_ENV_PROXY, "1");
  assert.equal(DEFAULTS.GIT_OPTIONAL_LOCKS, "0");
});

const TWO = '[roles.flutter]\nwrites = ["app/**"]\ntrustd = true\n\n[roles.docs]\nwrites = ["docs/**"]\n';

test("trustd = true reaches the profile for that role only", () => {
  const cfg = loadConfig(join(repoWith(TWO), "seisin.toml"));
  assert.equal(settingsFor(cfg, "flutter").enableWeakerNetworkIsolation, true);
  assert.equal(settingsFor(cfg, "docs").enableWeakerNetworkIsolation, undefined);
});

test("trustd is a boolean, and anything else refuses to load", () => {
  const dir = repoWith('[roles.x]\nwrites = ["app/**"]\ntrustd = "yes"\n');
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /trustd must be true or false/);
});

test("check names what trustd opens, next to the role", () => {
  const report = inspect(loadConfig(join(repoWith(TWO), "seisin.toml")));
  const w = report.warnings.filter((x) => x.kind === "trustd-open");
  assert.equal(w.length, 1);
  assert.match(w[0].headline, /^flutter: /);
  assert.ok(!report.warnings.some((x) => x.kind === "unknown-role-key"));
  assert.match(renderReport(report), /trustd.*system verifier/);
});
