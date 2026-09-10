/**
 * Turns one role into a settings file for @anthropic-ai/sandbox-runtime.
 *
 * The schema is not guessed: it was read off the installed package and checked
 * against the real binary. Two things it taught us, both load-bearing here:
 *
 *   1. `network` and `filesystem` are top level. They are NOT nested under a
 *      `sandbox` key — that shape belongs to Claude Code's settings.json, which
 *      is a different file with a similar vocabulary. Mixing them up produces a
 *      config that parses as empty and denies everything.
 *   2. Every field is required. Leaving out `network.deniedDomains` or
 *      `filesystem.denyWrite` makes the runtime refuse to start rather than fall
 *      back to its defaults. Emitting the whole object removes that class of
 *      error, which is most of what this file is for.
 */
import { join } from "node:path";

/** Reads are denied wholesale under the key directory, then re-allowed one file at a time. */
export function settingsFor(config, roleName) {
  const role = config.roles[roleName];
  if (!role) throw new Error(`unknown role "${roleName}". Known: ${Object.keys(config.roles).join(", ")}`);

  const abs = (p) => (p.startsWith("/") ? p : join(config.root, p));
  const denyRead = [];
  const allowRead = [];

  if (config.keyDir) {
    denyRead.push(abs(config.keyDir));
    for (const key of role.keys) allowRead.push(abs(join(config.keyDir, key)));
  }

  return {
    network: {
      allowedDomains: role.network ?? config.allowedDomains,
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite: role.writes.map(toWritePath).map(abs),
      denyWrite: [],
    },
  };
}

/**
 * `allowWrite` takes directories, not globs: the OS grants a subtree, it does
 * not pattern-match. `src/api/**` and `src/api/` mean the same thing to the
 * kernel, so the trailing glob is trimmed rather than passed through, where it
 * would be read as a literal directory named `**` and silently grant nothing.
 */
function toWritePath(glob) {
  return glob.replace(/\/\*\*$/, "").replace(/\/\*$/, "") || ".";
}
