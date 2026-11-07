/**
 * Where the policy file is, from where you stand.
 *
 * Apart from config.js so that `worktree.js` can ask without importing the
 * whole policy reader: that import closed a loop through keys, surface and
 * state back to worktree, and a loop decides which module runs first by the
 * order someone happened to import them in.
 */
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { CONFIG_NAME } from "./layout.js";

/** Walk up from `from` until a seisin.toml shows up. Returns its path or null. */
export function findConfig(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
