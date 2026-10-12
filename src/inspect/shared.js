import { ownersOf } from "../owners.js";

/**
 * Paths more than one role claims.
 *
 * Overlap is allowed and sometimes right — a hotfix role deliberately reaches
 * into the territory of the role that normally owns a repo. It is reported so
 * that it stays a decision somebody made rather than a thing that drifted.
 */
export function sharedPaths(config, roles = Object.values(config.roles)) {
  // Asked once per distinct glob: a real policy repeats them (1,332 writes,
  // 303 distinct in a multi-repo workspace), and each question is every glob of every
  // role again.
  const seen = new Set();
  const asked = new Map();
  for (const r of roles)
    for (const glob of r.writes) {
      let many = asked.get(glob);
      if (many === undefined) asked.set(glob, (many = ownersOf(config, glob.replace(/\/\*\*$/, "")).length > 1));
      if (many) seen.add(glob);
    }
  /**
   * A shared database counts once, not four times.
   *
   * `writes` carries the sidecar expansion so that the grant and the sentence
   * agree (see config.js), and this list read straight off it turned nine
   * shared things into thirty-three — the same name with three suffixes,
   * announced as if it were three more decisions to make. The expansion exists
   * to stop a policy saying one thing four times; a warning that undoes that
   * is the feature leaking into the place it was meant to clean up.
   *
   * A sidecar shared WITHOUT its database still counts on its own, because
   * that is a real and odd thing to have.
   */
  const todas = new Set(seen);
  return [...seen].filter((p) => !(/-(wal|shm|journal)$/.test(p) && todas.has(p.replace(/-(wal|shm|journal)$/, ""))));
}
