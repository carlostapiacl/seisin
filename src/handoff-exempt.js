/**
 * Where a role's trust-handoff protection does not apply, as absolute paths.
 *
 * One answer for every reader. The list was computed in four places — the run
 * (commands/run.js), the choice of sandbox (sandboxes/index.js), the patterns
 * the kernel is given and the "is this path protected" answer (surface.js) —
 * each with its own `join(config.root, e)`. Four copies of one rule is how a
 * change reaches three of them, and the run would then enforce one boundary
 * while `seisin explain` described another.
 *
 * `handoff_exempt` is validated in config.js: relative to the repo, no `..`,
 * no globs. What a sandbox accepts on top of that (tartaros: strictly inside a
 * writable root, not a handoff surface itself) is the sandbox's to check.
 */
import { join } from "node:path";
import { realpathSync } from "node:fs";

/** The role's exempt folders, absolute. Empty for no role or an unknown one. */
export function handoffExemptOf(config, role) {
  const r = typeof role === "string" ? config.roles?.[role] : role;
  return (r?.handoffExempt ?? []).map((e) => join(config.root, e));
}

/**
 * `[runtime] scratch`, as the sandbox enforces it: absolute and with symlinks
 * resolved (`/tmp` is `/private/tmp` on macOS, and a root written as the link
 * would be a different path from the one the kernel sees).
 */
export function handoffScratchOf(config) {
  return (config.scratch ?? []).map((p) => {
    try { return realpathSync.native(p); } catch { return p; }
  });
}

/**
 * Every folder where the role's trust-handoff protection is lifted: its
 * `handoff_exempt` dependency trees and the run's scratch roots. What answers
 * "is this path protected" reads this; what hands the two to a sandbox keeps
 * them apart, because tartaros validates them differently.
 */
export function handoffOpenOf(config, role) {
  return [...handoffExemptOf(config, role), ...handoffScratchOf(config)];
}
