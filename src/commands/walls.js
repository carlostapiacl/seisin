/** `seisin walls <role>` — what that role keeps being refused, and what it cost. */
import { walls, render } from "../walls.js";
import { logPath } from "../log.js";
import { out } from "../render.js";

export function wallsCommand(config, argv = []) {
  const role = argv[0];
  if (!role) throw new Error("usage: seisin walls <role> [--since <iso>] [--min <n>]");
  if (!config.roles[role])
    throw new Error(`unknown role "${role}". Known: ${Object.keys(config.roles).join(", ")}`);
  const at = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
  };
  const list = walls(config, role, {
    file: logPath(config.root),
    min: Number(at("--min", 2)),
    since: at("--since", null),
  });
  // Nothing to say prints nothing, the way `scan` does when a repo is clean.
  // A command that always speaks is one whose output stops being read.
  if (list.length) out(render(list));
  return list;
}
