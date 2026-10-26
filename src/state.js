/**
 * Where this process keeps seisin's own files: the log, the request queue and
 * their lock.
 *
 * `<root>/.seisin/` unless a launcher keeps them elsewhere with `--state-dir`
 * (an orchestrator that archives each run in a folder of its own, and should
 * not have to copy a directory out of a worktree it is about to delete). The
 * choice travels to everything a run starts as SEISIN_STATE_DIR, so the hook
 * inside the sandbox and the parent agree on one place.
 */
import { join, resolve } from "node:path";
import { STATE_DIR } from "./layout.js";

let override = process.env.SEISIN_STATE_DIR ? resolve(process.env.SEISIN_STATE_DIR) : null;

/** The state directory for a policy rooted at `root`. */
export function stateDir(root) {
  return override ?? join(root, STATE_DIR);
}

/** `--state-dir`: from now on, and for everything this process starts. */
export function setStateDir(dir) {
  override = resolve(dir);
  process.env.SEISIN_STATE_DIR = override;
}
