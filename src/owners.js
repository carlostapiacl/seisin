/**
 * Who owns a path.
 *
 * This is the part no other agent-permission tool has, and it is why keyward
 * exists. Every hook and sandbox in this space answers yes or no. Answering
 * "no, and it belongs to `frontend`" turns a block into a handoff: the agent
 * knows who to ask, and so do you when you read the log.
 *
 * Owning means being allowed to WRITE it. Reads are not partitioned by owner —
 * agents have to read each other's code to do anything useful. Keys are the
 * exception, and they are handled separately below.
 */

/** Does this glob cover this path? Supports `**`, `*`, `?` and a trailing `/`. */
export function covers(glob, path) {
  const p = normalize(path);
  let g = normalize(glob);
  if (glob.endsWith("/")) g += "/**";
  return toRegExp(g).test(p);
}

function normalize(s) {
  return s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
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
  const bare = (s) => s.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
  const want = bare(key);
  return Object.values(config.roles)
    .filter((r) => r.keys.some((k) => k === key || bare(k) === want))
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
