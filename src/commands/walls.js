/** `seisin walls <role>` — what that role keeps being denied, and what it cost. */
import { unknownRole } from "../suggest.js";
import { walls, wasted } from "../walls.js";
import { STALE_RUNS } from "../requests.js";
import { logPath } from "../log.js";
import { standingOf } from "../owners.js";
import { kindsOf } from "../kinds.js";
import { C, out, safe } from "../render.js";

export function wallsCommand(config, argv = []) {
  const role = argv[0];
  if (!role) throw new Error("usage: seisin walls <role> [--since <iso>] [--min <n>] [--all]");
  if (!config.roles[role]) throw unknownRole(config, role);
  const at = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  const every = walls(config, role, {
    file: logPath(config.root),
    min: Number(at("--min", 2)),
    since: at("--since", null),
    limit: 0,
  });
  const all = argv.includes("--all");
  const list = (all ? every : every.filter((w) => !w.stale)).slice(0, 6);
  const old = every.filter((w) => w.stale).length;
  const shown = withKinds(config, list);
  if (shown.length) out(renderForPerson(role, shown));
  else if (!every.length)
    out(`\n  ${C.dim}${safe(role)} has no repeated denials in the recorded runs. A path becomes a wall after ${at("--min", 2)} denials.${C.off}\n\n`);
  else if (!all)
    out(`\n  ${C.dim}${safe(role)} has no recent walls; older ones are hidden. Use seisin walls ${safe(role)} --all.${C.off}\n\n`);
  if (old && !all) out(`  (${old} older wall(s) not hit in the last ${STALE_RUNS}+ runs: seisin walls ${role} --all)\n`);
  return shown;
}

/**
 * An unowned path gets the kind and hint the console gives it (kinds.js).
 *
 * The bare reason said "has no owner — no role can write it until one claims
 * it" about `dist/` and `.env` alike: an invitation to give a build folder or a
 * credential an owner, while the console said what kind of thing each was and
 * what to do instead. Same classifier, same sentence, on both screens.
 */
function withKinds(config, list) {
  const stand = standingOf(config);
  const unowned = list.filter((w) => w.action === "write" && !w.owners?.length &&
    stand({ kind: "file", target: w.target }).kind === "unowned");
  const natures = kindsOf(unowned.map((w) => w.target), { keyDirs: config.keyDirs ?? [] });
  return list.map((w) => (unowned.includes(w) ? { ...w, ...natures.get(w.target) } : w));
}

/**
 * The same walls, said to the person at the terminal.
 *
 * `render` speaks to the agent — "you have already been denied these… do not
 * retry" — because the hook and the MCP server put it in a prompt. Printed at
 * a terminal, that voice addressed the person reading it as if they were the agent.
 */
export function renderForPerson(role, list) {
  const lines = [`\n  ${C.b}${safe(role)}${C.off} keeps hitting:\n\n`];
  for (const w of list) {
    const why = w.owners?.length ? `belongs to ${w.owners.map(safe).join(", ")}`
      : w.kind ? `unowned · ${w.kind === "territory" ? "ownable" : w.kind}: ${safe(w.hint)}`
      : safe(w.reason);
    lines.push(`    ${C.yellow}${String(w.times).padStart(3)}×${C.off}  ${w.action} ${safe(w.target)}  ${C.dim}${why}${C.off}\n`);
  }
  const n = wasted(list);
  if (n > 0) lines.push(`\n  ${C.dim}${n} of its calls went into retrying these.${C.off}\n`);
  lines.push("\n");
  return lines.join("");
}
