/**
 * key_mode = "inject": the mode where the agent sees a sentinel and the real
 * value is substituted on egress to the credential's declared hosts.
 *
 * These exercise the policy-to-settings translation and the warnings, with no
 * runtime spawned: `settingsFor` emits `credentials` and `tlsTerminate`, and
 * `injectWarnings` prices the MITM and names what inject does not close.
 * Platform behaviour (Linux runs it, elsewhere it is held) is asserted against
 * `process.platform` so the file passes on both the dev Mac and Linux CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { modeOf, entriesOf, injectKeysOf } from "../src/keys.js";
import { warningsFor } from "../src/inspect/warnings.js";

/** A repo whose one role injects, with the hosts table and network given. */
function repo({ keys = '["GH_TOKEN=op://v/gh"]', hosts = 'GH_TOKEN = ["api.github.com"]', network = '["api.github.com"]', mode = "inject" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seisin-inject-"));
  writeFileSync(join(dir, "seisin.toml"),
    `[keys.providers.op]\ncommand = ["op", "read", "op://{ref}"]\nmode = "env"\n\n` +
    `[network]\nallow = ["api.github.com"]\n\n` +
    `[roles.r]\nwrites = ["src/**"]\nnetwork = ${network}\nkey_mode = "${mode}"\nkeys = ${keys}\n\n` +
    (hosts ? `[roles.r.inject_hosts]\n${hosts}\n` : ""));
  const cfg = loadConfig(join(dir, "seisin.toml"));
  return { cfg, dir };
}
const clean = (d) => rmSync(d, { recursive: true, force: true });
const injectWs = (cfg) => warningsFor(cfg, Object.values(cfg.roles)).filter((w) => w.kind.startsWith("inject") || w.kind === "cannot-be-enforced");

// ── config ────────────────────────────────────────────────────────────────

test("inject_hosts parses as a nested table under the role, the one such table allowed", () => {
  const { cfg, dir } = repo();
  assert.deepEqual(cfg.roles.r.injectHosts, { GH_TOKEN: ["api.github.com"] });
  clean(dir);
});

test("a nested table under a role other than inject_hosts is still the dotted-name error", () => {
  const dir = mkdtempSync(join(tmpdir(), "seisin-inject-"));
  writeFileSync(join(dir, "seisin.toml"),
    `[network]\nallow = ["x"]\n[roles.r]\nwrites = ["s"]\n[roles.r.other]\nx = 1\n`);
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /a role called "r", not "r\.other"/);
  clean(dir);
});

test("a wildcard inject host is refused at load — an inject host is exact", () => {
  assert.throws(() => repo({ hosts: 'GH_TOKEN = ["*.github.com"]' }), /wildcard/);
});

test("an inject host with no hosts listed is refused", () => {
  assert.throws(() => repo({ hosts: 'GH_TOKEN = []' }), /injects nowhere/);
});

// ── emission ────────────────────────────────────────────────────────────────

test("settingsFor emits one masked envVar per credential with its injectHosts", () => {
  const { cfg, dir } = repo();
  const s = settingsFor(cfg, "r");
  assert.deepEqual(s.credentials.envVars, [{ name: "GH_TOKEN", mode: "mask", injectHosts: ["api.github.com"] }]);
  clean(dir);
});

test("TLS is terminated only for the inject hosts; every other allowed domain is excluded", () => {
  const { cfg, dir } = repo({ network: '["api.github.com", "api.openai.com", "example.com"]' });
  const s = settingsFor(cfg, "r");
  assert.deepEqual(s.network.tlsTerminate.excludeDomains, ["api.openai.com", "example.com"]);
  clean(dir);
});

test("a wildcard allow that covers an inject host is terminated whole, not excluded", () => {
  const { cfg, dir } = repo({ network: '["*.github.com", "example.com"]' });
  const s = settingsFor(cfg, "r");
  // *.github.com carries api.github.com, so it is NOT in excludeDomains.
  assert.deepEqual(s.network.tlsTerminate.excludeDomains, ["example.com"]);
  clean(dir);
});

