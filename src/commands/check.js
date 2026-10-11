/** `seisin check` — print the map and every way it does not hold. Runs nothing, unless `--verify`. */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "../inspect.js";
import { renderReport, out, C } from "../render.js";

export async function check(config, argv = []) {
  if (argv.includes("--parallel") && !argv.includes("--verify"))
    throw new Error("--parallel is experimental and requires --verify");
  const role = argv.find((a) => !a.startsWith("-")) ?? null;
  const report = inspect(config, role, config.path);
  out(renderReport(report, { verbose: argv.includes("--verbose") }));
  if (argv.includes("--verify")) report.verify = await verify(config, role, argv.includes("--parallel"));
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
async function verify(config, only, parallel = false) {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const roles = Object.values(config.roles).filter((r) => (only ? r.name === only : true) && r.verify);
  const results = [];
  if (!roles.length) out(`\n${C.yellow}verify: no role ${only ? `"${only}" ` : ""}declares a verify command${C.off}\n`);
  const run = async (r) => {
    const res = parallel
      ? await runParallel(process.execPath, [cli, "run", r.name, "--agent", "none", "--", ...r.verify], config.root)
      : spawnSync(process.execPath, [cli, "run", r.name, "--agent", "none", "--", ...r.verify], {
        cwd: config.root, encoding: "utf8", timeout: 300_000, env: process.env,
      });
    const ok = res.status === 0;
    const result = { role: r.name, ok, status: res.status };
    const output = `${res.stderr ?? ""}${res.stdout ?? ""}`.trim().split("\n");
    const tail = output.slice(-20).join("\n    ");
    const denied = output.filter((line) => /denied|Operation not permitted|Permission denied|not readable/i.test(line));
    const suggestion = denied.some((line) => (r.reads ?? []).some((p) => line.includes(p)))
      ? "The command reached a declared reads path; check that the entry names the needed subtree and exists."
      : `If the missing path is data, add the narrow path to reads; if it is an interpreter, runtime or library, add its stack to toolchain${r.toolchain?.length ? ` (currently ${r.toolchain.join(", ")})` : ""}.`;
    out(`\n${ok ? C.green + "✓" : C.red + "✗"} verify ${r.name}${C.off}: ${r.verify.join(" ")}` +
      (ok ? "\n" : ` — exit ${res.status ?? res.signal}\n    ${tail}\n` +
        `  This role cannot run its own checks inside its sandbox. ${suggestion}\n`));
    return result;
  };
  if (parallel) {
    out(`\n${C.yellow}experimental: verify commands are running concurrently; shared builds, caches, ports, or generated files may race. Use plain --verify for serial checks.${C.off}\n`);
    results.push(...await Promise.all(roles.map(run)));
  } else {
    for (const r of roles) results.push(await run(r));
  }
  return results;
}

function runParallel(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = "", stderr = "", timedOut = false, forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    }, 300_000);
    child.stdout.setEncoding("utf8").on("data", (s) => { stdout += s; });
    child.stderr.setEncoding("utf8").on("data", (s) => { stderr += s; });
    child.on("error", (error) => {
      clearTimeout(timer); clearTimeout(forceTimer);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer); clearTimeout(forceTimer);
      resolve({ status: timedOut ? null : status, signal: timedOut ? "SIGTERM (timeout)" : signal, stdout, stderr });
    });
  });
}
