/**
 * Which sandbox a role runs under.
 *
 * seisin decides the policy; a sandbox enforces it. There are three ways in:
 *
 *   - `srt` (built in, the default): @anthropic-ai/sandbox-runtime;
 *   - `tartaros` (built in): reads the settings file itself (`--settings`);
 *   - any name declared under `[sandbox.providers.<name>]`: a command that
 *     takes the settings file (command.js, docs/sandboxes.md).
 *
 * `[sandbox] provider` names one, or several in order of preference:
 *
 *   [sandbox]
 *   provider = ["tartaros", "srt"]
 *
 * The choice is a capability question, not a preference toggle
 * (docs/decisions.md): each role gets the first one that is installed and
 * enforces every part of that role's settings. One that would enforce less is
 * passed over with the reason, and a role none of them can hold does not start.
 * A single name means exactly that one, so a config that asks for tartaros
 * never ends up somewhere else without having said so.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { srt } from "./srt.js";
import { tartaros } from "./tartaros.js";
import { commandSandbox } from "./command.js";

export const BUILTIN_SANDBOXES = { srt, tartaros };
export const DEFAULT_SANDBOX = "srt";

/** The sandboxes the config names, in its order, as provider objects. */
export function sandboxesOf(config) {
  const names = config.sandbox?.provider ?? [DEFAULT_SANDBOX];
  return names.map((n) => BUILTIN_SANDBOXES[n] ?? commandSandbox(n, config.sandbox.providers[n].command, config.sandbox.providers[n].check));
}

/**
 * For each sandbox the config names, whether it could run these settings and
 * why not. `chosen` is the first that can, or null.
 *
 * A sandbox that answers for itself (tartaros, a declared one with `check`) is
 * asked about the file a run would hand it: `file` when the run has written
 * one, otherwise a copy in a temp directory of its own, removed after. Only a
 * sandbox that was found is asked; one that was not is passed over as missing.
 */
export function weigh(config, settings, { platform = process.platform, role = null, locate = true, file = null } = {}) {
  const list = sandboxesOf(config);
  let scratch = null;
  const fileFor = () => {
    if (file) return file;
    scratch ??= mkdtempSync(join(tmpdir(), "seisin-weigh-"));
    const f = join(scratch, "settings.json");
    writeFileSync(f, JSON.stringify(settings, null, 2), { mode: 0o600 });
    return f;
  };
  try {
    const options = list.map((sandbox) => {
      const bin = locate ? sandbox.locate() : "(not looked up)";
      const asked = sandbox.asksFile && locate && bin;
      const unmet = sandbox.asksFile && !asked ? [] : sandbox.unmet(settings, { platform, role, bin, file: asked ? fileFor() : null });
      return { sandbox, bin, unmet, missing: bin ? null : sandbox.missing() };
    });
    const chosen = options.find((o) => o.bin && o.unmet.length === 0) ?? null;
    return { chosen, options };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** The sandbox and binary for one run, or an Error that says why each was passed over. */
export function chooseSandbox(config, settings, { platform = process.platform, role = null, file = null } = {}) {
  const { chosen, options } = weigh(config, settings, { platform, role, file });
  if (chosen) return { sandbox: chosen.sandbox, bin: chosen.bin, options };
  // The one sandbox there is, missing: said exactly as it always was.
  if (options.length === 1 && options[0].missing && options[0].sandbox.name === DEFAULT_SANDBOX)
    return { error: new Error(options[0].missing), options };
  return { error: new Error(refusal(role, options)), options };
}

export function refusal(role, options) {
  const lines = options.map((o) => o.missing
    ? `  - ${o.sandbox.name}: ${o.missing}`
    : `  - ${o.sandbox.name} cannot enforce all of it:\n${o.unmet.map((u) => `      ${u}`).join("\n")}`);
  return `no sandbox in [sandbox] provider can hold ${role ? `role ${role}` : "this role"} as its policy is written, so it was not started:\n` +
    `${lines.join("\n")}\n` +
    `  A sandbox that enforces less than the policy is never used in its place. Add one that can (provider = [..., "srt"]), ` +
    `or change the role.`;
}
