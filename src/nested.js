/**
 * Agents that sandbox themselves, and why seisin has to say so first.
 *
 * `codex` confines every command it runs with its own `sandbox-exec` profile.
 * macOS will not apply a second Seatbelt profile to a process that already has
 * one, so inside `seisin run` it fails with:
 *
 *     sandbox-exec: sandbox_apply: Operation not permitted
 *
 * Measured, twice: the README has it from the original run and the lab
 * reproduced it — exit 71, and the inner command never produced a byte.
 *
 * Two things make it a special case in a tool that otherwise has none.
 *
 * **It does not fail at the start.** The agent launches, reads, thinks, and
 * dies on the first command it tries to confine. So the operator sees a turn
 * that did nothing, which reads exactly like an agent with nothing to do.
 *
 * **And the error explains nothing.** It names neither seisin, nor the agent,
 * nor the fix. For a tool whose whole claim is that a refusal tells you what
 * happened, shipping the one message that says nothing is the worst available
 * outcome — so this is checked before the spawn and said in words.
 *
 * It is a closed list, not a detector. Guessing which binaries sandbox
 * themselves from their name would be wrong in both directions, and being
 * wrong here means printing a warning about a thing that is not happening.
 */

/**
 * What each agent does by default, and what turns it off.
 *
 * `on: true` means the agent confines by default, so the warning is the
 * normal case and silence needs a flag. codex is that. gemini is the other
 * way round: off unless asked. Getting this backwards means warning about a
 * thing that is not happening, which trains people to skip the line.
 *
 * `opencode` is absent. It has been run under seisin and the
 * README describes its behaviour, but nothing here has measured whether it
 * confines its own commands, and a closed list holds only what was checked.
 */
const SELF_SANDBOXING = {
  codex: {
    on: true,
    // `-s danger-full-access` first: it is the one to suggest. It turns off only
    // the sandbox, and inside `seisin run` that is the whole change wanted —
    // `--dangerously-bypass…` also turns off approvals, which says more than
    // the situation needs. Warning about `-s danger-full-access` was a warning
    // about a thing that was not happening: measured on 2026-09-30 with codex
    // 0.150.1, a turn under seisin with that flag ran its commands and finished.
    off: ["--sandbox=danger-full-access", "--dangerously-bypass-approvals-and-sandbox"],
    // The same setting spelt as a flag and its value, two words.
    offPairs: [["-s", "danger-full-access"], ["--sandbox", "danger-full-access"]],
    // The subcommand whose entire job is to confine. No flag turns that off.
    never: ["sandbox"],
  },
  gemini: { on: false, onWith: ["-s", "--sandbox"], off: ["--sandbox=false"] },
};

/** The basename of a command, without its path. */
const bare = (c) => String(c ?? "").split("/").pop();

/**
 * The warning for this command line, or null.
 *
 * Takes the argv `run` is about to spawn, and looks only at the first token
 * and its flags. Anything cleverer would be guessing at a shell it cannot
 * parse, and a wrong warning is worse than no warning.
 */
export function nestedSandboxWarning(cmd = []) {
  const name = bare(cmd[0]);
  const spec = Object.prototype.hasOwnProperty.call(SELF_SANDBOXING, name) ? SELF_SANDBOXING[name] : null;
  if (!spec) return null;

  const rest = cmd.slice(1);
  if ((spec.never ?? []).includes(rest[0]))
    return (
      `\`${name} ${rest[0]}\` exists to run a command inside a sandbox, so it cannot run inside ` +
      `one. The OS will not apply a second profile to a process that already has one.\n` +
      `  Run the command directly — seisin is already the boundary here.`
    );

  const turnedOff = (spec.off ?? []).some((f) => rest.some((a) => a === f || a.startsWith(f + "="))) ||
    (spec.offPairs ?? []).some(([flag, value]) => rest.some((a, i) => a === flag && rest[i + 1] === value));
  if (turnedOff) return null;
  const confining = spec.on || (spec.onWith ?? []).some((f) => rest.includes(f));
  if (!confining) return null;

  return (
    `${name} confines the commands it runs with its own sandbox, and the OS will not apply a ` +
    `second profile to a process that already has one.\n` +
    `  This does not fail here — it fails on the first command ${name} tries to run, which ` +
    `looks like an agent that did nothing.\n` +
    `  Run it with its own sandbox off: \`${name} … ${spec.offPairs ? spec.offPairs[0].join(" ") : (spec.off ?? ["--no-sandbox"])[0]}\`.`
  );
}
