import { sharedPaths } from "./shared.js";
import { homeReachWarning } from "./home.js";
import { codexSignInWarnings } from "./codex.js";
import { roleKeyWarnings } from "./role-keys.js";
import { enforceWarnings } from "./enforce.js";
import { providerInTerritoryWarnings, providerMissingWarnings } from "./providers.js";
import { relativePathWarnings, scratchWarnings, hookWarnings } from "./machine.js";
import { modelEndpointWarnings } from "./network.js";
import { layoutWarnings } from "./layout.js";
import { envWarnings, keyFloorWarnings } from "./keys.js";

/** Every way this policy does not hold, each with what to do about it. */
export function warningsFor(config, roles, shared = sharedPaths(config, roles), { scoped = false } = {}) {
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
