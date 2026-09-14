/**
 * Who owns a path.
 *
 * This is the part no other agent-permission tool has, and it is why seisin
 * exists. Every hook and sandbox in this space answers yes or no. Answering
 * "no, and it belongs to `frontend`" turns a block into a handoff: the agent
 * knows who to ask, and so do you when you read the log.
 *
 * Owning means being allowed to WRITE it. Reads are not partitioned by owner —
 * agents have to read each other's code to do anything useful. Keys are the
 * exception, and they are handled separately below.
 */

/**
 * Does this glob cover this path? Supports `**`, `*`, `?` and a trailing `/`.
 *
 * A wildcard-free pattern is a **prefix**, because that is what the kernel is
 * given. `toWritePath` in srt.js hands `src/api` to `allowWrite` unchanged, and
 * a sandbox grants a path and everything under it — so `src/api`, `src/api/`
 * and `src/api/**` are one grant to the OS, and reading the first of them as
 * "that path only" made seisin describe a boundary that was not there.
 *
 * Measured against the real kernel, not reasoned about. With
 * `writes = ["src/api"]`:
 *
 *     seisin explain dev write src/api/x.ts   ->  denied, "has no owner"
 *     seisin run dev -- sh -c 'echo > src/api/x.ts'  ->  the file is written
 *
 * That is the document being tighter than the boundary, which
 * [decisions.md](../docs/decisions.md) names as the one direction this must
 * never fail in — and it is worse than the `src/*` case already recorded there,
 * because nothing looked wrong: `whose` reported the path as unowned while a
 * role could write it, so a reader was told it was protected.
 *
 * Refusing is not the answer here the way it was for `src/*`. "One level down"
 * has no exact translation and had to be refused; a subtree has one, and the
 * kernel is already enforcing it. What was missing was seisin saying so.
 */
export function covers(glob, path) {
  const p = normalize(path);
  let g = normalize(glob);
  if (glob.endsWith("/")) g += "/**";
  // The path itself, or anything beneath it. The `/` is load-bearing: without
  // it `src/api` would also cover `src/apifoo.ts`, which the kernel does not.
  if (!WILD.test(g)) return p === g || p.startsWith(g + "/");
  return toRegExp(g).test(p);
}

/** The four characters toRegExp() treats as wildcards. */
const WILD = /[*?[\]]/;

/**
 * One spelling per file, before anybody decides anything about it.
 *
 * `..` is the reason this is more than tidying. `src/web/../api/orders.ts` is
 * backend's file, and the unresolved form let it match frontend's `src/web/**`
 * — so `whose` named the wrong owner, the hook raised no request, and the log
 * recorded `allowed` for a write the kernel then refused. The boundary held;
 * every sentence seisin said about it was wrong, which is the half of the tool
 * that is actually ours.
 *
 * A path that climbs above the repo root comes back as `..`, which owns
 * nothing and matches nothing. Outside the repo has no owner by definition.
 */
export function normalize(s) {
  const flat = s.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
  const up = [];
  for (const part of flat.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && up.length && up[up.length - 1] !== "..") { up.pop(); continue; }
    up.push(part);
  }
  return up.join("/");
}

/**
 * Glob to RegExp.
 *
 * The wildcards are parked on sentinels before `*` is expanded, because
 * expanding `**` first produces a `.*` whose own `*` the next pass would
 * rewrite again. Getting that order wrong is silent: the regex still compiles
 * and quietly matches the wrong set of files.
 *
 * `src/api/**` also matches `src/api` itself. Without that, the directory a
 * role was just granted comes back ownerless, which reads as a bug every time.
 *
 * Dotfiles are matched like any other name: `*.env` covers `.env`. Shell globs
 * hide them by default, and most glob libraries copy that. A permission tool
 * must not: covering one file too many costs an argument, covering one too few
 * is the hole. When the two readings disagree, this one takes the wider set.
 */
function toRegExp(glob) {
  const out = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*$/, "\u0001")
    .replace(/\*\*\//g, "\u0002")
    .replace(/\*\*/g, "\u0003")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:/.*)?")
    .replace(/\u0002/g, "(?:.*/)?")
    .replace(/\u0003/g, ".*");
  return new RegExp("^" + out + "$");
}

/** Every role whose territory covers `path`. Usually one; zero is a finding. */
export function ownersOf(config, path) {
  return Object.values(config.roles)
    .filter((r) => r.writes.some((g) => covers(g, path)))
    .map((r) => r.name);
}

/** Every role allowed to read `key`, matched with or without its extension. */
export function keyHolders(config, key) {
  const dirs = config.keyDirs ?? [];

  /**
   * Both sides resolved to a path before anything is compared.
   *
   * A declaration without a directory means the first key directory — that is
   * what settingsFor does — and the hook sees whatever path the tool call
   * used. So `database.txt` in the config and `.secrets/database.txt` from a
   * Read are the same file and must match.
   *
   * What must NOT match is `.secrets/api.txt` against `shared/api.txt`. With
   * two key directories those are different files, and comparing basenames
   * made `explain` answer "allowed" for a key the sandbox would refuse. A
   * wrong yes from the layer whose only job is explaining is worse than no
   * answer at all.
   */
  const resolve = (s) => (s.includes("/") ? s : `${dirs[0] ?? "."}/${s}`);
  const bare = (s) => s.replace(/^.*\//, "").replace(/\.[^.]+$/, "");

  const wanted = resolve(key);
  // The extension-less form is how a person asks — `seisin explain f read
  // netlify` — so it stays, and only for an unqualified question.
  const loose = !key.includes("/");

  return Object.values(config.roles)
    .filter((r) => r.keys.some((k) =>
      resolve(k) === wanted || (loose && bare(k) === bare(key))))
    .map((r) => r.name);
}

/**
 * The sentence a blocked agent should read.
 *
 * Three outcomes, and the third is the one worth having: a path nobody owns is
 * not a permission problem, it is a hole in the map. Saying so is more useful
 * than denying quietly, and it is the only way the hole ever gets fixed.
 */
export function explain(config, role, action, target) {
  if (action === "read") {
    const holders = keyHolders(config, target);
    if (holders.includes(role)) return { allowed: true, owners: holders, reason: `${role} declares ${target}` };
    if (holders.length === 0)
      return { allowed: false, owners: [], reason: `no role declares ${target} — add it under a [roles.<name>] keys list` };
    return { allowed: false, owners: holders, reason: `${target} belongs to ${holders.join(", ")}` };
  }

  const owners = ownersOf(config, target);
  if (owners.includes(role)) return { allowed: true, owners, reason: `${target} is inside ${role}'s territory` };
  if (owners.length === 0)
    return { allowed: false, owners: [], reason: `${target} has no owner — no role can write it until one claims it` };
  return { allowed: false, owners, reason: `${target} belongs to ${owners.join(", ")}` };
}
