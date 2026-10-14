/**
 * A sandbox declared in seisin.toml: a command with a placeholder.
 *
 *   [sandbox.providers.mybox]
 *   command = ["mybox", "run", "--policy", "{policy}", "--"]
 *
 * The same shape as a key provider (keys.js), for the same reason: adding a
 * sandbox is three lines of TOML and no code. seisin replaces `{policy}` with
 * the path of the run's settings file and appends the command to run. The
 * contract the provider takes on is in docs/sandboxes.md; the short form:
 *
 *   - the file is the settings seisin generates, in sandbox-runtime's schema;
 *   - the provider enforces every field of it, or exits non-zero before
 *     running anything — it never runs the command with less;
 *   - it passes the command's exit status through.
 *
 * seisin cannot see inside a provider, so it asks: with a `check` command
 *
 *   check = ["mybox", "check", "--policy", "{policy}"]
 *
 * the provider says before anything runs whether it can hold a policy (exit 0)
 * or not (anything else, the last line it prints saying why), and one that
 * cannot is passed over like a built-in one. Without `check` there is nothing
 * to ask, and `unmet` has nothing to say.
 *
 * Neither answer is taken on faith: every run starts with the canary
 * (canary.js) under the same provider and the same file, and the agent starts
 * only if the boundary held. A provider that ignores the file fails there.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, delimiter, isAbsolute, basename } from "node:path";

export const POLICY_PLACEHOLDER = "{policy}";

function onPath(name, path = process.env.PATH) {
  if (name.includes("/")) return isAbsolute(name) && existsSync(name) ? name : null;
  for (const dir of (path ?? "").split(delimiter)) if (dir && existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/** Long enough for a sandbox to read a file and say no; short enough that a hung one is found out. */
const CHECK_TIMEOUT_MS = 15000;

const withPolicy = (args, file) => args.map((a) => a.split(POLICY_PLACEHOLDER).join(file));

/**
 * Runs a sandbox's own pre-check on the settings file.
 *
 * `unmet` is `[]` when it answered yes; otherwise one sentence, its own reason
 * when it gave one. A check that cannot answer (not found, killed, timed out)
 * is a no: an answer that never came is not a pass. `warnings` are the lines
 * it printed that start with `warning:`, yes or no — what it holds, but not the
 * way the role might expect (tartaros on Linux, a repo root it cannot let the
 * role create entries in) — for `seisin check` to show.
 */
export function assessCheck(argv, file, label) {
  const r = spawnSync(argv[0], withPolicy(argv.slice(1), file), { encoding: "utf8", timeout: CHECK_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  // Its own name off the front: "mybox: no domains" reads twice after "mybox says".
  // stdout before stderr, so a report on stdout does not bury a refusal on stderr.
  const self = `${basename(argv[0])}:`;
  const said = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => (l.startsWith(self) ? l.slice(self.length).trim() : l));
  const warnings = said.filter((l) => /^warning:/i.test(l)).map((l) => l.replace(/^warning:\s*/i, ""));
  if (r.status === 0) return { unmet: [], warnings };
  // The last line: what comes before it can be warnings about what it did hold
  // (tartaros says which patterns its own set covers), and the no comes last.
  const why = r.error?.code === "ETIMEDOUT" ? `it did not answer in ${CHECK_TIMEOUT_MS / 1000} s`
    : r.error ? r.error.message
    : said.length ? said.at(-1)
    : r.signal ? `it was killed by ${r.signal}` : `it exited ${r.status} without saying why`;
  return { unmet: [`${label} says it cannot hold this policy: ${why}`], warnings };
}

/** Only the answer: `[]` for yes, the reason for no. */
export const askCheck = (argv, file, label) => assessCheck(argv, file, label).unmet;

export function commandSandbox(name, command, check = null, { tagsDenials = false } = {}) {
  const assess = (_settings, { file } = {}) => (check ? assessCheck(check, file, `its check (${check[0]})`) : { unmet: [], warnings: [] });
  return {
    name,
    locate: () => onPath(command[0]),
    missing: () => `${command[0]} (the command of [sandbox.providers.${name}]) was not found${command[0].includes("/") ? "" : " on PATH"}.`,
    asksFile: Boolean(check),
    assess,
    unmet: (settings, ctx) => assess(settings, ctx).unmet,
    wrap: (bin, file, _settings, inner) => [bin, ...withPolicy(command.slice(1), file), ...inner],
    // Declared, not detected: `tags_denials = true` says its Seatbelt denials
    // carry sandbox-runtime's tag (docs/sandboxes.md). Without it, on macOS,
    // none of the kernel's refusals under it reach the log.
    tagsDenials,
  };
}
