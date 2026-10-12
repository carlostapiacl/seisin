import { resolve, dirname, basename, relative, join } from "node:path";
import { existsSync } from "node:fs";
import { territoryOf, implicitSidecar, under, regularFilesIn } from "./files.js";
import { covers } from "../owners.js";

export function layoutWarnings(config, roles, scoped) {
  const warnings = [];
  // A territory that leaves the repo is supported — a role can own its handover
  // note one level up — but it is a different promise from "this repo, divided",
  // and it should be a sentence somebody chose rather than a line that drifted.
  const loose = [];      // roles granting individual files
  const listed = [];     // role + folder pairs that enumerate

  /**
   * A private folder inside another role's territory. Allowed — it is how a
   * folder is taken out of a wide `writes = ["**"]` — but that role loses it,
   * reading included, and nothing in its own table says so.
   */
  for (const r of roles)
    for (const p of r.private ?? []) {
      const dir = p.replace(/\/\*\*$/, "").replace(/\/+$/, "").replace(/^\.\//, "");
      for (const o of Object.values(config.roles)) {
        if (o.name === r.name) continue;
        const g = (o.writesDeclared ?? o.writes).find((w) => covers(w, dir));
        if (g)
          warnings.push({
            kind: "private-inside-territory",
            headline: `${r.name}: private "${p}" is inside ${o.name}'s writes ("${g}") — ${o.name} can neither read nor write it`,
            detail: `Every role but ${r.name} is denied the folder, and the deny wins over ${o.name}'s territory. ` +
              `If ${o.name} needs what is in it, it asks ${r.name}; if it should keep it, the folder is not private.`,
          });
      }
    }

  for (const r of roles) {
    const out = r.writes.filter((w) => w.startsWith("/") || w.startsWith("../"));
    if (out.length)
      warnings.push({
        kind: "territory-outside-repo",
        headline: `${r.name} writes outside this repo: ${out.join(" ")}`,
        detail: "the sandbox will grant it. Nothing here checks what lives there.",
      });
  }

  /**
   * A territory that is not on disk.
   *
   * A proposal written for another repo — or one typo — reads as a working
   * policy: `check` printed the map and the first sign of anything wrong was a
   * denial inside the agent. Said per glob, as a warning and never a failure:
   * a role can own a folder it is about to create.
   */
  for (const r of roles) {
    for (const g of r.writes) {
      if (g === "**" || g.startsWith("/") || g.startsWith("../")) continue;
      // A database's sidecars come with it (config.js) and exist only while it
      // is open: absent on disk is their normal state, not a typo to report.
      if (implicitSidecar(r, g)) continue;
      const fixed = [];
      for (const part of g.split("/")) {
        if (/[*?[\]]/.test(part)) break;
        fixed.push(part);
      }
      if (!fixed.length || existsSync(join(config.root, ...fixed))) continue;
      warnings.push({
        kind: "writes-match-nothing",
        headline: `${r.name} writes ${g} — matches nothing in this repo`,
        detail: "fine if the role is about to create it; otherwise the territory points at a folder that is not there.",
      });
    }
  }

  /**
   * A territory inside a key directory.
   *
   * Seen in use: a role's whole territory sat under the folder declared as
   * `[keys] dir`, which is closed to every role, so the role could write
   * nothing at all — and `check` printed its territory as if it held. A key
   * directory is read by the roles that declare a key in it and written by
   * none; a folder a role must write belongs somewhere else.
   */
  const keyRoots = (config.keyDirs ?? []).map((d) => d.replace(/\/+$/, "")).filter(Boolean);
  for (const r of roles) {
    for (const g of r.writes) {
      const fixed = [];
      for (const part of g.split("/")) {
        if (/[*?[\]]/.test(part)) break;
        fixed.push(part);
      }
      const at = fixed.join("/");
      const dir = at && keyRoots.find((d) => at === d || at.startsWith(d + "/"));
      if (!dir) continue;
      warnings.push({
        kind: "territory-in-key-dir",
        headline: `${r.name} writes ${g} — inside the key directory ${dir}, which no role can write`,
        detail: "a key directory is read by the roles that declare its keys and written by none. Move what this role writes out of it, or drop the territory.",
      });
    }
  }

  /**
   * A file granted by name does not come with its neighbours.
   *
   * Measured, in production, and it survived two reviews of the policy by people:
   * a role was granted its database file and still could not write the
   * database. The database opens a second file beside the first — a journal —
   * and the sibling was outside the grant, so the write failed in the
   * database's own words ("readonly") rather than as a permission error.
   *
   * What is deliberately NOT here: a list of which programs write which
   * siblings. That would ask seisin to know about databases, and the next
   * question is why it does not know about a lock file, the temporary file of
   * an atomic write, or an editor's backup. The list has no end and every entry
   * is a guess about a repo nobody foresaw. The general form needs no list: the
   * kernel grants a path and everything under it, so a grant on a file covers
   * the file and nothing else. Whether a tool will want a neighbour is the
   * reader's to know; that the neighbour is not granted is arithmetic.
   */
  for (const r of roles) {
    const { files, subtrees } = territoryOf(config, r);
    // A file inside one of the role's own subtrees has its siblings covered by
    // that subtree, so naming it changes nothing and warns about nothing.
    const alone = files.filter((f) => !subtrees.some((s) => under(dirname(f.abs), s)));
    if (alone.length)
      loose.push({ role: r.name, n: alone.length, of: r.writes.filter((g) => !implicitSidecar(r, g)).length,
                   globs: alone.map((f) => f.glob) });


    /**
     * A territory written as a list of files is a photograph of the folder.
     *
     * A sandbox cannot say "the source files in this folder" — one level down
     * is not a prefix, and `src/*` is refused above for exactly that reason,
     * correctly. So a territory that means that has to be written as the files
     * that exist today, and the day a file is added the policy is one behind:
     * the owning role cannot write its own new file, and nothing fails loudly.
     *
     * Reported as a count, never as a verdict. "Comparable" here means only
     * "a regular file in the same folder" — not the same extension, not the
     * same shape of name, because either of those is a guess about what the
     * territory *meant*, and a guess about intent is the thing this check
     * exists to avoid. The unnamed files are listed by name instead, so the
     * reader can see in one glance whether the gap is an oversight or a
     * decision. seisin cannot tell, and does not pretend to.
     *
     * Silent when a folder has fewer than two named files (one file is a
     * grant, not an enumeration) and when the folder is also granted as a
     * subtree (then the list is decorative).
     */
    const byDir = new Map();
    for (const f of alone) {
      const dir = dirname(f.abs);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(basename(f.abs));
    }
    for (const [dir, named] of byDir) {
      if (named.length < 2) continue;
      const onDisk = regularFilesIn(dir);
      const unnamed = onDisk.filter((n) => !named.includes(n));
      if (!unnamed.length) continue;
      const shown = relative(resolve(config.root), dir);
      listed.push({ role: r.name, named: named.length, total: onDisk.length,
                    where: shown ? shown + "/" : "the repo root", unnamed });

    }
  }

  /**
   * One warning per finding, not one per role.
   *
   * These were emitted inside the role loop, which reads fine on the two-role
   * fixture they were written against and falls apart on a real policy: 30
   * roles produced 39 of these lines and took `seisin check` from 30 lines to
   * **297**. That is the defect the detail text below is about — a check nobody
   * finishes reading protects nobody — reached from the other side.
   *
   * So the count leads and a few examples follow. Whoever wants the full list
   * has `seisin check <role>`, which is the question they were asking anyway.
   */
  if (loose.length) {
    const shown = loose.slice(0, 3).map((l) => `${l.role} (${l.n} of ${l.of})`).join(", ");
    const more = loose.length > 3 ? `, and ${loose.length - 3} more` : "";
    warnings.push({
      kind: "siblings-uncovered",
      headline:
        `${loose.length} role(s) grant individual files rather than folders: ${shown}${more}`,
      detail:
        "the kernel grants exactly that path. Anything a tool creates beside it — a " +
        "database's journal, a lock file, the temporary file of an atomic write — is a " +
        "sibling, and a sibling is outside the grant; the failure arrives in the tool's " +
        "own words, not as a permission error. Grant the folder where the tool needs " +
        "neighbours. " +
        (scoped
          ? `The files: ${loose[0].globs.join(" ")}.`
          : "`seisin check <role>` names the files for one role."),
    });
  }

  if (listed.length) {
    const shown = listed.slice(0, 3)
      .map((l) => `${l.role} names ${l.named} of ${l.total} in ${l.where}`).join("; ");
    const more = listed.length > 3 ? `; and ${listed.length - 3} more` : "";
    warnings.push({
      kind: "enumerated-territory",
      headline: `${listed.length} territory(ies) list some files of a folder: ${shown}${more}`,
      detail:
        `not named, in the first of them: ${listed[0].unnamed.slice(0, 8).join(" ")}` +
        `${listed[0].unnamed.length > 8 ? ` … and ${listed[0].unnamed.length - 8} more` : ""}` +
        `. A sandbox grants a path, ` +
        `not "the files of this kind here", so a territory that means that is the list of files ` +
        `that existed when it was written — the next one added lands outside it, and nothing ` +
        `fails loudly. Whether these are left out on purpose is not something a count can tell.`,
    });
  }
  return warnings;
}
