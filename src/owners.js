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
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { protectedBy } from "./surface.js";
import { entriesOf } from "./keys.js";
import { WILD, fromCwd, toRepoRelative } from "./paths.js";

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
  const p = normalized(path);
  const m = matcherOf(glob);
  /**
   * Above the root only for a glob that climbs there itself.
   *
   * `../../etc/passwd` is a path the kernel refuses to every role, and `**`
   * matched it as a string, so `explain` answered "inside territory" for it.
   * A territory reaches outside the repo only by saying so — the
   * `../shared/lab/dev.md` a role writes beside its own directory — and
   * that one still matches, because both sides start with the same `..`.
   */
  if (climbs(p) && !m.climbs) return false;
  // The path itself, or anything beneath it. The `/` is load-bearing: without
  // it `src/api` would also cover `src/apifoo.ts`, which the kernel does not.
  if (m.prefix !== null) return p === m.prefix || p.startsWith(m.prefix + "/");
  // The literal head of the glob, before its first wildcard, has to be the
  // head of the path too. Most pairs fail here, for the price of a
  // startsWith — `check` asks ~400k of them on a real policy.
  if (!p.startsWith(m.head)) return false;
  return matchGlob(m.glob, p);
}

/**
 * The same glob and the same path, prepared once.
 *
 * `covers` is the inner loop of everything that asks "whose is this": owners of
 * a path is every role's every glob against it, and the console asks that for
 * every path of every role. On a real 32-role policy that was ~1.7M calls per
 * refresh, each normalizing the glob again and compiling its regex again — 8 s
 * of a console that polls, measured with a CPU profile (normalize alone 5 s).
 * The answer never changes for the same string, so it is kept. Bounded: a
 * server that runs for days sees paths from the log, and those keep coming.
 */
const MAX_CACHED = 50_000;
const GLOBS = new Map();
const PATHS = new Map();

function matcherOf(glob) {
  let m = GLOBS.get(glob);
  if (m) return m;
  let g = normalize(glob);
  if (glob.endsWith("/")) g += "/**";
  const wild = WILD.test(g);
  m = { prefix: wild ? null : g, glob: wild ? g : null, climbs: climbs(g), head: wild ? headOf(g) : "" };
  if (GLOBS.size >= MAX_CACHED) GLOBS.clear();
  GLOBS.set(glob, m);
  return m;
}

function normalized(path) {
  let p = PATHS.get(path);
  if (p !== undefined) return p;
  p = normalize(path);
  if (PATHS.size >= MAX_CACHED) PATHS.clear();
  PATHS.set(path, p);
  return p;
}

/**
 * What every path a glob matches starts with: its text up to the first
 * wildcard, minus a final `/` — `src/api/**` matches `src/api` itself, and
 * `a/**\/b` matches `a/b`.
 */
const headOf = (g) => g.slice(0, g.search(WILD)).replace(/\/$/, "");

/** Does a normalised path start above the repo root? */
const climbs = (p) => p === ".." || p.startsWith("../");

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
 * A path that climbs above the repo root keeps its leading `..` segments
 * (`src/../../x` is `../x`). `covers` matches such a path only against a glob
 * that climbs out too, so outside the repo has no owner unless a territory
 * names that place explicitly.
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

/** matchGlob's memo, shared between calls (see there). */
let MEMO = new Uint8Array(4096);

/**
 * Does `glob` cover `path`? A linear matcher, not a regular expression.
 *
 * The regex form (`**` → `.*`, `**\/` → `(?:.*\/)?`) put several unbounded `.*`
 * next to literals, and on a long path that does not match, the engine
 * backtracks catastrophically: measured on a crafted glob, 9 `**` took ~26 s
 * and 11 hung for over a minute. Since a request's target — which an agent
 * chooses — becomes a glob here (`grantFor`), that is a denial-of-service on the
 * hook and on `explain`. This matcher is memoised on (glob index, path index),
 * so its cost is bounded by their product and no input backtracks.
 *
 * Same wildcards as before: `?` one non-`/`, `*` a run of non-`/`, `**` any run
 * including `/`, `**\/` zero or more whole directories, a trailing `/**` the
 * subtree. Characters are compared literally; nothing is treated as regex.
 *
 * `src/api/**` also matches `src/api` itself. Without that, the directory a
 * role was just granted comes back ownerless, which reads as a bug every time.
 *
 * Dotfiles are matched like any other name: `*.env` covers `.env`. Shell globs
 * hide them by default, and most glob libraries copy that. A permission tool
 * must not: covering one file too many costs an argument, covering one too few
 * is the hole. When the two readings disagree, this one takes the wider set.
 */
