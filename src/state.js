/**
 * Where this process keeps seisin's own files: the log, the request queue and
 * their lock.
 *
 * `<root>/.seisin/` unless a launcher keeps them elsewhere with `--state-dir`
 * (an orchestrator that archives each run in a folder of its own, and should
 * not have to copy a directory out of a worktree it is about to delete). The
 * choice travels to everything a run starts as SEISIN_STATE_DIR, so the hook
 * inside the sandbox and the parent agree on one place.
 *
 * For a policy at the root of a git worktree, `<root>` is the main checkout. A worktree
 * is thrown away when its work is done: what a role was denied there, and what
 * it asked for, was thrown away with it, and could not be seen from the checkout
 * where a person grants it. One repo, one record.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATE_DIR } from "./layout.js";
import { checkoutOf } from "./worktree.js";

let override = process.env.SEISIN_STATE_DIR ? resolve(process.env.SEISIN_STATE_DIR) : null;

/** The state directory for a policy rooted at `root`. */
export function stateDir(root) {
  return override ?? join(homeOf(root), STATE_DIR);
}

/** Where a folder keeps seisin's files when nobody said otherwise. */
export const defaultStateDir = (root) => join(homeOf(root), STATE_DIR);

const homes = new Map();

/** Where a root keeps its state: itself, or the main checkout when it is a worktree's root. */
function homeOf(root) {
  let home = homes.get(root);
  if (home !== undefined) return home;
  const at = checkoutOf(root);
  // Only the worktree itself. A policy in a folder inside one keeps its record
  // beside it: a path in the main checkout that nobody chose is no place to write.
  home = at?.worktree && at.root === root && existsSync(at.canonical) ? at.canonical : root;
  homes.set(root, home);
  return home;
}

/** `--state-dir`: from now on, and for everything this process starts. */
export function setStateDir(dir) {
  override = resolve(dir);
  process.env.SEISIN_STATE_DIR = override;
}
