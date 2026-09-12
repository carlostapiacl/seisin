/**
 * `seisin scan` — what is NOT covered by the key declaration.
 *
 * Exits 1 only on a `certain` finding. A `review` line is a prompt to look, and
 * failing a build on those would make the command unusable in CI within a week.
 */
import { scan } from "../scan.js";
import { renderScan, out } from "../render.js";

export function scanCommand(config) {
  const { hits, skipped, truncated } = scan(config.root, config.keyDirs, config.scanIgnore);
  const result = {
    certain: hits.filter((h) => h.level === "certain"),
    review: hits.filter((h) => h.level === "review"),
    skipped,
    truncated,
  };
  out(renderScan(result, config.keyDirs));
  return result;
}