function matchGlob(glob, path) {
  const G = glob.length, P = path.length;
  // memo[gi * (P+1) + pi]: 0 unknown, 1 true, 2 false. One flat array, kept
  // between calls and cleared over the part this call uses: allocating it
  // fresh was most of the cost of a call that fails on its second character.
  // Nothing re-enters matchGlob while it runs, so sharing it is safe.
  // An outsized pair gets its own array, so one long path does not pin
  // megabytes for the life of a server.
  const size = (G + 1) * (P + 1);
  let memo;
  if (size > 1 << 20) memo = new Uint8Array(size);
  else {
    if (MEMO.length < size) MEMO = new Uint8Array(Math.max(size, MEMO.length * 2));
    memo = MEMO;
    memo.fill(0, 0, size);
  }
  const at = (gi, pi) => {
    for (;;) {
      const key = gi * (P + 1) + pi;
      const seen = memo[key];
      if (seen) return seen === 1;
      let res;
      if (gi === G) { res = pi === P; }
      else if (glob[gi] === "*" && glob[gi + 1] === "*") {
        if (glob[gi + 2] === "/") {
          // `**/` = zero or more whole directories: empty, or any chars ending
          // at a `/` then the rest.
          if (at(gi + 3, pi)) res = true;
          else if (pi < P) {
            if (path[pi] === "/" && at(gi + 3, pi + 1)) res = true;
            else { memo[key] = 2; pi++; continue; }   // consume one char, stay on `**/`
          } else res = false;
        } else {
          // `**` = any run including `/` (also covers `**` at the very end,
          // where `at(gi+2, pi)` requires pi to reach the end).
          if (at(gi + 2, pi)) res = true;
          else if (pi < P) { memo[key] = 2; pi++; continue; }  // consume one char, stay on `**`
          else res = false;
        }
      } else if (glob[gi] === "/" && glob[gi + 1] === "*" && glob[gi + 2] === "*" && gi + 3 === G) {
        // trailing `/**`: the directory itself, or anything beneath it.
        res = pi === P || path[pi] === "/";
      } else if (glob[gi] === "*") {
        // `*` = a run of non-`/`.
        if (at(gi + 1, pi)) res = true;
        else if (pi < P && path[pi] !== "/") { memo[key] = 2; pi++; continue; }
        else res = false;
      } else if (glob[gi] === "?") {
        res = pi < P && path[pi] !== "/" && at(gi + 1, pi + 1);
      } else {
        res = pi < P && glob[gi] === path[pi] && at(gi + 1, pi + 1);
      }
      memo[key] = res ? 1 : 2;
      return res;
    }
  };
  return at(0, 0);
}

/** Is this path inside a `.git` directory (git's metadata, not a working file)? */
export function isGitMetadata(path) {
  return /(^|\/)\.git\//.test(normalize(path));
}

/** Every role whose territory covers `path`. Usually one; zero is a finding. */
export function ownersOf(config, path) {
  /**
   * An absolute path is outside the repo, or it is made relative first.
   *
   * The kernel reports paths as it meets them, and toRepoRelative leaves the
   * ones outside the repo absolute on purpose. They then met `writes = ["**"]`,
   * which matches any string, so a refused write to ~/.claude/plugins was
   * logged as "owned by dev, wide" — two roles that own nothing outside the
   * repo. Measured on the first run of Claude Code under the new denies.
   */
  if (path.startsWith("/")) {
    const root = config.root?.endsWith("/") ? config.root : `${config.root}/`;
    if (!config.root || !path.startsWith(root)) return [];
    path = path.slice(root.length);
  }
  return Object.values(config.roles)
    .filter((r) => r.writes.some((g) => covers(g, path)) && !neverWrites(r, path, config))
    .map((r) => r.name);
}

