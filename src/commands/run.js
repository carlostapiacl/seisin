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
import { finished } from "node:stream/promises";
import { constants as osConstants } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsFor, roleHome, loopbackVia, agentOf, AGENTS, AGENT_HOMES } from "../srt.js";
import { buildEnv } from "../env.js";
import { resolveKeys } from "../keys.js";
import { nestedSandboxWarning } from "../nested.js";
import { spool, SOCK_ENV } from "../spool.js";
import { openRun } from "../rundir.js";
import { secretsOf, redactor } from "../redact.js";
import { C, err } from "../render.js";
import { pending, requestsPath, withDeclarers } from "../requests.js";
import { notifier } from "../notify.js";
import { renderAdded } from "./requests.js";
import { unknownRole } from "../suggest.js";
import { watchDenials } from "../violations.js";
import { intake } from "../intake.js";
import { toolchainBins } from "../territory.js";
import { writePathsOf } from "../grants.js";
import { runCanary, CANARY_EXIT } from "../canary.js";
import { append, logPath } from "../log.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The ceiling on waiting for the kernel's last word when a run ends.
 *
 * A ceiling, not a delay: the drain resolves as soon as `log stream` stops
 * talking, which on a run with nothing pending is immediate. The number only
 * matters on a machine under enough load that the stream is behind, and there
 * a quarter second is cheaper than a denial that never made it into the record.
 */
const DRAIN_MS = 250;

/**
 * The runtime seisin depends on first, one on PATH second, and nothing third.
 *
 * "The one seisin depends on" is found the way Node finds a dependency — up
 * from this file, through every `node_modules` — not at one spelled-out path.
 * `<seisin>/node_modules/.bin/srt` is only where it lands in a checkout. In a
 * project that installs seisin as a dependency, npm hoists the runtime to the
 * project's own `node_modules`, and that path does not exist. Measured with
 * 0.5.0 packed and installed into a project: `npx seisin` still worked, because
 * npx puts the project's `.bin` on PATH; `./node_modules/.bin/seisin` and
 * `node node_modules/seisin/src/cli.js` did not — they said "not found", or,
 * with a global srt 0.0.75 installed, ran under THAT one instead of the 0.0.78
 * this version pins, with none of its fixes.
 *
 * There is deliberately no fallback to running unsandboxed. A permission tool
 * that quietly becomes a no-op when its enforcer is missing is worse than one
 * that refuses, because you keep trusting it.
 */
export function resolveSrt({ from = HERE, path = process.env.PATH } = {}) {
  const local = dependencySrt(from);
  if (local) return local;

  // Walk PATH rather than asking a shell. `spawnSync(..., { shell: true })`
  // prints a deprecation warning on every single run — Node's DEP0190 — which
  // is a line of noise in front of every user for the sake of finding one file.
  // It is also the concatenation hazard the warning is about.
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "srt");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const RUNTIME = "@anthropic-ai/sandbox-runtime";

/**
 * The `srt` of the sandbox-runtime that resolves from `from`, or null.
 *
 * The `.bin/srt` npm linked beside the package when there is one — that is the
 * file npm made executable — and otherwise the package's own `bin` entry.
 * The package's `package.json` is found by walking up rather than through
 * `require.resolve`, which a package's `exports` map is free to refuse.
 */
