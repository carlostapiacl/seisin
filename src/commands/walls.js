/** `seisin walls <role>` — what that role keeps being refused, and what it cost. */
import { unknownRole } from "../suggest.js";
import { walls, wasted } from "../walls.js";
import { STALE_RUNS } from "../requests.js";
import { logPath } from "../log.js";
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
  // Nothing to say prints nothing, the way `scan` does when a repo is clean.
  // A command that always speaks is one whose output stops being read.
  if (list.length) out(renderForOperator(role, list));
  if (old && !all) out(`  (${old} older wall(s) not hit in the last ${STALE_RUNS}+ runs: seisin walls ${role} --all)\n`);
  return list;
}

/**
 * The same walls, said to the person at the terminal.
 *
 * `render` speaks to the agent — "you have already been denied these… do not
 * retry" — because the hook and the MCP server put it in a prompt. Printed at
 * a terminal, that voice addressed the operator as if they were the agent.
 */
export function renderForOperator(role, list) {
  const lines = [`\n  ${C.b}${safe(role)}${C.off} keeps hitting:\n\n`];
  for (const w of list) {
    const why = w.owners?.length ? `belongs to ${w.owners.map(safe).join(", ")}` : safe(w.reason);
    lines.push(`    ${C.yellow}${String(w.times).padStart(3)}×${C.off}  ${w.action} ${safe(w.target)}  ${C.dim}${why}${C.off}\n`);
  }
  const n = wasted(list);
  if (n > 0) lines.push(`\n  ${C.dim}${n} of its calls went into retrying these.${C.off}\n`);
  lines.push("\n");
  return lines.join("");
}
