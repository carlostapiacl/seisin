/** `seisin check` — print the map and every way it does not hold. Runs nothing. */
import { inspect } from "../inspect.js";
import { renderReport, out } from "../render.js";

export function check(config, argv = []) {
  const role = argv.find((a) => !a.startsWith("-")) ?? null;
  const report = inspect(config, role, config.path);
  out(renderReport(report, { verbose: argv.includes("--verbose") }));
  return report;
}
