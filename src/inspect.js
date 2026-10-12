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
import { unknownRole } from "./suggest.js";
import { protections } from "./surface.js";
import { LIMITS } from "./inspect/limits.js";
import { sharedPaths } from "./inspect/shared.js";
import { codexSignIn } from "./inspect/codex.js";
import { warningsFor } from "./inspect/warnings.js";

// The warnings live in src/inspect/, one family per file; this is the entry point.
export { sharedPaths, codexSignIn };

/**
 * A report on one config: the roles, and every way the map lies.
 *
 * `only` narrows to a single role, and an unknown name is an error rather than
 * an empty report — asking about a role that does not exist is a typo, and
 * answering it with silence is how a typo becomes a belief.
 */
export function inspect(config, only = null, where = config.path) {
  if (only && !config.roles[only]) throw unknownRole(config, only);
  const roles = only ? [config.roles[only]] : Object.values(config.roles);
  // Once: it is listed on its own and again as a warning, and it is the most
  // expensive thing check computes.
  const shared = sharedPaths(config, roles);

  return {
    where,
    roles: roles.map((r) => ({ name: r.name, writes: r.writes, keys: r.keys,
      reads: r.reads ?? [], toolchain: r.toolchain ?? [], verify: r.verify,
      neverWrites: r.neverWrites ?? [], localBinding: r.localBinding === true,
      localPorts: r.localPorts ?? [], mcp: r.mcp ?? null, trustd: r.trustd === true })),
    /**
     * The provider commands this config would run, listed because they are the
     * one thing in a `seisin.toml` that **executes**, and it executes in the
     * parent, unsandboxed, as you. Everything else in the file only describes a
     * boundary. `check` runs nothing, so this is where you see them first — and
     * seeing them first is the whole point when the file came with a repo you
     * cloned rather than one you wrote.
     */
    providers: Object.values(config.keyProviders ?? {}).map((p) => ({
      name: p.name, command: p.command, mode: p.mode,
    })),
    shared,
    /**
     * What the kernel will deny a role inside its own territory, and why:
     * programs installed where a role writes, the hooks and settings of each
     * project, provider scripts and `file://` targets. Each takes something
     * away from a territory as written, so it is shown rather than applied
     * quietly. See surface.js for the family and the measurements.
     */
    protected: protections(config, roles),
    warnings: warningsFor(config, roles, shared, { scoped: !!only }),
    limits: LIMITS,
  };
}
