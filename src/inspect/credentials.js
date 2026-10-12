import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { SHAPES } from "../scan.js";

/**
 * Credential-shaped names at the top of the repository, and nothing deeper.
 *
 * One `readdir`, no recursion, conventional names only. It exists to answer
 * "does this repo plausibly have secrets" fast enough to run on every `check`,
 * not to find them — `seisin scan` is the one that looks properly.
 */
const CREDENTIAL_NAMES = /^(\.env(\..+)?|\.secrets|secrets|\.netrc|.*\.(pem|key|p12|pfx))$/i;

export function credentialish(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = new Set(entries.filter((e) => CREDENTIAL_NAMES.test(e.name)).map((e) => e.name));

  /**
   * And the ones whose name gives nothing away.
   *
   * The name test misses `credentials.txt`, `tokens.conf`, `config.local` —
   * which a field review found by writing a test file this did not catch, and
   * then blaming the test. The test was fine; the detector was name-only.
   *
   * So the root's small text files are also read, with the same shapes
   * `seisin scan` uses. Root only, small only, and it stops at the first hit
   * per file: this runs on every `check` and the full walk is `scan`'s job.
   */
  const CERTAIN = SHAPES.filter(([c]) => c === "certain").map(([, , re]) => re);
  for (const e of entries) {
    if (found.size >= 4) break;
    if (!e.isFile() || found.has(e.name)) continue;
    try {
      const p = join(root, e.name);
      if (statSync(p).size > 64 * 1024) continue;
      const text = readFileSync(p, "utf8");
      if (CERTAIN.some((re) => re.test(text))) found.add(e.name);
    } catch {
      /* unreadable, or not text: not our business here */
    }
  }
  return [...found].sort().slice(0, 4);
}