/**
 * Where a refused target stands against the policy as it is now.
 *
 * One of four, and only the last one is a decision somebody has to make:
 *
 *   outside    not a place in the map at all — a port, a key directory, or a
 *              path outside the repository, which no `writes` reaches
 *   protected  closed to every role on purpose (surface.js); the boundary
 *              working, with nothing to grant
 *   owned      some role's territory today
 *   unowned    in the repository, ownable, and nobody claims it
 *
 * Computed from the policy, never from the `owners` a log line carries. That
 * value is what was true the day of the refusal; every grant made since makes
 * it more wrong, so a screen reading it gets worse the more seisin is used the
 * way it is meant to be. Measured on one deployment: the console said 1,178 of
 * 1,486 refused paths had no owner; against the policy of that day it was 316.
 * The rest had been claimed since, were protected, or were not paths at all.
 */
export function standing(config, entry) {
  const target = entry.target;
  if (entry.kind === "network")
    return { kind: "outside", owners: [], why: "a port or a socket, which no role owns" };
  if (entry.kind === "key")
    return { kind: "outside", owners: [], why: "a key directory, closed on purpose" };
  const guard = protectedBy(config, target);
  // A family the policy hands to a role is protected from everybody else and
  // owned by that role — if it is also that role's territory.
  if (guard?.family) {
    const holders = ownersOf(config, target).filter((o) => config.roles[o]?.controlFiles?.includes(guard.family));
    if (holders.length) return { kind: "owned", owners: holders };
  }
  if (guard) return { kind: "protected", owners: [], why: guard.why };
  if (target.startsWith("/")) {
    const root = config.root?.endsWith("/") ? config.root : `${config.root}/`;
    if (!config.root || !target.startsWith(root))
      return { kind: "outside", owners: [], why: "outside the repository, where no role's territory reaches" };
  }
  const owners = ownersOf(config, target);
  return { kind: owners.length ? "owned" : "unowned", owners };
}

/**
 * `standing`, remembered while the policy stays the same.
 *
 * The console asks for its whole state every two seconds, and a real log has
 * well over a thousand distinct refused paths: classifying all of them costs
 * most of a second each time (measured: ~400 ms in protectedBy, ~335 ms in
 * ownersOf), on a call that already took about that long. What a path's
 * standing depends on is the policy file, so that is the key. It also depends,
 * a little, on the disk — on Linux a control file is protected only once it
 * exists — so the memory is dropped after a minute as well, which bounds how
 * stale an answer can be without paying for it on every poll.
 *
 * A config that was not read from a file (tests, embedders) gets a memory for
 * this call only.
 */
const STANDING_TTL = 60_000;
let standingMemo = { key: null, at: 0, map: new Map() };

export function standingOf(config, { now = Date.now() } = {}) {
  let map;
  let key = null;
  try {
    if (config.path) key = `${config.path}\u0000${createHash("sha256").update(readFileSync(config.path)).digest("hex")}`;
  } catch {
    key = null;
  }
  if (key === null) map = new Map();
  else {
    if (standingMemo.key !== key || now - standingMemo.at > STANDING_TTL)
      standingMemo = { key, at: now, map: new Map() };
    map = standingMemo.map;
  }
  return (entry) => {
    const k = `${entry.kind ?? ""}\u0000${entry.target}`;
    let s = map.get(k);
    if (!s) map.set(k, (s = standing(config, entry)));
    return s;
  };
}

/**
 * The `never_writes` entries the kernel will actually be given for this role.
 *
 * On macOS, all of them. On Linux, only the ones that exist on disk right now,
 * and that is the runtime's shape rather than a choice: bubblewrap denies a
 * path by mounting over it, and to mount over a path that does not exist it
 * creates it on the host — an empty, read-only file that stays there while the
 * role runs and forever if the process is killed. For `.git/index.lock`, the
 * case the key exists for, that locks every other user of the repo out.
 * Measured in Docker (Debian 12, bwrap 0.8.0) on 2026-09-23: present during the
 * run, gone after a clean exit, still there after SIGKILL.
 *
 * `explain` asks this same function, so the sentence and the kernel agree: a
 * document stricter than the boundary is the direction this project refuses.
 * `check` names the entries that are not enforced.
 */
