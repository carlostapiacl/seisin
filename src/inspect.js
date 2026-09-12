/**
 * What `check` knows, without printing any of it.
 *
 * The warnings below used to live inside the command, interleaved with the
 * writes that printed them, which made them unreachable from a test: the only
 * way to assert that seisin notices a repo sitting inside shared scratch was to
 * run the binary and grep its output. They are the most valuable thing `check`
 * does — each one is a way the policy silently does not hold — so they belong
 * where they can be exercised directly.
 */
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { ownersOf } from "./owners.js";
import { RUNTIME_WRITES, expand, settingsFor } from "./srt.js";

/**
 * A report on one config: the roles, and every way the map lies.
 *
 * `only` narrows to a single role, and an unknown name is an error rather than
 * an empty report — asking about a role that does not exist is a typo, and
 * answering it with silence is how a typo becomes a belief.
 */
export function inspect(config, only = null, where = config.path) {
  if (only && !config.roles[only]) throw new Error(`unknown role "${only}"`);
  const roles = only ? [config.roles[only]] : Object.values(config.roles);

  return {
    where,
    roles: roles.map((r) => ({ name: r.name, writes: r.writes, keys: r.keys })),
    shared: sharedPaths(config, roles),
    warnings: warningsFor(config, roles),
    limits: LIMITS,
  };
}

/**
 * What the tool cannot do at all — as opposed to `warnings`, which are things
 * wrong with *this* config.
 *
 * Kept apart on purpose. A limit printed as a warning reads as something the
 * operator could fix, and after the third run it reads as nothing at all.
 *
 * These are the sentences someone needs before they trust the map on screen
 * more than it deserves, so `check` prints them every time rather than behind a
 * flag: the moment to learn that deletes are not covered is while you are
 * looking at the policy, not afterwards.
 */
const LIMITS = [
  {
    kind: "keys-only-what-you-declared",
    headline: "key isolation covers the directory you declared, and nothing else",
    detail:
      "a credential sitting in the repo outside [keys] dir is ordinary readable " +
      "content to every role. Run `seisin scan` to find them — check does not, " +
      "because reading the whole tree on every invocation is how a command stops " +
      "being run.",
  },
  {
    kind: "unlink-uncovered",
    headline: "a role can delete inside its own territory",
    detail:
      // The path that used to be here ships with the repo and not with the npm
      // package, so for most readers it named a file they do not have.
      "writes and deletes are one permission to the kernel, so `rm` inside a " +
      "role's own folders succeeds. Closing it needs denyUnlink in the sandbox " +
      "runtime: github.com/carlostapiaolguin3-stack/seisin#how-it-holds",
  },
];

/**
 * Paths more than one role claims.
 *
 * Overlap is allowed and sometimes right — a hotfix role deliberately reaches
 * into the territory of the role that normally owns a repo. It is reported so
 * that it stays a decision somebody made rather than a thing that drifted.
 */
export function sharedPaths(config, roles = Object.values(config.roles)) {
  const seen = new Set();
  for (const r of roles)
    for (const glob of r.writes)
      if (ownersOf(config, glob.replace(/\/\*\*$/, "")).length > 1) seen.add(glob);
  return [...seen];
}

/** Every way this policy does not hold, each with what to do about it. */
function warningsFor(config, roles) {
  const warnings = [];

  // A pattern the kernel cannot be given is not a policy, it is a sentence that
  // reads like one. `run` refuses it; `check` exists precisely so you find that
  // out while reading the map rather than mid-turn.
  for (const r of roles) {
    for (const w of r.writes) {
      try {
        settingsFor(config, r.name);
      } catch (e) {
        warnings.push({ kind: "unenforceable-glob", headline: `${r.name}: ${e.message.split("\n")[0]}`,
                        detail: e.message.split("\n").slice(1).map((s) => s.trim()).join(" ") });
        break;
      }
    }
  }
  const shared = sharedPaths(config, roles);

  if (shared.length)
    warnings.push({
      kind: "shared",
      headline: `${shared.length} path(s) claimed by more than one role: ${shared.join(" ")}`,
      detail: "Overlap is allowed — seisin will name every owner. It is listed so it stays a decision.",
    });

  // Scratch is granted to every role, so a repo sitting inside it is writable
  // by all of them no matter what the territory says. Saying so is the
  // difference between a limitation and a trap — and it is not hypothetical:
  // the test fixture lived in the temp dir and made a boundary test pass for
  // the wrong reason.
  // Both sides resolved, or the comparison is a coin flip. `expand()` follows
  // symlinks — it has to, because on macOS /tmp is a link to /private/tmp and a
  // grant written as /tmp grants nothing — so the root has to be followed too.
  // Without this a repo at /tmp/x is never reported as sitting in scratch,
  // which is the one case where the warning matters most.
  const scratch = (config.runtimeWrites ?? RUNTIME_WRITES).map(expand);
  const root = realOrSelf(resolve(config.root));
  const inside = scratch.filter((s) => root === s || root.startsWith(s + "/"));
  if (inside.length)
    warnings.push({
      kind: "scratch",
      headline: `this repo lives inside shared scratch space (${inside[0]})`,
      detail: "Every role can write scratch, so territory does not hold here. Move the repo, or set [runtime] writes = [].",
    });

  if (config.keyDirs.length === 0 && Object.values(config.roles).some((r) => r.keys.length))
    warnings.push({
      kind: "keys-unscoped",
      headline: "keys are listed but [keys] dir is unset — nothing will be scoped",
      detail: null,
    });

  return warnings;
}

/** The path with symlinks followed, or the path itself if it is not on disk. */
function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
