/**
 * `[network] deny_addresses`: the private ranges an allowed domain may not
 * resolve to. The runtime denies loopback, link-local and metadata on its own
 * and leaves the rest to the policy; this is where the policy says it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { repoWith as shared } from "./_tmp.js";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";

const load = (toml) => loadConfig(join(shared("deny-addr-", toml, ["app/"]), "seisin.toml"));
const ROLE = '[roles.app]\nwrites = ["app/**"]\n';

test("absent: the settings carry no deniedResolvedAddresses at all", () => {
  const cfg = load('[network]\nallow = ["example.com"]\n\n' + ROLE);
  assert.deepEqual(cfg.deniedAddresses, []);
  assert.equal("deniedResolvedAddresses" in settingsFor(cfg, "app").network, false);
});

test("the ranges reach the runtime as written", () => {
  const ranges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "100.64.0.0/10"];
  const cfg = load(`[network]\nallow = ["example.com"]\ndeny_addresses = ${JSON.stringify(ranges)}\n\n` + ROLE);
  assert.deepEqual(settingsFor(cfg, "app").network.deniedResolvedAddresses, ranges);
});

test("a single address is accepted; anything that is not one refuses to load", () => {
  assert.deepEqual(load('[network]\ndeny_addresses = "192.168.1.10"\n\n' + ROLE).deniedAddresses, ["192.168.1.10"]);
  for (const bad of ['"intranet.local"', '"10.0.0.0/33"', '"fc00::/129"', '"10.0.0.0/8/1"', '"[fc00::]/7"', "[1]"])
    assert.throws(() => load(`[network]\ndeny_addresses = ${bad}\n\n` + ROLE),
      /not an IP address or a CIDR range|expected a string/, bad);
});

test("the runtime's own schema accepts what seisin emits", async () => {
  // Read from the installed runtime, so a rename of the field upstream fails
  // here and not at the first run.
  const { NetworkConfigSchema } = await import("../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js");
  const cfg = load('[network]\nallow = ["example.com"]\ndeny_addresses = ["10.0.0.0/8", "fc00::/7"]\n\n' + ROLE);
  const r = NetworkConfigSchema.safeParse(settingsFor(cfg, "app").network);
  assert.ok(r.success, JSON.stringify(r.error?.issues?.slice(0, 3)));
  assert.deepEqual(r.data.deniedResolvedAddresses, ["10.0.0.0/8", "fc00::/7"]);
});