export function enforcedNeverWrites(config, role) {
  const all = role?.neverWrites ?? [];
  if (process.platform !== "linux" || !config?.root) return all;
  return all.filter((g) => existsSync(join(config.root, g.replace(/\/\*\*$/, ""))));
}

/**
 * The `never_writes` entry of `role` that covers `path`, or null.
 *
 * `?? []` because a caller embedding the library builds role objects itself,
 * and one built before the key existed must keep meaning what it meant.
 */
export function neverWrites(role, path, config = null) {
  return enforcedNeverWrites(config, role).find((g) => covers(g, path)) ?? null;
}

/** A key dir as the policy's paths spell it: no leading `./`, no trailing `/`. */
const dirSpelling = (d) => String(d).replace(/^\.\/+/, "").replace(/\/+$/, "");

/** Is the repo-relative `rel` one of the key directories, or inside one? */
export function inKeyDir(config, rel) {
  return (config.keyDirs ?? []).some((d) => {
    const k = dirSpelling(d);
    const r = k.startsWith("/") ? relFromRoot(config, k) : k;
    return r !== null && (rel === r || rel.startsWith(r + "/"));
  });
}

function relFromRoot(config, abs) {
  const root = config.root ?? "";
  return abs === root ? "." : abs.startsWith(root + "/") ? abs.slice(root.length + 1) : null;
}

/**
 * How a key is written in a role's `keys` list: relative to the first key
 * directory when it lives there, with its directory otherwise — the same form
 * settingsFor and keyHolders resolve back.
 */
export function keyName(config, target) {
  const t = String(target ?? "");
  const first = config.keyDirs?.length ? dirSpelling(config.keyDirs[0]) : null;
  return first && t.startsWith(first + "/") ? t.slice(first.length + 1) : t;
}

/**
 * A read of a FILE — a path, not a key name — and whether the role gets it.
 *
 * Reads are open by design: every role reads everything outside the `[keys]`
 * dirs (and, under `isolate`, outside the credential homes). `explain` used to
 * send every read through the key question, so `explain dev read .env` said
 * "denied — no role declares .env" about a file every role could read. A wrong
 * no from the tool whose job is saying what the kernel will do. Now a path
 * inside a key directory is a key question; anything else is answered as the
 * open read it is, with how to make it a key.
 */
export function explainFileRead(config, role, rel, credentialHomes = []) {
  // Only a key directory makes a key: settingsFor refuses a key declared
  // anywhere else, so nothing outside one is denied by being a key.
  if (inKeyDir(config, rel)) return explain(config, role, "read", rel);
  const level = config.isolate === true ? "home" : config.isolate;
  if ((level === "credentials" || level === "home") && rel.startsWith("/")) {
    const hit = credentialHomes.find((h) => rel === h || rel.startsWith(h + "/"));
    if (hit)
      return {
        allowed: false, owners: [],
        reason: `${rel} is under ${hit}, which isolate = "${level}" closes to every role`,
      };
  }
  const dirs = (config.keyDirs ?? []).map(dirSpelling);
  return {
    allowed: true, owners: [], open: true,
    reason: dirs.length
      ? `${rel} is outside every [keys] dir (${dirs.join(", ")}), so every role reads it. ` +
        `Move it into ${dirs[0]}/ to make it a key`
      : `no [keys] dir is declared, so every role reads every file. ` +
        `Declare one under [keys] and move ${rel} into it to make it a key`,
  };
}

/**
 * What a read is about: a key, named the way the policy names keys, or a file.
 *
 * `explain dev read stripe` asks about a key — a bare name some role declares,
 * or one sitting in a key directory. Everything else is a path, resolved from
 * where you stand, and inside a key directory it is a key question again.
 */
