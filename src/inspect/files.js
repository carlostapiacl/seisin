import { resolve } from "node:path";
import { lstatSync, readdirSync } from "node:fs";

/**
 * A role's territory, sorted by what the kernel will do with each line.
 *
 * Three shapes get through `settingsFor` (see EXPRESSIBLE in srt.js): the whole
 * repo, a subtree `x/**`, and a literal path. The literal path is the one the
 * text cannot settle on its own — `data/base.sqlite` and `data` are both
 * literal, and to the kernel the second is a subtree because it is a directory.
 * So the disk is asked, once per line: a regular file is a file, a directory is
 * a subtree, and anything else — absent, a symlink, a socket — goes in neither
 * count rather than being guessed at. That is one `lstat` per declared path,
 * bounded by the length of the policy and not the size of the repo, which is
 * the line `check` stays on.
 *
 * Subtrees come back as the absolute prefix the kernel will be handed, so that
 * "is this file's folder inside that grant" is the same comparison the kernel
 * makes — a prefix — and not a second reading of the glob.
 */
export function territoryOf(config, role) {
  const root = resolve(config.root);
  const abs = (p) => resolve(root, p);
  const files = [];
  const subtrees = [];
  for (const glob of role.writes) {
    if (glob === "**" || glob.endsWith("/**")) {
      subtrees.push(abs(glob === "**" ? "." : glob.slice(0, -3)));
      continue;
    }
    if (/[*?[\]]/.test(glob)) continue;      // already refused above as cannot-be-enforced
    if (implicitSidecar(role, glob)) continue; // part of its database, not a file of its own
    const s = lstatOrNull(abs(glob));
    if (s?.isFile()) files.push({ glob, abs: abs(glob) });
    else if (s?.isDirectory()) subtrees.push(abs(glob));
  }
  return { files, subtrees };
}

/**
 * A `-wal`, `-shm` or `-journal` the role has because it writes the database
 * beside it — the expansion in config.js, which `writes` carries. It is the
 * same resource as the database, so it is not counted or reported as another
 * file. One declared WITHOUT its database is the role's own, and counts.
 */
export function implicitSidecar(role, glob) {
  const m = /^(.*\.sqlite3?)-(wal|shm|journal)$/.exec(glob);
  return !!m && role.writes.includes(m[1]);
}

/** Is `p` the prefix, or somewhere beneath it. The kernel's own test, in one line. */
export function under(p, prefix) {
  return p === prefix || p.startsWith(prefix + "/");
}

/** The regular files directly inside `dir`, by name. Not folders, not links, not deeper. */
export function regularFilesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}
