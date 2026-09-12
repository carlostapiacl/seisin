/**
 * `seisin run` — the whole point of the tool.
 *
 * Writes the role's sandbox settings, builds the child's environment from the
 * policy instead of inheriting it, wraps the command in the sandbox runtime,
 * and masks the role's own secrets on the way out.
 *
 * Everything in here is ordering that was wrong once. The comments say which.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsFor } from "../srt.js";
import { buildEnv } from "../env.js";
import { secretsOf, redactor } from "../redact.js";
import { STATE_DIR } from "../layout.js";
import { C, err } from "../render.js";
import { pending, requestsPath } from "../requests.js";
import { renderQueue } from "./requests.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The bundled runtime first, a global one second, and nothing third.
 *
 * There is deliberately no fallback to running unsandboxed. A permission tool
 * that quietly becomes a no-op when its enforcer is missing is worse than one
 * that refuses, because you keep trusting it.
 */
export function resolveSrt() {
  const bundled = join(HERE, "..", "..", "node_modules", ".bin", "srt");
  if (existsSync(bundled)) return bundled;

  // Walk PATH rather than asking a shell. `spawnSync(..., { shell: true })`
  // prints a deprecation warning on every single run — Node's DEP0190 — which
  // is a line of noise in front of every user for the sake of finding one file.
  // It is also the concatenation hazard the warning is about.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "srt");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Writes `.seisin/<role>.json` and returns its path. */
export function writeSettings(config, role) {
  const dir = join(config.root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.json`);
  writeFileSync(file, JSON.stringify(settingsFor(config, role), null, 2) + "\n");
  return file;
}

export function run(config, argv) {
  const split = argv.indexOf("--");
  const role = argv[0];
  const cmd = split === -1 ? argv.slice(1) : argv.slice(split + 1);
  if (!role || cmd.length === 0) throw new Error("usage: seisin run <role> -- <command...>");
  if (!config.roles[role])
    throw new Error(`unknown role "${role}". Known: ${Object.keys(config.roles).join(", ")}`);

  const settings = settingsFor(config, role);
  const file = writeSettings(config, role);

  const srt = resolveSrt();
  if (!srt) throw new Error("sandbox runtime not found. Install it with: npm i -g @anthropic-ai/sandbox-runtime");

  // The hook runs inside the child and has to know which role it is. These are
  // the only variables seisin injects, and none carries a secret.
  const observe = argv.includes("--observe");
  const { env, dropped } = buildEnv(process.env, config.roles[role]);
  env.SEISIN_ROLE = role;
  env.SEISIN_CONFIG = config.path;
  if (observe) env.SEISIN_OBSERVE = "1";
  if (argv.includes("--debug-env")) err(`${C.dim}seisin: dropped ${dropped.join(" ")}${C.off}\n`);

  err(
    `${C.dim}seisin: ${role} · writes ${settings.filesystem.allowWrite.length} path(s) · ` +
    `reads ${settings.filesystem.allowRead.length} key(s) · ` +
    `env ${Object.keys(env).length} kept, ${dropped.length} dropped` +
    `${observe ? " · OBSERVING, nothing denied" : ""}${C.off}\n`
  );

  // Redaction needs the output to pass through this process, and piping breaks
  // anything that draws its own screen. So it turns itself off on a terminal
  // and on for the runs that end up in a log, which is where a leaked key
  // actually survives. Say so rather than deciding it quietly.
  const wantRedact = config.redact !== false && config.roles[role].keys.length > 0;
  const canRedact = wantRedact && !process.stdout.isTTY;
  if (wantRedact && !canRedact) err(`${C.dim}seisin: redaction off — interactive terminal${C.off}\n`);

  const secrets = canRedact ? secretsOf(settings, readFileSync) : [];
  const outStream = secrets.length ? redactor(secrets) : null;
  const errStream = secrets.length ? redactor(secrets) : null;
  if (outStream) { outStream.pipe(process.stdout); errStream.pipe(process.stderr); }

  // `--` before the user's command, and it is not cosmetic. Without it the
  // sandbox's own argument parser reaches into what the agent was invoked with
  // and eats anything resembling one of its flags: `claude --settings`,
  // `claude -c`, `claude --debug`. Found by passing --settings to claude and
  // watching the sandbox reject it as its own malformed config.
  const child = spawn(srt, ["--settings", file, "--", ...cmd], {
    stdio: outStream ? ["inherit", "pipe", "pipe"] : "inherit",
    env,
  });
  if (outStream) { child.stdout.pipe(outStream); child.stderr.pipe(errStream); }

  // The exit code is the child's, and the output has to be all the way out
  // before we leave. Both halves were wrong once and neither was loud:
  //
  //   - Calling exit() the moment the child exits discards whatever is still in
  //     the redaction stream, so the command looks like it produced nothing.
  //   - Waiting for `finish` but subscribing AFTER end() misses the event when
  //     it fires synchronously, so nothing ever calls exit and the process
  //     drifts out of the event loop with status 0 — every failure reported as
  //     a success. A battery of seven sandbox tests came back green on that.
  //
  // Subscribe first, end second, and keep a real timer (not unref'd, or it
  // cannot save anything) as the floor.
  child.on("exit", (code, signal) => {
    const status = signal ? 1 : code ?? 0;
    // The notice rides on what you are already looking at. A queue nobody opens
    // is not human-in-the-loop, and this is the terminal that just showed you
    // the denial — so it goes to stderr, beside it, not into the agent's stdout
    // where a pipeline would swallow it.
    const queue = pending(requestsPath(config.root));
    if (queue.length) err(renderQueue(queue));
    if (!outStream) return process.exit(status);
    let left = 2;
    const guard = setTimeout(() => process.exit(status), 2000);
    const tick = () => { if (--left > 0) return; clearTimeout(guard); process.exit(status); };
    outStream.once("finish", tick);
    errStream.once("finish", tick);
    outStream.end();
    errStream.end();
  });
  child.on("error", (e) => { throw new Error(`could not start the sandbox: ${e.message}`); });
}