test("an inject host the role's network cannot reach is a load-time-valid, emit-time error", () => {
  const { cfg, dir } = repo({ network: '["example.com"]' });
  assert.throws(() => settingsFor(cfg, "r"), /not reachable/);
  clean(dir);
});

test("no credentials block and no tlsTerminate for a role that does not inject", () => {
  const { cfg, dir } = repo({ mode: "env", hosts: "" });
  const s = settingsFor(cfg, "r");
  assert.equal(s.credentials, undefined);
  assert.equal(s.network.tlsTerminate, undefined);
  clean(dir);
});

// ── consistency (injectKeysOf) ───────────────────────────────────────────────

test("an injected key with no inject_hosts entry is an unenforceable policy", () => {
  const { cfg, dir } = repo({ hosts: "" });
  assert.throws(() => injectKeysOf(cfg, cfg.roles.r), /injected but has no hosts/);
  clean(dir);
});

test("an inject_hosts entry for a key that is not injected is refused", () => {
  const { cfg, dir } = repo({ hosts: 'GH_TOKEN = ["api.github.com"]\nGHOST = ["api.github.com"]' });
  assert.throws(() => injectKeysOf(cfg, cfg.roles.r), /no injected key delivers GHOST/);
  clean(dir);
});

// ── platform gate ────────────────────────────────────────────────────────────

test("modeOf takes inject on Linux and macOS, where a sandbox masks; the sandbox decides which", () => {
  const { cfg, dir } = repo();
  const e = entriesOf(cfg.roles.r).find((x) => x.kind === "ref");
  if (process.platform === "linux" || process.platform === "darwin") assert.equal(modeOf(cfg, cfg.roles.r, e), "inject");
  else assert.throws(() => modeOf(cfg, cfg.roles.r, e), /not available on/);
  clean(dir);
});

// ── warnings ─────────────────────────────────────────────────────────────────

test("check warns the MITM scope and the reflection it does not close", () => {
  const { cfg, dir } = repo();
  const mitm = injectWs(cfg).find((w) => w.kind === "inject-mitm");
  assert.ok(mitm, "an inject-mitm warning is present");
  assert.match(mitm.headline, /GH_TOKEN is masked/);
  assert.match(mitm.detail, /recoverable by reflection/);
  assert.match(mitm.detail, /least-scope token/);
  clean(dir);
});

test("check names the wildcard that interception drags in whole", () => {
  const { cfg, dir } = repo({ network: '["*.github.com"]' });
  const mitm = injectWs(cfg).find((w) => w.kind === "inject-mitm");
  assert.match(mitm.detail, /\*\.github\.com is terminated whole/);
  clean(dir);
});

test("on macOS without tartaros, check says the role will not run here; with it, nothing", () => {
  const { cfg, dir } = repo();
  const plat = injectWs(cfg).find((w) => w.kind === "inject-platform");
  if (process.platform === "linux") assert.equal(plat, undefined);
  else { assert.ok(plat); assert.match(plat.detail, process.platform === "darwin" ? /593[\s\S]*tartaros/ : /Linux or macOS/); }
  clean(dir);
  if (process.platform !== "darwin") return;
  const d2 = mkdtempSync(join(tmpdir(), "seisin-inject-tt-"));
  writeFileSync(join(d2, "seisin.toml"),
    `[sandbox]\nprovider = ["tartaros", "srt"]\n\n[keys.providers.op]\ncommand = ["op", "read", "op://{ref}"]\nmode = "env"\n\n` +
    `[roles.r]\nwrites = ["src/**"]\nnetwork = ["api.github.com"]\nkey_mode = "inject"\nkeys = ["GH_TOKEN=op://v/gh"]\n\n` +
    `[roles.r.inject_hosts]\nGH_TOKEN = ["api.github.com"]\n`);
  assert.equal(injectWs(loadConfig(join(d2, "seisin.toml"))).find((w) => w.kind === "inject-platform"), undefined);
  clean(d2);
});