export function dependencySrt(from = HERE) {
  let dir = from;
  for (;;) {
    const nm = join(dir, "node_modules");
    const pkg = join(nm, RUNTIME, "package.json");
    if (existsSync(pkg)) {
      const linked = join(nm, ".bin", "srt");
      if (existsSync(linked)) return linked;
      try {
        const bin = JSON.parse(readFileSync(pkg, "utf8")).bin;
        const rel = typeof bin === "string" ? bin : bin?.srt;
        if (rel) {
          const target = join(nm, RUNTIME, rel);
          if (existsSync(target)) return target;
        }
      } catch { /* an unreadable package.json is not a runtime */ }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Which agent this run is: `--agent <name>` when given, else read off the
 * command. It decides whose home is scratch and whose sign-in is closed (see
 * AGENT_HOMES in grants.js). `--agent none` says "no agent", for a run that
 * must get neither home whatever its command looks like.
 */
export function agentFor(mine, cmd) {
  const at = mine.lastIndexOf("--agent");
  if (at === -1) return agentOf(cmd);
  const given = mine[at + 1];
  if (given === "none") return null;
  if (!AGENTS.includes(given))
    throw new Error(
      `--agent ${given ?? ""}: seisin knows ${AGENTS.join(", ")} and none.\n` +
      `  It decides whose home a run may write (${AGENTS.map((a) => AGENT_HOMES[a]).join(", ")}) ` +
      `and whose sign-in it cannot read.`);
  return given;
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
  let mine, cmd;
  if (split !== -1) {
    mine = argv.slice(1, split);
    cmd = argv.slice(split + 1);
  } else {
    // No `--`: seisin's own flags are the leading `-options` only. From the
    // first token that is not an option, everything is the command — its own
    // flags are its business. `seisin run x echo hi --observe` used to read
    // `--observe` as seisin's and put the run in observe mode; now that flag
    // belongs to `echo`, and observe needs `seisin run x --observe -- echo hi`.
    let i = 1;
    while (i < argv.length && argv[i].startsWith("-")) i += argv[i] === "--agent" ? 2 : 1;
    mine = argv.slice(1, i);
    cmd = argv.slice(i);
  }
  if (!role || cmd.length === 0) throw new Error("usage: seisin run <role> -- <command...>");
  if (!config.roles[role]) throw unknownRole(config, role);
  const agent = agentFor(mine, cmd);

  /**
   * seisin does not run inside seisin, and says so here rather than later.
   *
   * Measured in both directions, with the inner role both wider and narrower
   * than the outer one: the inner run dies in the runtime with rc=13 and a Node
   * warning about an unsettled await — no role named, no boundary named, and it
   * reads as seisin crashing rather than as a refusal. Before that it failed
   * even earlier, on a $TMPDIR the outer sandbox had already reshaped.
   *
   * This is the refusal, not a fix, because the shape it is usually reached for
   * is wrong anyway: a dispatcher that starts roles from inside one role's sandbox
   * makes every worker a descendant of the sandbox that should hold the least. Such
   * a dispatcher belongs above the roles and gets asked, rather than running
   * inside one of them.
   */
  const outer = process.env.SEISIN_ROLE;
  if (outer)
    throw new Error(
      `already inside a seisin sandbox as "${outer}" — seisin does not nest.\n` +
      `  Starting "${role}" from in here does not give it its own territory: the run dies in the\n` +
      `  sandbox runtime, and what territory a second sandbox would even hold is undefined.\n` +
      `  Run roles as siblings from outside instead. Something that needs to start roles belongs\n` +
      `  above them — asked by the role that wants the work done, not run inside it.`,
    );

  /**
   * The audit spool: this process holds the log and the queue, and the hook
   * inside the sandbox gets a socket instead of a directory. That is the whole
   * reason `.seisin/` is no longer in anybody's allowWrite — see spool.js.
   *
   * Entries arrive with their own `at` already set by the sender, so what lands
   * on disk is when the decision happened, not when the parent got around to it.
   */
  const observe = mine.includes("--observe");
  // Built before the first request can arrive; the POST leaves from here, the
  // parent, never from inside the sandbox (notify.js).
  const notify = notifier(config);
  // Everything that belongs to this run alone — socket, settings, scratch keys
  // — in one private directory, with one id. See rundir.js.
  const theRun = openRun();
  /**
   * From here on, every way out removes what this run made.
   *
   * The happy path closed the spool, the kernel watcher and the directory; the
   * failures did not. A key provider that failed, a spool that would not bind,
   * a runtime that would not start — each left the directory behind with its
   * socket and, past the key step, its `scratch` keys on disk until some later
   * run swept it, and the `log stream` process running. An `exit` handler,
   * because every one of those ends in `process.exit`, from cli.js or from here,
   * and everything it has to do is synchronous. Idempotent: the normal exit
   * below runs it first and the handler finds nothing left.
   */
  let audit = null;
  let denials = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { audit?.close(); } catch {}
    try { denials?.close(); } catch {}
    theRun.close();
  };
  process.once("exit", cleanup);
  // What was already waiting, so the end of the run can say what it added.
  const before = new Set(pending(requestsPath(config.root)).map((q) => q.key));
  const sockPath = theRun.sock;
  // The program, as the role's PATH will find it: `read = "territory"` keeps
  // that one file readable (territory.js). Same order run uses below — the
  // declared toolchain first, then the parent's PATH.
  const isDir = (d) => { try { return statSync(d).isDirectory(); } catch { return false; } };
  const searchPath = config.read === "territory"
    ? [...toolchainBins(config, config.roles[role], isDir), process.env.PATH ?? ""].join(delimiter)
    : process.env.PATH;
  const program = whichOn(cmd[0], searchPath);
  const settings = settingsFor(config, role, sockPath, observe, { agent, program });
  // Per run, never per role: `.seisin/<role>.json` was one file for every run
  // of that role, and two at once wrote each other's socket path into it.
  const file = theRun.writeSettings(settings);

  // What arrives from the hook and from the kernel, checked against the policy
  // this run started with and written with the run's id on it. See intake.js.
  const take = intake({ config, role, runId: theRun.id, observe, settings, notify });
  audit = await spool(take.fromHook, sockPath);

  const srt = resolveSrt();
  if (!srt) throw new Error(`sandbox runtime not found. ${installHint()}`);

  // The hook runs inside the child and has to know which role it is. These are
  // the only variables seisin injects, and none carries a secret.
  const { env, dropped } = buildEnv(process.env, config.roles[role]);
  env.SEISIN_ROLE = role;
  env.SEISIN_CONFIG = config.path;
  env[SOCK_ENV] = sockPath;
  /**
   * The declared toolchain goes first on PATH, under `read = "territory"`.
   *
   * Declaring `~/.venvs/api` and then having `python` resolve to whatever the
   * parent's PATH found first is not having the toolchain. Only in that mode:
   * under "all" the PATH is the parent's, as it has always been.
   */
  if (config.read === "territory") {
    const bins = toolchainBins(config, config.roles[role], isDir);
    if (bins.length) env.PATH = [...bins, ...(env.PATH ? [env.PATH] : [])].join(delimiter);
  }

  /**
   * Reference keys: resolved here, by the parent, before anything is spawned.
   *
   * The ordering is the security property, not a convenience. The provider
   * command holds the vault's own credential — the keychain prompt, the
   * 1Password session — and running it inside the sandbox would mean putting that
   * credential in there too, which is the thing this feature exists to avoid.
   * The confined side cannot reach the parent; the parent can reach the vault;
   * so the parent resolves and hands over the result.
   *
   * A failure here stops the run. Not an empty value, not the file of the same
   * name, not a skipped key: a role that starts without a credential it
   * declared fails later, somewhere else, looking like something it is not.
   */
  const resolved = resolveKeys(config, config.roles[role]);
  const scratchKeys = theRun.keys;
  if (resolved.some((r) => r.mode === "scratch")) mkdirSync(scratchKeys, { recursive: true, mode: 0o700 });
  for (const { entry, mode, value } of resolved) {
    if (mode === "env") { env[entry.name] = value; continue; }
    // `scratch`: the value lands in the per-run directory this process already
    // makes for the spool and already removes on exit, so its lifetime is the
    // run's by construction rather than by a cleanup somebody has to remember.
    // The variable carries the PATH, which is the convention every tool that
    // wants a secret from a file already reads (`_FILE`), and it means the
    // value itself is not in the environment of a process that may print it.
    const file = join(scratchKeys, entry.name);
    writeFileSync(file, value, { mode: 0o600 });
    /**
     * Both names, because the world has two conventions and neither is ours.
     *
     * `<NAME>_FILE` is the Docker-secrets shape, read by tools that normally
     * take the value in `<NAME>`. But a large family of tools already expects
     * a PATH in the plain variable — `KUBECONFIG`,
     * `GOOGLE_APPLICATION_CREDENTIALS`, `AWS_SHARED_CREDENTIALS_FILE` — and
     * for those, `KUBECONFIG_FILE` is a name nothing reads.
     *
     * Found by running `kubectl` against it rather than reasoning about it:
     * the file was there and correct, and the variable it was announced under
     * was one kubectl has never heard of.
     *
     * Setting both costs nothing and leaks nothing: in `scratch` mode the
     * value is deliberately not in the environment, so both variables hold a
     * path and neither holds a secret.
     */
    env[entry.name] = file;
    env[`${entry.name}_FILE`] = file;
  }

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
  // Only the `home` level moves HOME. `credentials` closes the places
  // credentials live and leaves the home where it is — which is what keeps the
  // agent logged in, since on macOS its credential is in the login keychain and
  // the keychain is found through HOME.
  if (config.isolate === "home" || config.isolate === true) {
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
    // zsh writes its heredocs to $TMPPREFIX, not $TMPDIR, and defaults it to
    // /tmp/zsh — which the role cannot write. Every heredoc in every zsh script
    // failed with the role's own tmp a directory away (measured by an orchestrator running zsh scripts).
    env.TMPPREFIX = join(home, "tmp", "zsh");
  }
  if (observe) env.SEISIN_OBSERVE = "1";
  if (mine.includes("--debug-env")) err(`${C.dim}seisin: dropped ${dropped.join(" ")}${C.off}\n`);

  /**
   * A command the role cannot find, said as that — before the sandbox starts.
   *
   * It used to reach the runtime, which runs it through `env`, and the only
   * word on screen was `env: nosuchcmd: No such file or directory`: seisin's
   * own wrapper named as the thing that failed. 127, the shell's code for it.
   */
  if (!onPath(cmd[0], env.PATH)) {
    const e = new Error(`"${cmd[0]}" not found on the role's PATH`);
    e.exitCode = 127;
    throw e;
  }

  // What the role gets, in the policy's own words: `writes 8 path(s)` counted
  // the runtime's scratch directories as territory and named none of it.
  const r = config.roles[role];
  const territory = observe ? "the whole repo" : r.writes.length ? r.writes.join(" ") : "nothing";
  const scratch = settings.filesystem.allowWrite.length - (observe ? 1 : r.writes.length);
  err(
    `${C.dim}seisin: ${role} · writes ${territory}${scratch > 0 ? ` (+${scratch} scratch)` : ""} · ` +
    `keys ${r.keys.length ? r.keys.join(" ") : "none"} · ` +
    `${agent ? `runs ${agent}` : "runs no agent seisin knows"} · ` +
    `env ${Object.keys(env).length} kept, ${dropped.length} dropped · read ${config.read}` +
    `${observe ? ` · ${C.yellow}OBSERVING — the repo is writable, the network is NOT${C.off}${C.dim}` : ""}${C.off}\n`
  );

  // Redaction needs the output to pass through this process, and piping breaks
  // anything that draws its own screen. So it turns itself off on a terminal
  // and on for the runs that end up in a log, which is where a leaked key
  // actually survives. Say so rather than deciding it quietly.
  const wantRedact = config.redact !== false && config.roles[role].keys.length > 0;
  const canRedact = wantRedact && !process.stdout.isTTY;
  if (wantRedact && !canRedact) err(`${C.dim}seisin: redaction off — interactive terminal${C.off}\n`);

  // Resolved references are masked alongside the key files. They never touched
  // the disk under a path `secretsOf` could find, so without this the one kind
  // of key that is supposed to be better looked after would be the one kind
  // that sails through the redactor into a log.
  const secrets = canRedact
    ? [...secretsOf(settings, readFileSync), ...resolved.map((r) => r.value)]
        .filter((v) => v.length >= 8)
        .sort((a, b) => b.length - a.length)
    : [];
  const outStream = secrets.length ? redactor(secrets) : null;
  const errStream = secrets.length ? redactor(secrets) : null;
  if (outStream) { outStream.pipe(process.stdout); errStream.pipe(process.stderr); }

  // `--` before the user's command, and it is not cosmetic. Without it the
  // sandbox's own argument parser reaches into what the agent was invoked with
  // and eats anything resembling one of its flags: `claude --settings`,
  // `claude -c`, `claude --debug`. Found by passing --settings to claude and
  // watching the sandbox reject it as its own malformed config.
  /**
   * The kernel's own denials, alongside the hook's.
   *
   * Started BEFORE the spawn, and that ordering is the whole difference between
   * this working and this recording nothing. `log stream` is a separate process
   * with its own startup; a `sh -c` that gets denied is over in single-digit
   * milliseconds. Started after the spawn, the first version of this caught
   * zero denials on exactly the short commands an agent runs most.
   *
   * Attribution still needs the child's pid, so it is handed over the moment
   * there is one — `attributeTo` below — and anything that arrived in between is
   * held and re-examined rather than credited to this role on faith.
   *
   * What each denial becomes — a log line, a request, or a count — is decided
   * in intake.js, beside the hook's lines: the kernel is the thing that
   * actually denied, so when the two disagree, it is the one that is right.
   */
  // What actually runs inside the sandbox, computed once and used by both ends. The
  // watcher recognises a denial by comparing the runtime's command tag with this
  // argv; handed `cmd` while `srt` was handed `env NO_PROXY=… cmd`, it recognised
  // nothing for a role with `local_ports`, and every short denial of those roles
  // — writes included — left no line (measured: 0 of 5, and 5 of 5 without the key).
  //
  // And a nonce in front, because the tag alone does not tell runs apart: an
  // orchestrator starts several roles with the SAME command, the kernel tags
  // each denial with that command, and every watcher listening recognised it
  // as its own. One write outside territory became one line per role running,
  // one request per role, and a denial logged against the role that owns the
  // path (measured: 3 lines and 3 requests for one write by one of 3 roles).
  // The nonce makes each run's command unique, so the tag names one run.
  /**
   * Linux, `read = "territory"`: the runtime's own temp directory moves into
   * this run's, and the agent gets its TMPDIR back.
   *
   * sandbox-runtime makes the sockets its in-sandbox bridge reaches the proxy
   * through in `os.tmpdir()` — of the runtime's process. With /tmp a data root
   * and denied, the bridge found nothing and the whole network died in
   * silence: every allowed host and `local_ports` refused like the rest
   * (measured in Docker, Debian 12, bwrap 0.8.0). The run's directory is
   * already readable from inside, so the sockets go there; the `env` the
   * command runs through puts the agent's TMPDIR back as it was.
   */
  const agentTmp = env.TMPDIR;
  const restoreTmp = [];
  if (process.platform === "linux" && config.read === "territory") {
    const srtTmp = join(theRun.dir, "srt");
    mkdirSync(srtTmp, { recursive: true, mode: 0o700 });
    env.TMPDIR = srtTmp;
    restoreTmp.push(...(agentTmp ? [`TMPDIR=${agentTmp}`] : ["-u", "TMPDIR"]));
  }

  /**
   * The canary, before anything of the agent's starts — and before the kernel
   * watcher below, so its own denials are not recorded as the agent's. See
   * canary.js. A failure stops the run with its own exit code and a line in
   * the log; there is no flag to skip it.
   */
  const probe = await runCanary({
    srt, settingsFile: file, settings, env, cwd: process.cwd(),
    runDir: theRun.dir, runsRoot: theRun.root, role: config.roles[role],
    granted: writePathsOf(config, config.roles[role], { observe, agent }),
  });
  if (!probe.ok) {
    append(logPath(config.root), {
      event: "canary", role, run: theRun.id.slice(0, 8), confined: false, reasons: probe.failed,
    });
    err(`${C.red}seisin: ${role} was NOT started — the sandbox failed its canary:${C.off}\n` +
      probe.failed.map((f) => `  - ${f}\n`).join("") +
      `  The policy as generated does not hold on this machine, so no agent runs under it. ` +
      `This is recorded in the log (confined=false). Exit 86 means the boundary did not hold; ` +
      `run seisin check, fix the reported policy or machine setup, and try again. There is no flag to skip it.\n`);
    process.exit(CANARY_EXIT);
  }
  append(logPath(config.root), {
    event: "canary", role, run: theRun.id.slice(0, 8), confined: true, reasons: [],
  });

  const boxed = ["env", ...restoreTmp, `SEISIN_RUN_ID=${theRun.id}`, ...loopbackVia(config.roles[role], cmd)];
  denials = watchDenials(take.fromKernel, { argv: boxed });

  // Deliberately NOT announced here. On Linux this branch is taken every time,
  // so saying it per run puts a line the reader cannot act on in front of every
  // command they type — and a notice that appears five hundred times is one
  // nobody reads the five hundred and first. It is a standing property of the
  // platform, so it belongs with the other standing limits, in `seisin check`.
  void denials.available;

  /**
   * An agent that sandboxes itself has to be told about, before it starts.
   *
   * Said here and not by `check`, because `check` never sees the command. And
   * said rather than fixed: passing somebody's bypass flag for them is exactly
   * the kind of quiet widening this tool exists to refuse.
   */
  const nested = nestedSandboxWarning(cmd);
  if (nested) err(`${C.yellow}seisin: ${nested}${C.off}\n`);

  const child = spawn(srt, ["--settings", file, "--", ...boxed], {
    stdio: outStream ? ["inherit", "pipe", "pipe"] : "inherit",
    env,
  });
  denials.attributeTo(child.pid);

  /**
   * Signals: seisin must not die of one, and must not double one.
   *
   * Without handlers Node dies on SIGTERM and SIGINT at once: the agent kept
   * running with nobody holding its audit channel, and the run's directory
   * stayed behind (74 had piled up on one machine). An orchestrator's timeout
   * is a SIGTERM to seisin's pid alone, so SIGTERM and SIGHUP are passed on,
   * and the run exits 128 + the signal — the runtime itself ends 0 when told
   * to stop, which reported success for a killed run.
   *
   * SIGINT is NOT passed on. It comes from the terminal, which sends it to the
   * whole foreground group: the runtime gets it too and forwards it to the
   * agent. Measured with one Ctrl-C: the agent received 2 SIGINTs before any
   * of this (the runtime already duplicates), and 3 when seisin forwarded as
   * well — and two in a row is how Claude Code tells "cancel" from "quit". So
   * seisin only stops dying of it.
   *
   * And an interrupted run is never reported as a success. The runtime exits 0
   * whenever its child dies of a signal (measured: SIGINT and SIGTERM, to the
   * group or to its pid, all 0), so from here "the agent caught the Ctrl-C and
   * finished" and "the agent was killed by it" look the same. The run exits
   * 130 in both until the runtime passes the status through; the other choice
   * reports a killed run as done, which is the one an orchestrator acts on.
   */
  let stoppedBy = null;
  let interrupted = false;
  process.on("SIGINT", () => { interrupted = true; });
  for (const sig of ["SIGTERM", "SIGHUP"])
    process.on(sig, () => { stoppedBy ??= sig; try { child.kill(sig); } catch {} });
  if (outStream) { child.stdout.pipe(outStream); child.stderr.pipe(errStream); }

  // The exit code is the child's, and the output has to be all the way out
  // before we leave. Both halves were wrong once and neither was loud:
  //
  //   - Calling exit() the moment the child exits discards whatever is still in
  //     the redaction stream, so the command looks like it produced nothing.
  //   - Waiting for `finish` but subscribing AFTER it fired left nothing to call
  //     exit: first the process drifted out with status 0 (every failure
  //     reported as a success), later the 2-second guard below caught it and
  //     every keyed run paid two seconds. `finished()` has no such window.
  //
  // Keep a real timer (not unref'd, or it cannot save anything) as the ceiling.
  /**
   * The status is worked out when the run is about to leave, not when the
   * child exits. A Ctrl-C reaches the runtime and seisin at once; when the
   * runtime is quicker, the child's `exit` is handled before seisin's own
   * SIGINT, `interrupted` is still false, and an interrupted run left with 0.
   * Seen once in a full suite run under load; by the end of the drains below
   * the pending signal has been handled.
   */
  // A runtime that itself dies of a signal (SIGKILL, the OOM killer) exits
  // the shell's way, 128 + n, the same as a run seisin was told to stop — it
  // was reported as 1, a plain failure, which hides that it was killed.
  const statusOf = (code, signal) => stoppedBy ? 128 + osConstants.signals[stoppedBy]
    : signal ? 128 + (osConstants.signals[signal] ?? 0)
    : interrupted && !code ? 130
    : code ?? 0;

  child.on("exit", async (code, signal) => {
    // The notice rides on what you are already looking at. A queue nobody opens
    // is not human-in-the-loop, and this is the terminal that just showed you
    // the denial — so it goes to stderr, beside it, not into the agent's stdout
    // where a pipeline would swallow it.
    // Close the spool before reading the queue: a line the hook sent on the
    // agent's last turn may still be in flight, and reporting a queue that is
    // one entry behind is how a request goes unnoticed for a day.
    audit.close();
    // Same reason, one layer further out: the kernel writes its line through a
    // separate process, so the last denial of a run can still be in flight
    // here. This is the only wait the mechanism adds and it is per run — it
    // returns as soon as the stream goes quiet, so a run that was denied
    // nothing pays a tick.
    await denials.close({ drain: DRAIN_MS });
    // The run made this directory, so the run removes it.
    cleanup();

    // Say what was dropped rather than only what was kept. A filter nobody can
    // see is indistinguishable from a monitor that is not working, and this one
    // drops the majority of what the kernel says on a busy run.
    // Only when something was actually recorded. A run where every denial was
    // filtered out has nothing to contextualise, and `0 recorded, 1 outside the
    // policy's paths` is a line that answers a question nobody asked — the
    // counts exist to explain a filter, not to announce that one ran.
    const { attributed } = denials.stats;
    const { offPolicy, walks } = take.stats;
    const recorded = attributed - offPolicy - walks;
    if (recorded > 0)
      err(`${C.dim}seisin: ${recorded} kernel denial(s) recorded` +
          `${walks ? `, ${walks} directory scan(s)` : ""}` +
          `${offPolicy ? `, ${offPolicy} outside the policy's paths` : ""}${C.off}\n`);

    // Only what this run added, with the numbers `grant` takes, and one line
    // for the rest. The whole queue after every run buried the new request
    // under the ones already seen; nothing new, nothing said.
    const queue = withDeclarers(config, pending(requestsPath(config.root), { keyDirs: config.keyDirs }));
    const added = queue.map((q, i) => ({ ...q, n: i + 1 })).filter((q) => !before.has(q.key));
    if (added.length) err(renderAdded(added, queue.length - added.length));
    const failed = await notify.settle();
    if (failed.length) err(`${C.yellow}seisin: could not notify about a new request (${failed[0]})${C.off}\n`);
    // One more turn of the loop, so a signal that arrived with the child's exit
    // has run its handler before the status is decided.
    await new Promise((r) => setImmediate(r));
    const status = statusOf(code, signal);
    if (!outStream) return process.exit(status);
    // `finished()` and not `once("finish")`, because the event is usually over
    // before this line runs: `child.stdout.pipe(outStream)` ends the redactor
    // itself when the child's stdout closes, so the listener was attached to an
    // event that had already fired and the 2-second guard was the only way out.
    // Every run with a key paid it — measured 3.0 s against 1.2 s without keys.
    // `finished()` settles at once for a stream that is already done.
    const guard = setTimeout(() => process.exit(status), 2000);
    // A child's exit is not its pipes' EOF. Let pipe() end the redactors
    // after the remaining stdout/stderr arrives; ending them here lost that
    // output. The guard still bounds a descendant that keeps a pipe open.
    await Promise.all([finished(outStream), finished(errStream)]).catch(() => {});
    clearTimeout(guard);
    process.exit(status);
  });
  // Not a `throw`: in a listener it is an uncaught exception — exit 1, a
  // stack trace, and none of the cleanup. Said the way cli.js says any other
  // failure, with its code; the `exit` handler above removes the run.
  child.on("error", (e) => {
    err(`${C.red}seisin:${C.off} could not start the sandbox: ${e.message}\n`);
    process.exit(2);
  });
}

/** Is `name` a program the role can start with this PATH? */
/** Where `name` resolves on `path`, absolute, or null. */
function whichOn(name, path) {
  if (!name) return null;
  if (name.includes("/")) return existsSync(name) ? resolve(name) : null;
  for (const d of (path ?? "").split(delimiter)) if (d && existsSync(join(d, name))) return join(d, name);
  return null;
}

function onPath(name, path) {
  if (!name) return false;
  if (name.includes("/")) return existsSync(name);
  return (path ?? "").split(delimiter).some((d) => d && existsSync(join(d, name)));
}

/**
 * How to put the runtime back, for the way this seisin was installed.
 *
 * It is a dependency, so it is missing only from a broken install — and the
 * fix differs: a project's own node_modules, a global install, or a checkout.
 * `npm i -g` was suggested to everyone, which for a project-local seisin
 * installs a second runtime somewhere seisin does not look first.
 */
export function installHint(from = HERE) {
  const at = from.split("/node_modules/seisin/")[0];
  if (at === from) return `Install it in this checkout with: npm install (in ${dirname(dirname(from))})`;
  // npm's global layout is <prefix>/lib/node_modules on unix, …/npm/node_modules on Windows.
  if (/\/lib$/.test(at) || /[\\/]npm$/.test(at))
    return "seisin is installed globally; reinstall it with: npm install -g seisin";
  return `seisin is installed in ${at}; reinstall it there with: npm install seisin`;
}
