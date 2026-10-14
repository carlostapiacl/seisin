/** `seisin check` — print the map and every way it does not hold. Runs nothing, unless `--verify`. */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "../inspect.js";
import { renderReport, out, C } from "../render.js";
import { measureSystemLog } from "../violations.js";
import { join } from "node:path";
import { settingsFor } from "../srt.js";
import { weigh } from "../sandboxes/index.js";
import { runsRoot } from "../rundir.js";
import { channelName } from "../spool.js";

export async function check(config, argv = []) {
  if (argv.includes("--parallel") && !argv.includes("--verify"))
    throw new Error("--parallel is experimental and requires --verify");
  const role = argv.find((a) => !a.startsWith("-")) ?? null;
  const report = inspect(config, role, config.path);
  out(renderReport(report, { verbose: argv.includes("--verbose") }));
  if (config.sandbox?.provider) report.sandboxes = sandboxes(config, role);
  if (argv.includes("--verify")) report.verify = await verify(config, role, argv.includes("--parallel"));
  if (argv.includes("--system-log")) report.systemLog = await systemLog();
  return report;
}

/**
 * `--system-log`: is the log a run reads denials from dropping messages now?
 *
 * A flooded unified log loses lines before they are filtered, and a kernel
 * denial lost there files nothing: the run says so afterwards, and this says
 * it before, with who is writing the most — the only lead to a fix. A flag,
 * because it takes seconds and `check` otherwise answers at once.
 */
async function systemLog() {
  const m = await measureSystemLog({ seconds: SYSTEM_LOG_SECONDS });
  if (!m.available) {
    out(`\n${C.dim}system log: not measured — ${m.reason}${C.off}\n`);
    return m;
  }
  const top = m.top.map((t) => `${t.who} ${t.perSecond}/s`).join(", ");
  out(m.dropped
    ? `\n${C.yellow}⚠ system log: ${m.dropped} batch(es) of messages dropped in ${m.seconds} s — kernel denials can go unrecorded now.${C.off}\n` +
      `  ${m.perSecond} messages/s; most from ${top}. Stop or quiet the busiest writer, then measure again.\n`
    : `\n${C.green}✓${C.off} system log: nothing dropped in ${m.seconds} s (${m.perSecond} messages/s; most from ${top})\n`);
  return m;
}

const SYSTEM_LOG_SECONDS = 3;

/**
 * `[sandbox] provider`: which sandbox each role would get, and why the others not.
 *
 * Said before anything starts, because the alternative is finding out at
 * `seisin run` that a role cannot be held by the sandbox the config asked for.
 * The settings are the ones a run would build, down to a channel in the runs
 * root, so a sandbox that cannot re-open this run's directory is caught here
 * too. Printed only when `[sandbox] provider` is set: without it every role
 * runs under srt, as it always has, and there is nothing to choose.
 */
export function sandboxes(config, only = null, { platform = process.platform } = {}) {
  const sock = join(runsRoot(), "check", channelName(platform));
  const rows = [];
  out(`\n${C.b}sandboxes${C.off} (${config.sandbox.provider.join(" → ")})\n`);
  for (const r of Object.values(config.roles)) {
    if (only && r.name !== only) continue;
    let settings;
    try { settings = settingsFor(config, r.name, sock); } catch (e) { rows.push({ role: r.name, chosen: null, error: e.message }); continue; }
    const { chosen, options } = weigh(config, settings, { platform, role: r.name });
    rows.push({ role: r.name, chosen: chosen?.sandbox.name ?? null,
      options: options.map((o) => ({ name: o.sandbox.name, missing: o.missing, unmet: o.unmet, warnings: o.warnings })) });
    out(chosen ? `  ${C.green}✓${C.off} ${r.name}: ${chosen.sandbox.name}\n` : `  ${C.red}✗${C.off} ${r.name}: no sandbox can hold it\n`);
    // Held, but not the way the role may expect: the sandbox's own words.
    for (const w of chosen?.warnings ?? []) out(`      ${C.yellow}⚠ ${chosen.sandbox.name}: ${w}${C.off}\n`);
    // Recorded nowhere otherwise: a run under it would still be held, and say nothing of what it refused.
    if (chosen && !chosen.sandbox.tagsDenials && platform === "darwin")
      out(`      ${C.yellow}⚠ ${chosen.sandbox.name} does not tag its denials, so the kernel's refusals under it are not recorded${C.off}\n`);
    for (const o of options) {
      if (o === chosen) break;
      if (o.missing) out(`      ${o.sandbox.name}: ${o.missing}\n`);
      else for (const u of o.unmet) out(`      ${o.sandbox.name}: ${u}\n`);
    }
  }
  return rows;
}

/**
 * The exit status: 1 when a role cannot be enforced as written, or when what a
 * flag asked for failed. `--system-log` is asked for like `--verify` and fails
 * the same way — a log dropping messages now is a run that would lose denials
 * now, and a CI step has only the status to go on.
 */
export function checkStatus(report) {
  return report.warnings.some((w) => w.kind === "cannot-be-enforced") || report.verify?.some((v) => !v.ok) ||
    report.sandboxes?.some((s) => !s.chosen) ||
    report.systemLog?.dropped > 0 ? 1 : 0;
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