export function readTarget(config, target, cwd = process.cwd()) {
  if (!target.includes("/") && !isAbsolute(target)) {
    const declared = keyHolders(config, target).length > 0;
    const bare = (s) => s.replace(/\.[^.]+$/, "");
    const inDir = (config.keyDirs ?? []).some((d) => {
      const dir = isAbsolute(d) ? d : join(config.root, d);
      if (existsSync(join(dir, target))) return true;
      try { return readdirSync(dir).some((f) => bare(f) === target); } catch { return false; }
    });
    const here = fromCwd(config, target, cwd);
    const isFileHere = existsSync(here) && !inKeyDir(config, toRepoRelative(config, here));
    if ((declared || inDir) && !isFileHere) return { key: true, target };
  }
  return { key: false, target: toRepoRelative(config, fromCwd(config, target, cwd)) };
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

  /**
   * Only path keys. A reference — `keychain://x`, `NAME=file://.secrets/a#X` —
   * is resolved by the parent and delivered as a value; the role is never
   * given the file. Comparing the raw strings let `explain` say "declares
   * a.env" about a role whose key merely pointed into it, a yes the kernel
   * would refuse.
   */
  return Object.values(config.roles)
    .filter((r) => fileKeys(r).some((k) =>
      resolve(k) === wanted || (loose && bare(k) === bare(key))))
    .map((r) => r.name);
}

/** The keys of `role` that grant a read: the path ones. A malformed entry grants nothing. */
function fileKeys(role) {
  let entries;
  try {
    entries = entriesOf(role);
  } catch {
    return [];
  }
  return entries.filter((e) => e.kind === "file").map((e) => e.raw);
}

/**
 * A connection the kernel refused: `tcp:<port>` or a unix socket path.
 *
 * The kernel does not say which host — its line is `remote:*:<port>` — so the
 * sentence says the port and what the policy gives for it, and nothing it
 * cannot know. Three answers, because they send a person to three places:
 *
 *   - the port is not in `local_ports`: a policy question, add it or do not;
 *   - it is, and was refused anyway: the client dialled directly instead of
 *     through the proxy — a MySQL driver, Chromium, a raw socket — and adding
 *     the port again will not change that;
 *   - a unix socket: seisin grants none, on purpose. The one that comes up is
 *     Docker's, and a role that can reach Docker can mount the whole disk.
 *
 * Never an owner and never a request: a port is not anybody's territory.
 */
function explainConnect(config, role, target) {
  const r = config.roles[role];
  const port = /^tcp:(\d+)$/.exec(target)?.[1];
  if (port) {
    const n = Number(port);
    if (r?.localPorts?.includes(n))
      return {
        allowed: false, owners: [], network: true, listed: true,
        reason: `port ${n} is in ${role}'s local_ports, but this client skipped the proxy. ` +
          `curl, fetch and urllib use HTTP_PROXY on their own; a database driver or a browser ` +
          `has to be pointed at it`,
      };
    // The kernel names no host, and every direct dial is refused — to an
    // outside host as much as to localhost. So both readings, not a guess:
    // advising `local_ports = [443]` for a client that skipped the proxy on
    // its way to the internet opens a port and fixes nothing.
    return {
      allowed: false, owners: [], network: true,
      reason: `port ${n}, host unknown. Local service: a person adds it to local_ports` +
        `${r?.localPorts?.length ? ` (has ${r.localPorts.join(", ")})` : ""}. ` +
        `Outside host: the client skipped HTTP_PROXY`,
    };
  }
  return {
    allowed: false, owners: [], network: true,
    reason: `${target} is a unix socket, and roles get none` +
      (/docker\.sock$/.test(target)
        ? `. Docker's socket can mount any directory on this machine: start containers outside ` +
          `the role and reach them by port`
        : ""),
  };
}

/** May this role load the MCP server `name`? A declaration, not something the kernel sees. */
function explainMcp(config, role, name) {
  const list = config.roles[role]?.mcp;
  if (list == null)
    return { allowed: true, owners: [], mcp: true, declared: false,
      reason: `${role} has no mcp list, so the policy does not limit its MCP servers` };
  if (list.includes(name))
    return { allowed: true, owners: [], mcp: true, declared: true, reason: `${role} declares mcp = [${list.map((n) => `"${n}"`).join(", ")}]` };
  return { allowed: false, owners: [], mcp: true, declared: true,
    reason: list.length
      ? `${role} may load only ${list.join(", ")}. Adding ${name} is a change to its mcp list`
      : `${role} declares mcp = [], no MCP servers` };
}

