import { CREDENTIAL_HOMES } from "../srt.js";

/**
 * What a role can still read in YOUR home, which is the limit people are most
 * surprised by.
 *
 * `~/.ssh`, `~/.aws/credentials`, `~/.npmrc` and `~/.config/gh/hosts.yml` are
 * ordinary readable files to every role unless `[runtime] isolate` says
 * otherwise, and nothing on screen said so. Reads outside the key directories
 * being open is a deliberate trade - an agent that cannot read the machine
 * cannot work - but a trade nobody was shown is not a trade they made.
 *
 * It reports the level rather than pushing one. `credentials` closes those four
 * and leaves the agent logged in; `home` closes the agent's own directories too
 * and costs the session. Which of the two you want is the threat model, which
 * is why there is no default beyond off.
 */
export function homeReachWarning(config) {
  if (config.read === "territory") return null;
  const level = config.isolate === true ? "home" : config.isolate;
  if (level === "home") return null;             // nothing left to say

  const where = CREDENTIAL_HOMES.slice(0, 4).join(" ");
  return level === "credentials"
    ? {
        kind: "home-partly-open",
        headline: "your credentials are closed to every role; the agent's own directories are not",
        detail:
          `isolate = "credentials" denies ${where} and the rest. What stays open is ` +
          "~/.claude to runs of claude and ~/.codex to runs of codex, which is what keeps the " +
          "agent signed in, so the runs of one agent share its session and can read each other's. " +
          '`isolate = "home"` closes those ' +
          "too, and then every CLI in the sandbox will ask you to log in again.",
      }
    : {
        kind: "home-open",
        headline: `every role can read ${where} and the rest of your home`,
        detail:
          "reads outside the [keys] dir are open on purpose - an agent that cannot read the " +
          "machine cannot work - but that includes the places credentials live. " +
          '`[runtime] isolate = "credentials"` closes them, and the agent stays logged in.',
      };
}
