/**
 * `tartaros`: the Seatbelt / Landlock sandbox, driven by its own CLI.
 *
 * tartaros reads seisin's settings file itself (`--settings`, the schema of
 * sandbox-runtime) and holds itself to the contract in docs/sandboxes.md:
 * every field enforced, or it refuses to start. So seisin does not translate
 * anything and does not keep its own list of what tartaros can do — a list
 * like that is out of date the day tartaros learns something. It asks:
 *
 *   tartaros explain --settings <file>
 *
 * reads the same file through the same code as `run` and exits 78, with the
 * reason, on a field it cannot guarantee (2 before 0.1.0-alpha.6, which keeps
 * 2 for a bad command line). seisin takes any exit but 0 as that no, so the
 * code is not read. That answer is what `unmet` returns,
 * so a role tartaros cannot hold is passed over before it starts (or `seisin
 * check` says so), and the canary still checks every run that it can.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { assessCheck } from "./command.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TARTAROS_PACKAGE = "@carlostapiacl/tartaros";

/**
 * The tartaros seisin depends on first, one on PATH second, and nothing third:
 * the order srt is found in (srt.js), for the same reason. A tartaros built
 * once and left on PATH goes on answering after the pinned one has its fixes.
 *
 * The pinned one is an optional dependency: a package per platform with the
 * binary in it, and a main package whose binaryPath() finds that one whether
 * npm nested it under the main package (a global install, measured) or hoisted
 * it. An install that left it out (`--omit=optional`, a platform without a
 * binary) falls through to PATH.
 */
export function resolveTartaros({ from = HERE, path = process.env.PATH } = {}) {
  const pinned = dependencyTartaros(from);
  if (pinned) return pinned;
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "tartaros");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The binary of the tartaros package that resolves from `from`, or null. */
export function dependencyTartaros(from = HERE) {
  try {
    const bin = createRequire(join(from, "noop.js"))(TARTAROS_PACKAGE).binaryPath();
    return bin && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** The command line for one run: the settings as they are, the role as a label. */
/** Whether this tartaros takes `--egress-log` (0.1.0-alpha.18): asked once per binary. */
const egressLog = new Map();
export function supportsEgressLog(bin) {
  if (!egressLog.has(bin)) {
    const r = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5000 });
    egressLog.set(bin, `${r.stdout ?? ""}${r.stderr ?? ""}`.includes("--egress-log"));
  }
  return egressLog.get(bin);
}

export function tartarosArgv(bin, file, inner, { role = null, machRegister = [], log = null } = {}) {
  // A browser role gets tartaros's browser grants — the shared memory, IOKit
  // classes and sysctls a headless Chromium dies without (f7edae1) — and a
  // run-private TMPDIR, the only place it may open a unix socket (bcb0c69):
  // where @playwright/mcp publishes its browser.
  const browser = machRegister.length ? ["--browser", "--private-tmp"] : [];
  // --inherit-env: the environment seisin hands tartaros is already the one
  // the role gets — built from the role's own list (env.js), with the hook's
  // socket, the role's name and its env-mode keys. tartaros's own scrub
  // (7f9925f) would drop those, and the hook would go silent.
  // --egress-log: tartaros's record of its egress broker's decisions, read back
  // into seisin's log at the end of the run (commands/run.js, brokerDenials).
  // Not --log, which also starts the effect collectors (more than a second a
  // run, measured). A tartaros older than the flag gets nothing: an unknown
  // option would refuse the run.
  const record = log && supportsEgressLog(bin) ? ["--egress-log", log] : [];
  return [bin, "run", ...(role ? ["--role", role] : []), "--inherit-env", ...browser, ...record, "--settings", file, "--", ...inner];
}

/** What tartaros says of this file: what it cannot hold, and its warnings. Only asked of a binary that was found. */
export function tartarosAssess(bin, file, { platform = process.platform } = {}) {
  if (platform !== "darwin" && platform !== "linux") return { unmet: [`tartaros runs on macOS and Linux, not ${platform}`], warnings: [] };
  return assessCheck([bin, "explain", "--settings", "{policy}"], file, "tartaros");
}

export const tartarosUnmet = (bin, file, ctx) => tartarosAssess(bin, file, ctx).unmet;

/**
 * `browsers`: tartaros takes the Mach names to register in its settings, as
 * network.allowMachRegister with sandbox-runtime's trailing `*` for a prefix
 * (tartaros 99b0117). Only when there is one: an unchanged role is handed the
 * same file as before, and srt, whose schema is strict, never sees the field.
 */
export function tartarosSettings(settings, { machRegister = [], handoffExempt = [] } = {}) {
  if (!machRegister.length && !handoffExempt.length) return settings;
  let out = settings;
  if (machRegister.length) out = { ...out, network: { ...out.network, allowMachRegister: machRegister.map((p) => `${p}*`) } };
  // tartaros's own field (its --handoff-exempt), absolute: srt never sees it.
  if (handoffExempt.length) out = { ...out, filesystem: { ...out.filesystem, handoffExempt } };
  return out;
}

export const tartaros = {
  name: "tartaros",
  locate: () => resolveTartaros(),
  missing: () => `tartaros not found: neither ${TARTAROS_PACKAGE}, which installs with seisin unless optional dependencies are left out, nor tartaros on PATH.`,
  asksFile: true,
  // Masked credentials: tartaros says whether it masks them, through explain
  // (0.1.0-alpha.16 and later do; earlier ones refuse the field).
  masks: () => null,
  adapt: tartarosSettings,
  machRegister: true,
  // Takes filesystem.handoffExempt (tartaros 0.1.0-alpha.18): a folder left out of
  // its trust-handoff protection.
  handoffExempt: true,
  assess: (_settings, { bin, file, platform } = {}) => tartarosAssess(bin, file, { platform }),
  unmet: (_settings, { bin, file, platform } = {}) => tartarosUnmet(bin, file, { platform }),
  wrap: (bin, file, _settings, inner, ctx) => tartarosArgv(bin, file, inner, ctx),
  // Every deny in its Seatbelt profile carries sandbox-runtime's tag
  // (`CMD64_<command>_END_<suffix>_SBX`), so violations.js attributes them
  // exactly as it does srt's. Measured 2026-10-13 with tartaros ad85515.
  tagsDenials: true,
};
