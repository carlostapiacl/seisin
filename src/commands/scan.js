/**
 * `seisin scan` — what is NOT covered by the key declaration.
 *
 * Exits 1 only on a `certain` finding. A `review` line is a prompt to look, and
 * failing a build on those would make the command unusable in CI within a week.
 *
 * Where it looks: the repository the policy is in, or — when the policy sits
 * in a folder of repositories — the repositories its territories live in (see
 * territoryRoots). `--all` walks the whole folder either way.
 */
import { relative } from "node:path";
import { scan, insideRepo, territoryRoots } from "../scan.js";
import { ownersOf } from "../owners.js";
import { renderScan, out } from "../render.js";

export function scanCommand(config, argv = []) {
  const all = argv.includes("--all");
  const roots = all || insideRepo(config.root) ? null : territoryRoots(config);
  const { hits, skipped, nestedPaths, truncated, omitted } =
    scan(config.root, config.keyDirs, config.scanIgnore, 500, { roots });
  // Whose territory a finding is in: the role that will come across it first.
  for (const h of hits) if (h.level !== "link") h.owners = ownersOf(config, h.file);
  const result = {
    certain: hits.filter((h) => h.level === "certain"),
    named: hits.filter((h) => h.level === "named"),
    review: hits.filter((h) => h.level === "review"),
    links: hits.filter((h) => h.level === "link"),
    skipped,
    nestedPaths,
    truncated,
    omitted,
    scope: roots ? roots.map((r) => relative(config.root, r) || ".") : null,
  };
  out(renderScan(result, config.keyDirs));
  return result;
}
