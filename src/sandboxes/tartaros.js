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
import { join, delimiter } from "node:path";
import { assessCheck } from "./command.js";

/** `tartaros` on PATH, or null. */
export function resolveTartaros(path = process.env.PATH) {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "tartaros");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The command line for one run: the settings as they are, the role as a label. */
export function tartarosArgv(bin, file, inner, { role = null, machRegister = [] } = {}) {
  // A browser role gets tartaros's browser grants — the shared memory, IOKit
  // classes and sysctls a headless Chromium dies without (f7edae1) — and a
  // run-private TMPDIR, the only place it may open a unix socket (bcb0c69):
  // where @playwright/mcp publishes its browser.
  const browser = machRegister.length ? ["--browser", "--private-tmp"] : [];
  // --inherit-env: the environment seisin hands tartaros is already the one
  // the role gets — built from the role's own list (env.js), with the hook's
  // socket, the role's name and its env-mode keys. tartaros's own scrub
  // (7f9925f) would drop those, and the hook would go silent.
  return [bin, "run", ...(role ? ["--role", role] : []), "--inherit-env", ...browser, "--settings", file, "--", ...inner];
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
export function tartarosSettings(settings, { machRegister = [] } = {}) {
  if (!machRegister.length) return settings;
  return { ...settings, network: { ...settings.network, allowMachRegister: machRegister.map((p) => `${p}*`) } };
}

export const tartaros = {
  name: "tartaros",
  locate: () => resolveTartaros(),
  missing: () => "tartaros not found on PATH. Build it (cargo build --release -p tartaros-cli) and put its target directory on PATH.",
  asksFile: true,
  adapt: tartarosSettings,
  machRegister: true,
  assess: (_settings, { bin, file, platform } = {}) => tartarosAssess(bin, file, { platform }),
  unmet: (_settings, { bin, file, platform } = {}) => tartarosUnmet(bin, file, { platform }),
  wrap: (bin, file, _settings, inner, ctx) => tartarosArgv(bin, file, inner, ctx),
  // Every deny in its Seatbelt profile carries sandbox-runtime's tag
  // (`CMD64_<command>_END_<suffix>_SBX`), so violations.js attributes them
  // exactly as it does srt's. Measured 2026-10-13 with tartaros ad85515.
  tagsDenials: true,
};
