/**
 * Which sandbox a role runs under.
 *
 * seisin decides the policy; a sandbox enforces it. There are three ways in:
 *
 *   - `tartaros` (built in, the default, installed with seisin): reads the
 *     settings file itself (`--settings`);
 *   - `srt` (built in, installed apart): @anthropic-ai/sandbox-runtime;
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
import { srt, SRT_PACKAGE, SRT_VERSION } from "./srt.js";
import { machOf } from "../browsers.js";
import { tartaros } from "./tartaros.js";
import { commandSandbox } from "./command.js";

export const BUILTIN_SANDBOXES = { srt, tartaros };
export const DEFAULT_SANDBOX = "tartaros";
/**
 * Without `[sandbox] provider`: tartaros, which installs with seisin, then srt
 * where it is installed apart (it is not a dependency since 0.7). A role
 * tartaros cannot hold (a blanket local binding, a host's missing Landlock)
 * runs under srt if it is there and holds all of it, and otherwise does not
 * run, with what each one lacked.
 */
export const DEFAULT_PROVIDERS = [DEFAULT_SANDBOX, "srt"];

/** The sandboxes the config names, in its order, as provider objects. */
export function sandboxesOf(config) {
  const names = config.sandbox?.provider ?? DEFAULT_PROVIDERS;
  return names.map((n) => BUILTIN_SANDBOXES[n] ?? commandSandbox(n, config.sandbox.providers[n].command, config.sandbox.providers[n].check, { tagsDenials: config.sandbox.providers[n].tagsDenials }));
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
  const register = role ? machOf(config.roles?.[role]).register : [];
  const exempt = role ? (config.roles?.[role]?.handoffExempt ?? []).map((e) => join(config.root, e)) : [];
  const requests = role ? (config.roles?.[role]?.requests ?? []) : [];
  let scratch = null;
  let copies = 0;
  // The file a sandbox is asked about is the one it would be handed: the run's
  // own when it takes the settings as they are, otherwise its own version of them.
  const fileFor = (own) => {
    if (file && own === settings) return file;
    scratch ??= mkdtempSync(join(tmpdir(), "seisin-weigh-"));
    const f = join(scratch, `settings-${copies++}.json`);
    writeFileSync(f, JSON.stringify(own, null, 2), { mode: 0o600 });
    return f;
  };
  try {
    const options = list.map((sandbox) => {
      const bin = locate ? sandbox.locate() : "(not looked up)";
      const own = settingsOf(sandbox, settings, { machRegister: register, handoffExempt: exempt, requests });
      const asked = sandbox.asksFile && locate && bin;
      const ctx = { platform, role, bin, file: asked ? fileFor(own) : null };
      const { unmet, warnings } = sandbox.asksFile && !asked ? { unmet: [], warnings: [] }
        : sandbox.assess ? sandbox.assess(own, ctx) : { unmet: sandbox.unmet(own, ctx), warnings: [] };
      // `browsers`: a Mach service to register. srt's schema has no field for it
      // (srt-mach.mjs adds it); tartaros takes it as network.allowMachRegister
      // (adapt). A sandbox that is given it neither way cannot hold the role.
      // `inject`: the real value is in the environment the sandbox starts with,
      // so only one that masks credentials may be handed the role.
      const masked = (own.credentials?.envVars ?? []).length > 0;
      const masking = masked ? (sandbox.masks ? sandbox.masks(platform) : `masked credentials: ${sandbox.name} does not mask them`) : null;
      const browser = register.length && !sandbox.machRegister
        ? [`a Mach service to register (${register.join(", ")}, for browsers): ${sandbox.name} is not given it, only srt and tartaros are`]
        : [];
      // `handoff_exempt`: a folder where trust-handoff is not protected. Only a
      // sandbox that opens exactly that is handed the role; srt protects its
      // own surfaces with no way to exempt a subtree.
      const exemption = exempt.length && !sandbox.handoffExempt
        ? [`handoff_exempt (${config.roles[role].handoffExempt.join(", ")}): ${sandbox.name} cannot leave a folder out of its trust-handoff protection, tartaros can`]
        : [];
      // `requests`: methods and paths per host. srt takes them only as a library
      // callback, so seisin cannot hand them to it.
      const ruled = requests.length && !sandbox.requestRules
        ? [`requests (${requests.map((q) => q.host).join(", ")}): ${sandbox.name} cannot limit the methods and paths of a host from its settings, tartaros can`]
        : [];
      // `control_files`: a family the policy hands a role that this sandbox
      // protects whatever the settings say (tartaros's trust-handoff set holds
      // `.vscode` at any depth), so the role could not do what it was given.
      const families = role ? (config.roles?.[role]?.controlFiles ?? []) : [];
      const kept = families.filter((f) => (sandbox.keepsControlFiles ?? []).includes(f));
      const control = kept.length
        ? [`control_files (${kept.join(", ")}): ${sandbox.name} protects those files at any depth whatever the policy says, so the role could not edit them`]
        : [];
      return { sandbox, bin, unmet: [...(masking ? [masking] : []), ...unmet, ...browser, ...exemption, ...ruled, ...control], warnings, missing: bin ? null : sandbox.missing() };
    });
    const chosen = options.find((o) => o.bin && o.unmet.length === 0) ?? null;
    return { chosen, options };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The settings as this sandbox is handed them: as generated, or with what it
 * takes in its own field (tartaros: network.allowMachRegister). The same
 * object when nothing changes, so a caller can tell.
 */
export function settingsOf(sandbox, settings, ctx) {
  return sandbox.adapt ? sandbox.adapt(settings, ctx) : settings;
}

/** The sandbox and binary for one run, or an Error that says why each was passed over. */
export function chooseSandbox(config, settings, { platform = process.platform, role = null, file = null } = {}) {
  const { chosen, options } = weigh(config, settings, { platform, role, file });
  if (chosen) return { sandbox: chosen.sandbox, bin: chosen.bin, options };
  // The one sandbox there is, missing: said exactly as it always was.
  if (options.length === 1 && options[0].missing)
    return { error: new Error(options[0].missing), options };
  return { error: new Error(refusal(role, options)), options };
}

export function refusal(role, options) {
  const lines = options.map((o) => o.missing
    ? `  - ${o.sandbox.name}: ${o.missing}`
    : `  - ${o.sandbox.name} cannot enforce all of it:\n${o.unmet.map((u) => `      ${u}`).join("\n")}`);
  return `no sandbox in [sandbox] provider can hold ${role ? `role ${role}` : "this role"} as its policy is written, so it was not started:\n` +
    `${lines.join("\n")}\n` +
    `  A sandbox that enforces less than the policy is never used in its place. Install one that can ` +
    `(srt: npm install -g ${SRT_PACKAGE}@${SRT_VERSION}), name it in [sandbox] provider, or change the role.`;
}
