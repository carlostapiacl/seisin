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
import { resolve, dirname, basename, relative, join, delimiter, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { lstatSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { ownersOf, covers, enforcedNeverWrites } from "./owners.js";
import { ROLE_KEYS, closest } from "./config.js";
import { entriesOf } from "./keys.js";
import { SHAPES } from "./scan.js";
import { wired, broadlyWired } from "./commands/wire.js";
import { RUNTIME_WRITES, CREDENTIAL_HOMES, expand, settingsFor } from "./srt.js";
import { realOrSelf } from "./grants.js";
import { keptFor, shutByTerritory, readPath, dataRoots } from "./territory.js";
import { realAncestor } from "./paths.js";
import { protections, resolveExecutable } from "./surface.js";
import { LIMITS } from "./inspect/limits.js";
import { sharedPaths } from "./inspect/shared.js";
import { homeReachWarning } from "./inspect/home.js";
import { credentialish } from "./inspect/credentials.js";
import { codexSignIn, codexSignInWarnings } from "./inspect/codex.js";
import { roleKeyWarnings } from "./inspect/role-keys.js";
import { territoryOf, implicitSidecar, under, regularFilesIn } from "./inspect/files.js";
import { enforceWarnings } from "./inspect/enforce.js";
import { providerInTerritoryWarnings, providerMissingWarnings } from "./inspect/providers.js";
import { relativePathWarnings, scratchWarnings, hookWarnings } from "./inspect/machine.js";
import { modelEndpointWarnings } from "./inspect/network.js";
import { layoutWarnings } from "./inspect/layout.js";
import { envWarnings, keyFloorWarnings } from "./inspect/keys.js";

/**
 * A report on one config: the roles, and every way the map lies.
 *
 * `only` narrows to a single role, and an unknown name is an error rather than
 * an empty report — asking about a role that does not exist is a typo, and
 * answering it with silence is how a typo becomes a belief.
 */
export { sharedPaths, codexSignIn };

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

/** Every way this policy does not hold, each with what to do about it. */
function warningsFor(config, roles, shared = sharedPaths(config, roles), { scoped = false } = {}) {
  const warnings = [];

  warnings.push(...enforceWarnings(config, roles));
  warnings.push(...roleKeyWarnings(roles, config));

  warnings.push(...providerInTerritoryWarnings(config));

  warnings.push(...relativePathWarnings());
  if (shared.length)
    warnings.push({
      kind: "shared",
      headline: `${shared.length} path(s) claimed by more than one role: ${shared.join(" ")}`,
      detail: "Overlap is allowed — seisin will name every owner. It is listed so it stays a decision.",
    });

  warnings.push(...scratchWarnings(config));

  warnings.push(...modelEndpointWarnings(config, roles));

  warnings.push(...codexSignInWarnings(config, roles));

  // Without the hook, half the record is missing rather than all of it: on macOS
  // `seisin run` reads the kernel's own denials, so they still land and
  // still queue a request. What goes unrecorded is everything the kernel
  // allowed — which is the half `init --from-observations` is built out of, and
  // the half that tells "nothing was denied" apart from "nobody was watching".
  // The one limit that is about YOUR machine rather than about the repo.
  const reach = homeReachWarning(config);
  if (reach) warnings.push(reach);

  warnings.push(...hookWarnings(config));

  warnings.push(...layoutWarnings(config, roles, scoped));

  warnings.push(...envWarnings(roles));

  warnings.push(...keyFloorWarnings(config));

  warnings.push(...providerMissingWarnings(config));

  return warnings;
}