/**
 * The sentence a blocked agent should read.
 *
 * Three outcomes, and the third is the one worth having: a path nobody owns is
 * not a permission problem, it is a hole in the map. Saying so is more useful
 * than denying quietly, and it is the only way the hole ever gets fixed.
 */
export function explain(config, role, action, target) {
  if (action === "connect") return explainConnect(config, role, target);
  if (action === "mcp") return explainMcp(config, role, target);
  if (action === "read") {
    const holders = keyHolders(config, target);
    if (holders.includes(role)) return { allowed: true, owners: holders, reason: `${role} declares ${target}` };
    if (holders.length === 0) {
      // A key is written as a name relative to the key directory — `stripe.txt`,
      // not `.secrets/stripe.txt` — so the advice says the name to write.
      const name = keyName(config, target);
      return {
        allowed: false, owners: [],
        reason: `no role declares ${target} — add "${name}" to a role's keys: [roles.<name>] keys = ["${name}"]`,
      };
    }
    return { allowed: false, owners: holders, reason: `${target} belongs to ${holders.join(", ")}` };
  }

  const owners = ownersOf(config, target);
  /**
   * Protected before anything else, because no territory reaches it.
   *
   * The policy, seisin's state, the key directories, what the parent executes
   * or reads for a key, and the files that make git or Claude Code run
   * something outside the sandbox. The kernel denies all of them to every role —
   * surface.js has the list and the reasons — so saying "belongs to dev" about
   * `seisin.toml` sent a request to a person that no grant could satisfy.
   */
  const guard = protectedBy(config, target, { role });
  if (guard?.family)
    return {
      allowed: false, owners, protected: guard.why, family: guard.family,
      reason: `${target} is protected (${guard.why}). A role writes it only when the policy hands it ` +
        `that family: control_files = ["${guard.family}"] under [roles.${role}], and inside its own ` +
        `territory. That is a person's decision about the policy, not a grant to request`,
    };
  if (guard)
    return {
      allowed: false, owners, protected: guard.why,
      reason: `${target} is protected (${guard.why}) — no role writes it, so there is nothing to grant`,
    };
  /**
   * Named for what it is, and checked before "no owner".
   *
   * A path the role gave up through `never_writes` is not a permission it is
   * missing. Said as "belongs to nobody", the agent files a request, a person
   * approves it, and the subtraction is undone from the other side without
   * anyone deciding to undo it.
   */
  const r = config.roles[role];
  const barred = r && r.writes.some((g) => covers(g, target)) ? neverWrites(r, target, config) : null;
  if (barred)
    return {
      allowed: false, owners, neverWrites: barred,
      reason: `${target} is denied by never_writes of ${role} ("${barred}") — ` +
        `a subtraction written into the policy, not a missing grant`,
    };
  if (owners.includes(role)) return { allowed: true, owners, reason: `${target} is inside ${role}'s territory` };
  /**
   * Git's own bookkeeping in a repository this role does not write.
   *
   * Lock files, FETCH_HEAD, objects, refs, packed-refs: never a territory to
   * hand over, because granting them is letting the role rewrite somebody
   * else's history. Codex keeps `.git` read-only under a writable root for the
   * same reason; nono and Gemini grant the whole of it. Here it stays refused
   * and is said for what it is — not "belongs to X, ask them", which filed a
   * request per lock file (327 of them for one index.lock in one multi-repo workspace)
   * that nobody could sensibly grant. The requests side skips it too.
   */
  if (isGitMetadata(target))
    return {
      allowed: false, owners, gitMetadata: true,
      reason: `${target} is git's own bookkeeping in a repository ${role} does not write — ` +
        `not something to request. Read what you need (git log, git show, git ls-remote) ` +
        `or work in a worktree of your own`,
    };
  if (owners.length === 0)
    return { allowed: false, owners: [], reason: `${target} has no owner — no role can write it until one claims it` };
  return { allowed: false, owners, reason: `${target} belongs to ${owners.join(", ")}` };
}
