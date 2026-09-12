/** `seisin check` — print the map and every way it does not hold. Runs nothing. */
import { inspect } from "../inspect.js";
import { renderReport, out } from "../render.js";

export function check(config, argv = []) {
  const report = inspect(config, argv[0] ?? null, config.path);
  out(renderReport(report));
  return report;
}
