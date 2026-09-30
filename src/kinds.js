/**
 * What kind of thing an unowned refused path is.
 *
 * "Owned by nobody" used to be the whole sentence, and the question a person
 * brings to it is not *whose should this be* but *what do I do with it*. The
 * obvious helper — suggest an owner, the role that asked or the owner of the
 * nearest folder — was measured on one deployment's 317 unowned paths before
 * it was built: it was right about 5% of the time, and in the other 95% it was
 * wrong in the one direction seisin does not accept, it widened. A lock file
 * inside `.git` is a mutex, not territory; a directory a test creates with its
 * PID in the name is the test's bug; a credential is never granted a write.
 * Giving any of those to "whoever asked" hands them a folder that is everybody's.
 *
 * So this names the kind and the move that fits it, and only `territory` — a
 * normal path that nobody claims — is left as the decision it looks like.
 *
 * Read from the path alone, plus one fact about the log (`kindsOf`): the same
 * name made unique per run in several sibling places. No disk, no policy, no
 * clock, so it is the same answer on every screen that asks. It never changes
 * what is allowed; it changes what is said about a refusal.
 */
import { CREDENTIAL_HOMES } from "./grants.js";

/** Every kind, in the order a reader should deal with them, and the one line each says. */
export const KINDS = {
  credential:
    "credential-shaped: never grant a write to it; if a role needs to read it, declare it as a key",
  git:
    "git's own bookkeeping, not territory: grant the repository to the role that runs git there, never the file",
  temporary:
    "scratch a tool or a test makes while it runs: point it at $TMPDIR (already writable through [runtime] writes), or fix it; do not grant it in the repo",
  build:
    "build output or installed dependencies: grant the folder to the role that builds it, or build outside the repo",
  territory:
    "a normal path no role claims: a real decision — give it an owner, or tell the agent not to write there",
};

/** A lock file inside `.git` gets a more precise line than the rest of git's metadata. */
const GIT_LOCK =
  "git taking a lock in a repo this role does not own: `seisin run` sets GIT_OPTIONAL_LOCKS=0 so status and diff stop taking it; a commit or fetch still needs the repository — grant the repository, never the lock";

/**
 * Credential-shaped names.
 *
 * The places `[runtime] isolate` closes in a home directory are the first
 * source (grants.js), by name, because a repository can hold the same files:
 * a `.npmrc` with a token in it is the same secret in either place. `.config`
 * is left out on purpose — it is a container, and inside a repo it is mostly
 * tool settings; `.docker` and `.kube` count only for the file that holds the
 * login (`config`, `config.json`), not for every Dockerfile beside it.
 */
