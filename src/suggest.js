/**
 * "Did you mean" — for a command, a role, a flag.
 *
 * One place, so every command answers a typo the same way: the name that was
 * not found, what exists, and the nearest one when it is near enough to be a
 * typo rather than a different word.
 */

/** Edit distance, small strings only. */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The nearest of `known` to `word`, or null when nothing is close. */
export function nearest(word, known) {
  let best = null, score = Infinity;
  for (const k of known) {
    const n = distance(String(word).toLowerCase(), k.toLowerCase());
    if (n < score) { best = k; score = n; }
  }
  const room = Math.max(1, Math.floor(String(word).length / 3));
  return score <= room || (best && best.startsWith(word) && word.length >= 2) ? best : null;
}

/** The error for a role the policy does not have, always with the list. */
export function unknownRole(config, role) {
  const known = Object.keys(config.roles ?? {});
  const near = nearest(role, known);
  return new Error(
    `unknown role "${role}"${near ? ` — did you mean "${near}"?` : ""}` +
    `\n  known roles: ${known.join(", ") || "none — add a [roles.<name>] section"}`);
}

/**
 * Flags a command does not take are refused, never ignored. An ignored
 * `--verbsoe` is a question answered as if it had not been asked.
 * `values` are the flags that take the next word as their value.
 */
export function checkFlags(command, argv, known, values = []) {
  const all = [...known, ...values];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (values.includes(a)) { i++; continue; }
    if (!a.startsWith("-") || a === "-") continue;
    if (all.includes(a)) continue;
    const near = nearest(a, all);
    const e = new Error(`unknown flag "${a}" for ${command}${near ? ` — did you mean "${near}"?` : ""}` +
      `\n  seisin ${command} --help lists its flags`);
    e.usage = true;
    throw e;
  }
}
