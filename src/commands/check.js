/** `seisin check` — print the map and every way it does not hold. Runs nothing, unless `--verify`. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "../inspect.js";
import { renderReport, out, C } from "../render.js";

export function check(config, argv = []) {
  const role = argv.find((a) => !a.startsWith("-")) ?? null;
  const report = inspect(config, role, config.path);
  out(renderReport(report, { verbose: argv.includes("--verbose") }));
  if (argv.includes("--verify")) report.verify = verify(config, role);
  return report;
}

/**
 * `--verify`: each role's `verify` command, run inside that role's sandbox.
 *
 * Through `seisin run` itself and not a copy of its setup, so what passes here
 * is what the agent will get: the same settings, environment and PATH. With
 * `--agent none`, because the question is the toolchain, not the agent's home.
 * In the repo root, where a test command expects to start.
 *
 * The one thing `check` executes, which is why it is a flag: without it
 * `check` still runs nothing.
 */
function verify(config, only) {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const roles = Object.values(config.roles).filter((r) => (only ? r.name === only : true) && r.verify);
  const results = [];
  if (!roles.length) out(`\n${C.yellow}verify: no role ${only ? `"${only}" ` : ""}declares a verify command${C.off}\n`);
  for (const r of roles) {
    const res = spawnSync(process.execPath, [cli, "run", r.name, "--agent", "none", "--", ...r.verify], {
      cwd: config.root, encoding: "utf8", timeout: 300_000, env: process.env,
    });
    const ok = res.status === 0;
    results.push({ role: r.name, ok, status: res.status });
    const output = `${res.stderr ?? ""}${res.stdout ?? ""}`.trim().split("\n");
    const tail = output.slice(-20).join("\n    ");
    const denied = output.filter((line) => /denied|Operation not permitted|Permission denied|not readable/i.test(line));
    const suggestion = denied.some((line) => (r.reads ?? []).some((p) => line.includes(p)))
      ? "The command reached a declared reads path; check that the entry names the needed subtree and exists."
      : `If the missing path is data, add the narrow path to reads; if it is an interpreter, runtime or library, add its stack to toolchain${r.toolchain?.length ? ` (currently ${r.toolchain.join(", ")})` : ""}.`;
    out(`\n${ok ? C.green + "✓" : C.red + "✗"} verify ${r.name}${C.off}: ${r.verify.join(" ")}` +
      (ok ? "\n" : ` — exit ${res.status ?? res.signal}\n    ${tail}\n` +
        `  This role cannot run its own checks inside its sandbox. ${suggestion}\n`));
  }
  return results;
}
