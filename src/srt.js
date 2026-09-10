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
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";

/**
 * What every agent needs to write no matter which role it is.
 *
 * Found by running a real cell config through the sandbox: territory alone
 * looks correct and is unusable. An agent writes its session state under its
 * own config directory and its tools write scratch files to the temp dir, so a
 * policy of "your folders and nothing else" stops the agent before it starts.
 *
 * These are grants, so they are listed rather than assumed: `seisin check`
 * prints them, and `[runtime] writes = []` turns them off for anyone who wants
 * to find out the hard way. Note what is NOT here — the home directory, the
 * shell profile, anything under the repo. Scratch space is not a back door.
 */
export const RUNTIME_WRITES = ["~/.claude", "~/.codex", "~/.cache", "$TMPDIR", "/tmp"];

/**
 * `~` and `$TMPDIR` are the only expansions; everything else is a literal path.
 *
 * Symlinks are then resolved, and that is not a nicety. On macOS `/tmp` is a
 * link to `/private/tmp`, and the sandbox enforces on the destination — so a
 * grant written as `/tmp` grants exactly nothing, silently. Measured: with the
 * literal path, writing to /tmp inside the sandbox failed while the policy
 * looked correct on screen.
 */
export function expand(p) {
  let out = p;
  if (p === "$TMPDIR") out = tmpdir();
  else if (p === "~" || p.startsWith("~/")) out = join(homedir(), p.slice(2));
  try {
    return realpathSync(out);
  } catch {
    return out; // not on disk yet; hand the literal through rather than drop it
  }
}

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
      allowWrite: [
        ...role.writes.map(toWritePath).map(abs),
        ...(config.runtimeWrites ?? RUNTIME_WRITES).map(expand),
      ],
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
