/** `seisin walls <role>` — what that role keeps being refused, and what it cost. */
import { walls, render } from "../walls.js";
import { STALE_RUNS } from "../requests.js";
import { logPath } from "../log.js";
import { out } from "../render.js";

export function wallsCommand(config, argv = []) {
  const role = argv[0];
  if (!role) throw new Error("usage: seisin walls <role> [--since <iso>] [--min <n>] [--all]");
  if (!config.roles[role])
    throw new Error(`unknown role "${role}". Known: ${Object.keys(config.roles).join(", ")}`);
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
  if (list.length) out(render(list));
  if (old && !all) out(`  (${old} older wall(s) not hit in the last ${STALE_RUNS}+ runs: seisin walls ${role} --all)\n`);
  return list;
}
