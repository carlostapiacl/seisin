/**
 * Where the same file lives twice, and which of the two the policy is about.
 *
 * A policy names one path on disk. A git worktree is the same repository at a
 * different path, and to the kernel the two are unrelated places: territory
 * granted on the canonical checkout grants nothing inside the worktree. That is
 * correct, and not the problem. The problem is that `explain` answered about
 * whichever path it was asked about, and nobody asked it about the path the
 * agent was standing in:
 *
 *   seisin explain qa write src/api/x        allowed
 *   the role's own Write, inside a worktree   Operation not permitted
 *
 * Both true. Measured in production on three roles of one team, and expensive
 * every time, because a diagnosis tool that answers a different question from
 * the one the person believes they asked is worse than one that says nothing.
 *
 * ── What this does, and does not, do ──
 * It finds the twin of a path in the other checkouts of the same repo, so the
 * commands can compare the two answers and say so when they differ. It changes
 * no verdict. The boundary is built from the policy as written, before this
 * file is consulted, and would be identical with it deleted — the same rule
 * that lets the kernel monitor exist at all: observing costs nothing to observe.
 *
 * ── Without git ──
 * A worktree is recognisable from one file. In a normal checkout `.git` is a
 * directory; in a worktree it is a file reading
 * `gitdir: <canonical>/.git/worktrees/<name>`, and the canonical side keeps the
 * reverse pointer in `.git/worktrees/<name>/gitdir`. Two reads, no subprocess,
 * and no dependency — a tool people install to shrink their attack surface
 * should not shell out to find out where it is.
 */
import { statSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { findConfig } from "./config.js";

const GITDIR = /^gitdir:\s*(.+?)\s*$/;
const WORKTREE = /^(.+)\/\.git\/worktrees\/[^/]+$/;

/**
 * The canonical checkout a worktree's `.git` file points at, or null.
 *
 * `at` is the directory holding the file, for the relative form newer git can
 * write. Anything that is not the `/.git/worktrees/<name>` shape is refused
 * rather than guessed at: a submodule's `.git` file points into
 * `.git/modules/`, and a worktree of a bare repo points at a directory with no
 * working tree, so neither has a twin to name.
 */
export function parseGitdir(text, at = "/") {
  const m = GITDIR.exec(text.trim());
  if (!m) return null;
  const target = resolve(at, m[1]).replace(/\\/g, "/").replace(/\/+$/, "");
  const w = WORKTREE.exec(target);
  return w ? w[1] : null;
}

/** stat, or null — a path that is not there yet is a normal thing to ask about. */
function statOf(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** The path with symlinks followed, or the path itself when it is not on disk. */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Two spellings of one place — `/tmp` and `/private/tmp` — compare equal. */
function same(a, b) {
  return real(a) === real(b);
}

/**
 * The checkout a path sits in: `{ root, canonical, worktree }`, or null.
 *
 * Walks up until a `.git` shows up. The path itself need not exist — the file
 * an agent was refused is usually the one it was about to create — so a missing
 * directory is stepped over rather than treated as an answer.
 *
 * A `.git` file that does not name a worktree is stepped over too. It marks a
 * submodule, and the question is where the enclosing repo is: a submodule
 * inside a worktree is as displaced as everything else in it.
 */
export function checkoutOf(path) {
  let dir = resolve(path);
  for (;;) {
    const dotgit = join(dir, ".git");
    const st = statOf(dotgit);
    if (st?.isDirectory()) return { root: dir, canonical: dir, worktree: false };
    if (st?.isFile()) {
      const canonical = parseGitdir(readFileSync(dotgit, "utf8"), dir);
      if (canonical) return { root: dir, canonical, worktree: true };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The worktrees a canonical checkout has registered and that are still there.
 *
 * `git worktree remove` deletes the registration; `rm -rf` on the worktree
 * does not, and the entry stays until someone runs `prune`. An entry whose
 * `.git` file is gone is skipped, and so is one that no longer points back
 * here — a directory can be deleted and reused for something else.
 */
export function worktreesOf(canonical) {
  const dir = join(canonical, ".git", "worktrees");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let pointer;
    try {
      pointer = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
    } catch {
      continue;
    }
    // `<worktree>/.git`, the file checkoutOf reads from the other side.
    const root = dirname(resolve(join(dir, name), pointer));
    const back = checkoutOf(root);
    if (back?.worktree && same(back.root, root) && same(back.canonical, canonical)) out.push(root);
  }
  return out;
}

/**
 * Every other checkout in which the asked path has a twin, under this policy.
 *
 * Returns `{ here, twins }`: where the asked path is, and for each other
 * checkout of the same repo the twin's absolute `path`, its `rel` spelling
 * against the policy root (absolute when it is outside), whether that checkout
 * is a `worktree`, and whether the process is `standing` in it. The one the
 * process is standing in comes first, because that is the one the person
 * forgot to ask about.
 *
 * Two checkouts are compared only when a process standing in either would load
 * the SAME policy file. A repo that tracks its `seisin.toml` gives every
 * worktree a copy, and a role launched there resolves its territory against
 * that copy — the canonical side is then a different policy's business, and
 * reporting it under this one would be the confusion this file exists to end.
 * Which is also why a checkout outside the policy root never qualifies:
 * `findConfig` from there does not arrive at this file.
 *
 * Reads are not a question here. A key is a file in a declared directory, not
 * a place in a checkout, so a twin of a key path is not a key.
 */
export function twinsOf(config, target, cwd = process.cwd()) {
  const abs = isAbsolute(target) ? resolve(target) : resolve(config.root, target);
  const here = checkoutOf(abs);
  const none = { here, twins: [] };
  if (!here || !sharesPolicy(config, here.root)) return none;

  const others = here.worktree
    ? [here.canonical, ...worktreesOf(here.canonical).filter((w) => !same(w, here.root))]
    : worktreesOf(here.canonical);

  const standing = checkoutOf(cwd);
  const inside = relative(here.root, abs);
  const twins = [];
  for (const root of others) {
    if (!sharesPolicy(config, root)) continue;
    const path = join(root, inside);
    const under = relative(config.root, path);
    twins.push({
      path,
      rel: under.startsWith("..") || isAbsolute(under) ? path : under,
      root,
      worktree: !same(root, here.canonical),
      standing: Boolean(standing && same(standing.root, root)),
    });
  }
  twins.sort((a, b) => Number(b.standing) - Number(a.standing));
  return { here, twins };
}

/**
 * One sentence placing the two checkouts, in the policy's own spelling.
 *
 * "Standing" gets its own wording because it is the whole finding: the answer
 * above was about one place and the process is in the other. A checkout is
 * shown relative to the policy root, and the root itself is "this repo" rather
 * than an empty string or a dot.
 */
export function whereIs(config, here, twin) {
  const show = (p) => {
    const under = relative(config.root, p);
    return under === "" ? "this repo" : under.startsWith("..") || isAbsolute(under) ? p : under;
  };
  const canonical = show(here.canonical);
  if (twin.standing)
    return twin.worktree
      ? `you are standing in a worktree of ${canonical}, at ${show(twin.root)}`
      : `you are standing in ${canonical}, and ${show(here.root)} is a worktree of it`;
  return twin.worktree
    ? `${canonical} has a worktree at ${show(twin.root)}`
    : `${show(here.root)} is a worktree of ${canonical}`;
}

/** Would a process standing at `dir` load this very policy file? */
function sharesPolicy(config, dir) {
  const found = findConfig(dir);
  return Boolean(found) && same(found, config.path);
}
