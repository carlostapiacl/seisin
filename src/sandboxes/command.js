/**
 * A sandbox declared in seisin.toml: a command with a placeholder.
 *
 *   [sandbox.providers.mybox]
 *   command = ["mybox", "run", "--policy", "{policy}", "--"]
 *
 * The same shape as a key provider (keys.js), for the same reason: adding a
 * sandbox is three lines of TOML and no code. seisin replaces `{policy}` with
 * the path of the run's settings file and appends the command to run. The
 * contract the provider takes on is in docs/sandboxes.md; the short form:
 *
 *   - the file is the settings seisin generates, in sandbox-runtime's schema;
 *   - the provider enforces every field of it, or exits non-zero before
 *     running anything — it never runs the command with less;
 *   - it passes the command's exit status through.
 *
 * seisin cannot see inside a provider, so `unmet` has nothing to say for one,
 * and the contract is not taken on faith: every run starts with the canary
 * (canary.js) under the same provider and the same file, and the agent starts
 * only if the boundary held. A provider that ignores the file fails there.
 */
import { existsSync } from "node:fs";
import { join, delimiter, isAbsolute } from "node:path";

export const POLICY_PLACEHOLDER = "{policy}";

function onPath(name, path = process.env.PATH) {
  if (name.includes("/")) return isAbsolute(name) && existsSync(name) ? name : null;
  for (const dir of (path ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

export function commandSandbox(name, command) {
  return {
    name,
    locate: () => onPath(command[0]),
    missing: () => `${command[0]} (the command of [sandbox.providers.${name}]) was not found${command[0].includes("/") ? "" : " on PATH"}.`,
    unmet: () => [],
    wrap: (bin, file, _settings, inner) => [bin, ...command.slice(1).map((a) => a.split(POLICY_PLACEHOLDER).join(file)), ...inner],
    tagsDenials: false,
  };
}
