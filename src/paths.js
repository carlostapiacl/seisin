/**
 * One way to turn whatever path a caller holds into the repo-relative path the
 * policy is written in.
 *
 * It was copied by hand into four places (explain, whose, the hook, run) and a
 * fifth, the MCP server, never had it: `seisin_explain` answered "has no owner"
 * for an absolute path the CLI called allowed — the same defect decisions.md
 * records as closed, closed in one surface only. And none of the copies
 * resolved symlinks, so on macOS a path under `/tmp` (a link to `/private/tmp`)
 * was refused by the sentence while the kernel, which sees the real path,
 * allowed it: the document tighter than the boundary, the direction this
 * project refuses. Found by the read-only review of 2026-09-22.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * `p` with its deepest existing ancestor resolved through symlinks and the rest
 * appended as written. realpath alone fails on a path that does not exist yet,
 * which is the shape of every file about to be created — a lock file included.
 */
export function realAncestor(p) {
  let head = p, tail = "";
  while (head !== dirname(head)) {
    try {
      const real = realpathSync(head);
      return tail ? join(real, tail) : real;
    } catch {
      tail = tail ? join(basename(head), tail) : basename(head);
      head = dirname(head);
    }
  }
  return p;
}

/**
 * Repo-relative when `target` is inside the repo, spelled either way; exactly as
 * written when it is relative already or lies outside. A path outside keeps its
 * honest "no owner" — it is a question about somewhere else.
 */
export function toRepoRelative(config, target) {
  if (typeof target !== "string" || !isAbsolute(target)) return target;
  const root = config.root;
  const inside = (r, t) => t === r || t.startsWith(r + sep);
  if (inside(root, target)) return relative(root, target) || ".";
  const realRoot = realAncestor(root);
  const realTarget = realAncestor(target);
  if (inside(realRoot, realTarget)) return relative(realRoot, realTarget) || ".";
  return target;
}
