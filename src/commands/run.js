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
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsFor, roleHome } from "../srt.js";
import { buildEnv } from "../env.js";
import { spool, spoolPath, SOCK_ENV } from "../spool.js";
import { secretsOf, redactor } from "../redact.js";
import { STATE_DIR } from "../layout.js";
import { C, err } from "../render.js";
import { pending, record, requestsPath } from "../requests.js";
import { ownersOf } from "../owners.js";
import { append, logPath } from "../log.js";
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
export function writeSettings(config, role, sock = null, observe = false) {
  const dir = join(config.root, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.json`);
  writeFileSync(file, JSON.stringify(settingsFor(config, role, sock, observe), null, 2) + "\n");
  return file;
}

export async function run(config, argv) {
  /**
   * Ours before the `--`, theirs after it.
   *
   * `argv.includes("--observe")` scanned the whole line, so `seisin run x --
   * claude --observe` put seisin into observe mode over a flag that belonged to
   * the agent. It is the same mistake the `--` separator was added to stop srt
   * making with the agent's flags, made one layer up.
   */
  const split = argv.indexOf("--");
  const role = argv[0];
  const mine = split === -1 ? argv.slice(1) : argv.slice(1, split);
  const cmd = split === -1 ? argv.slice(1) : argv.slice(split + 1);
  if (!role || cmd.length === 0) throw new Error("usage: seisin run <role> -- <command...>");
  if (!config.roles[role])
    throw new Error(`unknown role "${role}". Known: ${Object.keys(config.roles).join(", ")}`);

  /**
   * The audit spool: this process holds the log and the queue, and the hook
   * inside the box gets a socket instead of a directory. That is the whole
   * reason `.seisin/` is no longer in anybody's allowWrite — see spool.js.
   *
   * Entries arrive with their own `at` already set by the sender, so what lands
   * on disk is when the decision happened, not when the parent got around to it.
   */
  const observe = mine.includes("--observe");
  const sockPath = spoolPath();
  const audit = await spool((to, entry) => {
    /**
     * Nothing from inside the box is taken at its word.
     *
     * The sender is the process being recorded, so every field it supplies is
     * a claim. Two of them matter. `role` decides whose request this is — left
     * alone, a frontend agent could file one as backend and wait for a human to
     * approve it. `owners` decides who the queue says it belongs to, and the
     * parent can work that out itself from the policy.
     *
     * So the role is overwritten with the role of this run, the owners are
     * recomputed, and anything shaped wrong is dropped. Forging a *log* line is
     * noise. Forging a *request* is a sentence placed in front of a person for
     * approval, and that is a different thing entirely.
     */
    if (!entry || typeof entry !== "object") return;

    if (to === "log") {
      // The same treatment the queue already got. The role was overwritten but
      // everything else was passed through, so a process inside the box could
      // write "allowed" lines for paths it never touched — which would not move
      // the boundary, but would move `review`, and `init --from-observations`
      // builds a policy out of exactly this.
      if (entry.action !== "read" && entry.action !== "write") return;
      if (!["allowed", "denied", "observed"].includes(entry.verdict)) return;
      if (typeof entry.target !== "string" || !entry.target.trim()) return;
      return void append(logPath(config.root), {
        at: entry.at,
        role,
        tool: String(entry.tool ?? "").slice(0, 40),
        action: entry.action,
        kind: entry.kind === "key" ? "key" : "file",
        target: entry.target.slice(0, 1000),
        verdict: entry.verdict,
        owners: ownersOf(config, entry.target),      // recomputed, never taken
        reason: String(entry.reason ?? "").slice(0, 500),
      });
    }

    if (entry.action !== "read" && entry.action !== "write") return;
    if (typeof entry.target !== "string" || !entry.target.trim()) return;
    record(requestsPath(config.root), {
      role,
      action: entry.action,
      target: entry.target,
      owners: ownersOf(config, entry.target),
    });
  }, sockPath);

  const settings = settingsFor(config, role, sockPath, observe);
  const file = writeSettings(config, role, sockPath, observe);

  const srt = resolveSrt();
  if (!srt) throw new Error("sandbox runtime not found. Install it with: npm i -g @anthropic-ai/sandbox-runtime");

  // The hook runs inside the child and has to know which role it is. These are
  // the only variables seisin injects, and none carries a secret.
  const { env, dropped } = buildEnv(process.env, config.roles[role]);
  env.SEISIN_ROLE = role;
  env.SEISIN_CONFIG = config.path;
  env[SOCK_ENV] = sockPath;

  /**
   * Isolated mode: point the toolchain at a home of this role's own.
   *
   * Granting `~/.claude` to every role is what made "its own folders" only
   * true of the repo. A CLI that keeps session state — or a token — under the
   * real home put it somewhere every other role could read and write.
   *
   * The XDG variables are set as well as HOME, because a tool that reads
   * `XDG_CACHE_HOME` directly would otherwise still land in the real one, and
   * that failure is silent: the run works and the isolation does not.
   */
  if (config.isolate) {
    const home = roleHome(config, role);
    for (const d of [home, join(home, ".config"), join(home, ".local", "share"),
                     join(home, ".local", "state"), join(home, ".cache"), join(home, "tmp")])
      mkdirSync(d, { recursive: true });
    env.HOME = home;
    env.XDG_CONFIG_HOME = join(home, ".config");
    env.XDG_DATA_HOME = join(home, ".local", "share");
    env.XDG_STATE_HOME = join(home, ".local", "state");
    env.XDG_CACHE_HOME = join(home, ".cache");
    env.TMPDIR = join(home, "tmp");
  }
  if (observe) env.SEISIN_OBSERVE = "1";
  if (mine.includes("--debug-env")) err(`${C.dim}seisin: dropped ${dropped.join(" ")}${C.off}\n`);

  err(
    `${C.dim}seisin: ${role} · writes ${settings.filesystem.allowWrite.length} path(s) · ` +
    `reads ${settings.filesystem.allowRead.length} key(s) · ` +
    `env ${Object.keys(env).length} kept, ${dropped.length} dropped` +
    `${observe ? ` · ${C.yellow}OBSERVING — the whole repo is writable${C.off}${C.dim}` : ""}${C.off}\n`
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
    // Close the spool before reading the queue: a line the hook sent on the
    // agent's last turn may still be in flight, and reporting a queue that is
    // one entry behind is how a request goes unnoticed for a day.
    audit.close();
    // The run made this directory, so the run removes it.
    try { rmSync(dirname(sockPath), { recursive: true, force: true }); } catch {}

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
