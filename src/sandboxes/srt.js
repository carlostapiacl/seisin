/**
 * `srt`: @anthropic-ai/sandbox-runtime, the sandbox seisin was built on.
 *
 * The default, and the reference every other provider is measured against:
 * the settings seisin generates (srt.js, one level up) ARE this runtime's
 * settings file, so it enforces all of them by construction and `unmet` is
 * always empty. What a run hands it is the file and the command, nothing else.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The runtime seisin depends on first, one on PATH second, and nothing third.
 *
 * "The one seisin depends on" is found the way Node finds a dependency — up
 * from this file, through every `node_modules` — not at one spelled-out path.
 * `<seisin>/node_modules/.bin/srt` is only where it lands in a checkout. In a
 * project that installs seisin as a dependency, npm hoists the runtime to the
 * project's own `node_modules`, and that path does not exist. Measured with
 * 0.5.0 packed and installed into a project: `npx seisin` still worked, because
 * npx puts the project's `.bin` on PATH; `./node_modules/.bin/seisin` and
 * `node node_modules/seisin/src/cli.js` did not — they said "not found", or,
 * with a global srt 0.0.75 installed, ran under THAT one instead of the 0.0.78
 * this version pins, with none of its fixes.
 *
 * There is deliberately no fallback to running unsandboxed. A permission tool
 * that quietly becomes a no-op when its enforcer is missing is worse than one
 * that refuses, because you keep trusting it.
 */
export function resolveSrt({ from = HERE, path = process.env.PATH } = {}) {
  const local = dependencySrt(from);
  if (local) return local;

  // Walk PATH rather than asking a shell. `spawnSync(..., { shell: true })`
  // prints a deprecation warning on every single run — Node's DEP0190 — which
  // is a line of noise in front of every user for the sake of finding one file.
  // It is also the concatenation hazard the warning is about.
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "srt");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const RUNTIME = "@anthropic-ai/sandbox-runtime";

/**
 * The `srt` of the sandbox-runtime that resolves from `from`, or null.
 *
 * The `.bin/srt` npm linked beside the package when there is one — that is the
 * file npm made executable — and otherwise the package's own `bin` entry.
 * The package's `package.json` is found by walking up rather than through
 * `require.resolve`, which a package's `exports` map is free to refuse.
 */
export function dependencySrt(from = HERE) {
  let dir = from;
  for (;;) {
    const nm = join(dir, "node_modules");
    const pkg = join(nm, RUNTIME, "package.json");
    if (existsSync(pkg)) {
      const linked = join(nm, ".bin", "srt");
      if (existsSync(linked)) return linked;
      try {
        const bin = JSON.parse(readFileSync(pkg, "utf8")).bin;
        const rel = typeof bin === "string" ? bin : bin?.srt;
        if (rel) {
          const target = join(nm, RUNTIME, rel);
          if (existsSync(target)) return target;
        }
      } catch { /* an unreadable package.json is not a runtime */ }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The directory of the runtime's own `apply-seccomp`, or null.
 *
 * On Linux the runtime runs that binary INSIDE the sandbox, from wherever the
 * package is installed, before the command. With `read = "territory"` a home
 * directory is shut, and seisin installed under it — nvm, a user npm prefix,
 * a CI checkout in /home/runner — left the binary unmountable: every run died
 * with `apply-seccomp: No such file or directory` before the canary (measured
 * on ubuntu-latest and in Debian with the checkout in /root, srt 0.0.81).
 * Found from the srt that runs (its real path, up to the package), so a
 * global srt keeps its own.
 */
export function seccompDir(bin = resolveSrt()) {
  if (!bin) return null;
  let dir;
  try { dir = dirname(realpathSync(bin)); } catch { return null; }
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, "utf8")).name === RUNTIME) {
          const vendor = join(dir, "vendor", "seccomp");
          return existsSync(vendor) ? vendor : null;
        }
      } catch { /* not the runtime's */ }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * How to put the runtime back, for the way this seisin was installed.
 *
 * It is a dependency, so it is missing only from a broken install — and the
 * fix differs: a project's own node_modules, a global install, or a checkout.
 * `npm i -g` was suggested to everyone, which for a project-local seisin
 * installs a second runtime somewhere seisin does not look first.
 */
export function installHint(from = HERE) {
  const at = from.split("/node_modules/seisin/")[0];
  if (at === from) return `Install it in this checkout with: npm install (in ${dirname(dirname(from))})`;
  // npm's global layout is <prefix>/lib/node_modules on unix, …/npm/node_modules on Windows.
  if (/\/lib$/.test(at) || /[\\/]npm$/.test(at))
    return "seisin is installed globally; reinstall it with: npm install -g seisin";
  return `seisin is installed in ${at}; reinstall it there with: npm install seisin`;
}

const MACH_PRELOAD = join(HERE, "srt-mach.mjs");

/**
 * srt with srt-mach.mjs loaded into it, for a role whose browsers register a
 * Mach service. Run by this node, so the preload is in the process: the runtime
 * is a node script, and one that is not (a binary on PATH) cannot take it —
 * refused here rather than run without the rule the role asked for, which
 * would start the browser just to watch it die.
 */
export function withMachPreload(bin, file, inner) {
  const cli = realpathSync(bin);
  if (!/\.(c|m)?js$/.test(cli))
    throw new Error(`the sandbox runtime at ${bin} is not a node script, so the browser's Mach rule cannot be added to it ` +
      `(browsers in seisin.toml). Use the runtime seisin installs with it.`);
  return [process.execPath, "--import", MACH_PRELOAD, cli, "--settings", file, "--", ...inner];
}

export const srt = {
  name: "srt",
  locate: () => resolveSrt(),
  missing: () => `sandbox runtime not found. ${installHint()}`,
  unmet: () => [],
  // `--` before the command, and it is not cosmetic. Without it the runtime's
  // own argument parser reaches into what the agent was invoked with and eats
  // anything resembling one of its flags: `claude --settings`, `claude -c`.
  wrap: (bin, file, _settings, inner, { machRegister = [] } = {}) =>
    machRegister.length ? withMachPreload(bin, file, inner) : [bin, "--settings", file, "--", ...inner],
  // Takes the `browsers` Mach rule, through srt-mach.mjs.
  machRegister: true,
  // Each Seatbelt denial carries this runtime's tag with the wrapped command,
  // which is how violations.js tells this run's denials from another's.
  tagsDenials: true,
};
