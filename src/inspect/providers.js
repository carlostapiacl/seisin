import { existsSync } from "node:fs";
import { entriesOf } from "../keys.js";
import { resolveExecutable } from "../surface.js";

/**
 * Would the parent find this command? The same lookup `run` makes
 * (resolveExecutable), so check does not call "missing" a program that is
 * only in a directory a role writes — that has its own warning, above.
 */
function onPath(cmd, config) {
  try {
    // A path is resolved against the policy and not looked up, so it is there
    // only if it exists.
    return existsSync(resolveExecutable(cmd, config));
  } catch (e) {
    return /a role can write/.test(e.message);
  }
}

export function providerInTerritoryWarnings(config) {
  const warnings = [];
  // A provider the parent could not find where no role writes. `run` refuses
  // it with the same sentence; here it is found before anybody runs anything.
  for (const [scheme, p] of Object.entries(config.keyProviders ?? {})) {
    const cmd = p.command?.[0];
    if (!cmd || cmd.includes("/")) continue;
    try { resolveExecutable(cmd, config); } catch (e) {
      if (!/a role can write/.test(e.message)) continue;
      warnings.push({
        kind: "provider-in-territory",
        headline: `the ${scheme}:// provider "${cmd}" is only found where a role can write`,
        detail: e.message.split("\n").slice(1).map((l) => l.trim()).join(" "),
      });
    }
  }
  return warnings;
}

export function providerMissingWarnings(config) {
  const warnings = [];
  /**
   * A provider whose command is not on PATH.
   *
   * This is the half of validating references that can be done without
   * resolving one — which is the whole requirement: a broken policy has to be
   * visible in `check`, not on the first run, and certainly not by asking
   * somebody's keychain for a password to find out. The scheme and the
   * provider are checked when the config loads, so by the time we are here
   * they exist; what is left is whether the command does.
   *
   * A warning and not an error: the binary can legitimately be missing on the
   * machine reading the policy and present on the one that runs it, which is
   * every CI checkout.
   */
  const used = new Set();
  for (const r of Object.values(config.roles))
    for (const k of entriesOf(r)) if (k.kind === "ref") used.add(k.scheme);
  for (const scheme of [...used].sort()) {
    const provider = config.keyProviders?.[scheme];
    if (!provider || onPath(provider.command[0], config)) continue;
    warnings.push({
      kind: "provider-missing",
      headline: `the ${scheme} provider runs "${provider.command[0]}", which is not on PATH`,
      detail:
        "every key of that scheme will stop the run rather than resolve. Nothing is " +
        "substituted for a key that did not resolve, so this fails closed — but it fails " +
        "at the start of a run, not here.",
    });
  }
  return warnings;
}
