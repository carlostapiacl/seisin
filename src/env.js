/**
 * The child's environment, built rather than inherited.
 *
 * Measured before this existed: 93 variables crossed into every sandboxed turn,
 * a planted secret among them. `denyRead` protects files, and an environment
 * variable is not a file — so a policy that scoped keys perfectly still handed
 * over every token the parent shell happened to be carrying.
 *
 * So the rule is the same as everywhere else in seisin: nothing is inherited
 * unless it is named. The base list below is what a command needs to be a
 * command at all, and it deliberately contains no credential-shaped names.
 */

/**
 * What survives with no policy at all.
 *
 * Each of these is here because removing it breaks something ordinary, not
 * because it looked harmless: PATH finds the binary, HOME finds the toolchain's
 * config, TMPDIR pairs with the scratch grant, TERM and the locale keep output
 * readable, and the CI/tty pair keeps tools from guessing wrong about the shell.
 */
export const BASE = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "TMPDIR",
  // Set explicitly by `run` in isolated mode, and carried here so a tool that
  // reads them directly lands in the role's own home rather than the real one.
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "TERM", "TERM_PROGRAM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

/**
 * Set for the child whether or not the parent has them.
 *
 * `BASE` is an allowlist: it decides what *crosses*, so a variable the parent
 * never set cannot reach the child through it. These are the ones the sandbox
 * needs **set**, not forwarded.
 *
 * `GIT_OPTIONAL_LOCKS=0` is the whole list, and it is here because of what the
 * denial log looks like without it. Measured on a real portfolio: of the last
 * 60 refusals, **58 were `.git/index.lock`** — 97% — and most carried no owner
 * at all, so not one of them was a territory question. `git status` and
 * `git diff` refresh the index as a courtesy, refreshing it takes the lock, and
 * a role reading a repo it does not own trips the boundary while doing nothing
 * but looking. The human approving those is arbitrating a mutex.
 *
 * Git's own switch turns that courtesy off, and only that. Measured here rather
 * than read from the manual: with the variable set, `status` leaves `.git/index`
 * untouched (same mtime across a forced refresh), while `add`, `commit` and
 * `checkout -b` still take the locks they require and still work — the commit
 * contains the staged file.
 *
 * So this **removes the need for a grant** instead of widening one. The
 * boundary does not move; the noise against it stops. That distinction is the
 * point: the alternative on the table was declaring git's machinery as
 * territory in every role, which is more policy describing less confinement.
 *
 * A role that wants the old behaviour names `GIT_OPTIONAL_LOCKS` in its `env`
 * and sets it in the parent — the loop below then overwrites this.
 */
export const DEFAULTS = { GIT_OPTIONAL_LOCKS: "0" };

/**
 * Names that must never ride along, even if a role asks for them by pattern.
 *
 * A role can name a variable explicitly and get it — that is the point of the
 * `env` list. What this blocks is a wildcard quietly sweeping up a credential,
 * which is how "pass through what the build needs" becomes "pass through
 * everything" three commits later.
 */
const NEVER = /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)(_|$)/i;

/**
 * (env, dropped) — the child's environment, and the names left behind.
 *
 * The second half is not bookkeeping. A tool that silently drops the one
 * variable your build needed is worse to debug than one that never touched the
 * environment, so `seisin run` prints the count and `--debug-env` prints the names.
 */
export function buildEnv(parent, role, extra = []) {
  const wanted = new Set([...BASE, ...extra, ...(role.env ?? [])]);
  // Seeded, not merged afterwards: the loop below must be able to overwrite a
  // default when the role named it and the parent carries it. Merging the other
  // way round would make the opt-out silently do nothing.
  const env = { ...DEFAULTS };
  const dropped = [];

  for (const [name, value] of Object.entries(parent)) {
    if (!wanted.has(name)) { dropped.push(name); continue; }
    if (NEVER.test(name) && !(role.env ?? []).includes(name)) { dropped.push(name); continue; }
    env[name] = value;
  }
  // A role may name a variable the parent does not have. That is not an error —
  // it is a policy written ahead of the environment, which is the right order.
  return { env, dropped: dropped.sort() };
}