const HOME_NAMES = CREDENTIAL_HOMES.map((h) => h.replace(/^~\//, ""));
const CONTAINERS = new Set([".config", ".docker", ".kube"]);
const SECRET_DIRS = new Set([...HOME_NAMES.filter((n) => !CONTAINERS.has(n) && !/rc$|credentials$/.test(n)), ".secrets", "secrets"]);
const LOGIN_DIRS = new Set([".docker", ".kube"]);
const SECRET_FILES = new Set([...HOME_NAMES.filter((n) => /rc$|credentials$/.test(n)), ".pypirc", ".pgpass", ".htpasswd"]);
const SECRET_EXT = /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg)$/i;
const SSH_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
// `.env`, `.env.local`, `.env.production` — but not the file that exists to be committed.
const DOTENV = /^\.env(\..+)?$/;
const DOTENV_TEMPLATE = /\.(example|sample|template|dist|defaults?)$/i;
/**
 * A token file: the word in the name, and a data extension. The extension is
 * what keeps `src/auth/token.ts` — code about tokens — out of it.
 */
const TOKEN_FILE = /(^|[-_.])(tokens?|secrets?|passwords?|passwd|credentials?|api[-_]?keys?|private[-_]?key)([-_.]|$)/i;
const DATA_EXT = /(^[^.]*$)|\.(txt|json|ya?ml|toml|ini|cfg|conf|env|key)$/i;

/**
 * Scratch. Directories every toolchain uses for caches, and the shapes an
 * atomic write, an editor or a database leaves beside a file for a moment.
 */
const CACHE_DIRS = new Set([
  "tmp", "temp", ".tmp", ".temp", ".cache", "_cache", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".hypothesis", ".tox", ".nox", ".parcel-cache", ".turbo",
  ".eslintcache", ".sass-cache", ".gradle", ".dart_tool",
]);
const SCRATCH_FILE = [
  /\.(tmp|temp|swp|swo|swx|bak|orig|rej|pid|sock|log)$/i,
  /\.tmp[.\-_]/i,                              // `BACKLOG.md.tmp.32029.03c4` — write-then-rename
  /\.py[co](\.\d+)?$/,                         // bytecode, and its own write-then-rename
  /-(wal|shm|journal)$/,                       // sqlite's sidecars, beside a database
  /~$/, /^\.#/, /^#.*#$/,                      // editors
  /^\.!\d+!/,                                  // `.!36165!file` — a copy in flight
  /^\.DS_Store$/,
  /^pytest-cache-files-/,
  /(^|[-_])logs?$/i,                           // `logs`, `latest_logs`: what a run leaves
];
/**
 * `*.lock` is scratch — a mutex a tool takes and drops — except the files that
 * pin dependencies, which are committed and somebody's to edit.
 */
const TOOL_LOCK = /\.lock$/i;
const DEPENDENCY_LOCKS = new Set([
  "yarn.lock", "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock", "flake.lock",
  "Pipfile.lock", "uv.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "bun.lock", "pdm.lock",
]);

/**
 * Build output and installed dependencies. The same names `seisin scan` skips
 * as machinery nobody wrote (scan.js DEFAULT_IGNORE), minus the caches above.
 */
const BUILD_DIRS = new Set([
  "node_modules", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".output", ".angular",
  "vendor", ".venv", "venv", "coverage", "target", "out", ".expo", "bower_components",
]);

const segmentsOf = (p) => String(p).replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");

/**
 * The kind of one path, from the path alone.
 *
 * `keyDirs` are the policy's declared key directories: a path under one is a
 * credential whatever it is called. The order is the safe one — a name that is
 * both a credential and scratch (`.env.tmp`) is said as a credential, since
 * that is the reading that never ends in a grant.
 */
export function kindOf(target, { keyDirs = [] } = {}) {
  const segs = segmentsOf(target);
  const name = segs[segs.length - 1] ?? "";
  const dirs = segs.slice(0, -1);
  const kind = (k, hint = KINDS[k]) => ({ kind: k, hint });

  const flat = segs.join("/");
  const inKeyDir = keyDirs.some((d) => {
    const k = segmentsOf(d).join("/");
    return k && (flat === k || flat.startsWith(k + "/") || flat.includes("/" + k + "/") || flat.endsWith("/" + k));
  });
  if (inKeyDir || dirs.some((d) => SECRET_DIRS.has(d)) || SECRET_FILES.has(name) ||
      SECRET_EXT.test(name) || SSH_KEY.test(name) ||
      (DOTENV.test(name) && !DOTENV_TEMPLATE.test(name)) ||
      (TOKEN_FILE.test(name) && DATA_EXT.test(name)) ||
      (LOGIN_DIRS.has(dirs[dirs.length - 1]) && /^config(\.json)?$/.test(name)))
    return kind("credential");

  const git = segs.indexOf(".git");
  if (git !== -1) return git < segs.length - 1 && /\.lock$/.test(name) ? kind("git", GIT_LOCK) : kind("git");

  if (segs.some((s) => CACHE_DIRS.has(s)) || SCRATCH_FILE.some((re) => re.test(name)) ||
      (TOOL_LOCK.test(name) && !DEPENDENCY_LOCKS.has(name)))
    return kind("temporary");

  if (segs.some((s) => BUILD_DIRS.has(s))) return kind("build");

  return kind("territory");
}

/**
 * A name made unique per run: `pruebas-deuda-57141-2b32ca`, `run_8812`,
 * `out.4419525232`. The stem, and a tail of one or two tokens: the first with a
 * digit, the second with a digit or all hex (`-bfaeec` is a random suffix
 * that happened to draw no digit) — so `report-2026.json` never matches, since
 * an extension is not a run.
 * Only a hint on its own: `run-2026` looks the same as a folder somebody named.
 */
const RUN_UNIQUE = /^(.+?)[-_.](?=[0-9a-z]*\d)([0-9a-z]{3,})([-_.](?:(?=[0-9a-z]*\d)[0-9a-z]{4,}|[0-9a-f]{6,}))?$/i;

/** How many siblings of one stem it takes to call it generated rather than named. */
export const GENERATED_SIBLINGS = 3;

/**
 * The kind of every path in a set, which is what a screen has.
 *
 * One rule needs the set and not the path, and it is the one that mattered
 * most on the log it was measured on: a test that makes a directory with its
 * PID in the name produced 258 of 317 unowned paths, each one different. Alone,
 * `pruebas-deuda-57141-2b32ca` could be a real folder. The same stem with a
 * different run-unique tail in three or more places under one parent is not a
 * folder anybody named — it is a generator, and granting it to whoever asked
 * would hand over the parent. A repeated name is a fact about this log, not a
 * guess about somebody's toolchain, which is why this is here and a list of
 * test runners is not.
 *
 * Returns a Map from each target to `{ kind, hint }`.
 */
export function kindsOf(targets, opts = {}) {
  const out = new Map();
  const stems = new Map();
  for (const t of targets) {
    if (out.has(t)) continue;
    out.set(t, kindOf(t, opts));
    const segs = segmentsOf(t);
    segs.forEach((s, i) => {
      const m = RUN_UNIQUE.exec(s);
      if (!m) return;
      const k = `${segs.slice(0, i).join("/")}\u0000${m[1]}`;
      (stems.get(k) ?? stems.set(k, new Set()).get(k)).add(s);
    });
  }
  const generated = new Set();
  for (const [k, names] of stems) {
    if (names.size < GENERATED_SIBLINGS) continue;
    const parent = k.split("\u0000")[0];
    for (const n of names) generated.add(parent ? `${parent}/${n}` : n);
  }
  if (!generated.size) return out;
  for (const [t, k] of out) {
    if (k.kind !== "territory") continue;
    const segs = segmentsOf(t);
    for (let i = 1; i <= segs.length; i++)
      if (generated.has(segs.slice(0, i).join("/"))) {
        out.set(t, { kind: "temporary", hint: KINDS.temporary });
        break;
      }
  }
  return out;
}
