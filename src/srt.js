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
import { STATE_DIR } from "./layout.js";
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
 * The list is not Claude-shaped by accident and it was Claude-shaped by
 * mistake: the first version named `~/.claude` and `~/.codex` and stopped
 * there, so the first agent that was neither — opencode, which logs to
 * `~/.local/share/opencode` — died on startup with `FileSystem.open`. Hence the
 * XDG directories, which is where a CLI that follows convention puts its state.
 *
 * `~/.config` is deliberately NOT here. That is where credentials live —
 * `~/.config/gh/hosts.yml` holds a GitHub token — and while reads outside the
 * declared key directories are open anyway, letting an agent WRITE there is a
 * different thing. A CLI that needs it can be granted it by name.
 *
 * These are grants, so they are listed rather than assumed: `seisin check`
 * prints them, and `[runtime] writes = []` turns them off for anyone who wants
 * to find out the hard way. Note what is NOT here — the home directory, the
 * shell profile, anything under the repo. Scratch space is not a back door.
 */
export const RUNTIME_WRITES = [
  "~/.claude", "~/.codex",                 // the CLIs that keep state under their own name
  "~/.local/share", "~/.local/state",      // XDG data and state: where most others log
  "~/.cache", "$TMPDIR", "/tmp",
];

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

  // Every declared directory is denied, then each key the role names is
  // re-allowed. A key written without a directory resolves against the first
  // one, which keeps the ordinary single-directory config short.
  const dirs = config.keyDirs ?? [];
  for (const dir of dirs) denyRead.push(abs(dir));
  for (const key of role.keys)
    allowRead.push(key.includes("/") ? abs(key) : abs(join(dirs[0] ?? ".", key)));

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
        // seisin's own log directory, always. The hook records every attempt
        // there, and `.seisin/` belongs to no role — so without this the hook
        // cannot write and, because it swallows its own errors on purpose, it
        // fails silently. The log came back empty from a run that worked
        // perfectly, which is the worst way for an instrument to break.
        abs(STATE_DIR),
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
  if (!EXPRESSIBLE(glob)) throw new Error(unexpressible(glob));
  if (glob === "**") return ".";
  return glob.replace(/\/\*\*$/, "") || ".";
}

/**
 * A write pattern the kernel can be given without changing its meaning.
 *
 * Exactly two shapes qualify: a literal path, and a subtree ending in `/**`.
 * Both map onto what allowWrite actually is — a prefix — so the policy, the
 * explanation and the enforcement stay the same sentence.
 *
 * Everything else is refused, and the one that made this necessary is `src/*`.
 * ownersOf() reads it as one level, because `*` compiles to `[^/]*`. The old
 * translation trimmed the `/*` and handed the kernel `src`, which is the whole
 * subtree. So `seisin explain` said denied and the write landed — measured, not
 * theorised. The document was tighter than the boundary, which is the one
 * direction a permission tool must never fail in.
 *
 * There is no exact translation to find later: Seatbelt and bubblewrap grant
 * prefixes, and "one level down" is not a prefix. Refusing is not a placeholder
 * here, it is the answer.
 */
const WILD = /[*?[\]]/;                       // owners.js treats all four as wildcards
const EXPRESSIBLE = (g) =>
  g === "**" ||                               // the whole repo
  !WILD.test(g) ||                            // a literal path
  (g.endsWith("/**") && !WILD.test(g.slice(0, -3)));   // a subtree, wildcard-free above it

function unexpressible(glob) {
  return `writes = "${glob}" cannot be enforced as written.\n` +
    `  The sandbox grants a path and everything under it — there is no way to say ` +
    `"one level deep".\n` +
    `  Use "${glob.replace(/\/\*$/, "")}/**" for the whole subtree, or name the files.\n` +
    `  Refusing rather than widening: the old behaviour granted the subtree while ` +
    `seisin reported the narrow pattern.`;
}
