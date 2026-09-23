/**
 * `seisin run` — the whole point of the tool.
 *
 * Writes the role's sandbox settings, builds the child's environment from the
 * policy instead of inheriting it, wraps the command in the sandbox runtime,
 * and masks the role's own secrets on the way out.
 *
 * Everything in here is ordering that was wrong once. The comments say which.
 */
import { toRepoRelative } from "../paths.js";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { settingsFor, roleHome } from "../srt.js";
import { buildEnv } from "../env.js";
import { resolveKeys } from "../keys.js";
import { nestedSandboxWarning } from "../nested.js";
import { spool, spoolPath, SOCK_ENV } from "../spool.js";
import { secretsOf, redactor } from "../redact.js";
import { STATE_DIR } from "../layout.js";
import { C, err } from "../render.js";
import { pending, record, requestsPath } from "../requests.js";
import { ownersOf, explain } from "../owners.js";
import { append, logPath } from "../log.js";
import { renderQueue } from "./requests.js";
import { watchDenials, inScope, scopeOf, reachedForContent } from "../violations.js";

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
   * seisin does not run inside seisin, and says so here rather than later.
   *
   * Measured in both directions, with the inner role both wider and narrower
   * than the outer one: the inner run dies in the runtime with rc=13 and a Node
   * warning about an unsettled await — no role named, no boundary named, and it
   * reads as seisin crashing rather than as a refusal. Before that it failed
   * even earlier, on a $TMPDIR the outer box had already reshaped.
   *
   * This is the refusal, not a fix, because the shape it is usually reached for
   * is wrong anyway: a dispatcher that starts roles from inside one role's box
   * makes every worker a descendant of the box that should hold the least. Such
   * a dispatcher belongs above the roles and gets asked, rather than running
   * inside one of them.
   */
  const outer = process.env.SEISIN_ROLE;
  if (outer)
    throw new Error(
      `already inside the box as "${outer}" — seisin does not nest.\n` +
      `  Starting "${role}" from in here does not give it its own territory: the run dies in the\n` +
      `  sandbox runtime, and what territory a second box would even hold is undefined.\n` +
      `  Run roles as siblings from outside instead. Something that needs to start roles belongs\n` +
      `  above them — asked by the role that wants the work done, not run inside it.`,
    );

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

    /**
     * The policy has to actually refuse it, or it does not belong in a queue.
     *
     * Nothing checked. A process inside the box could file a request for a path
     * its own role already owns, and the queue would print *first refused on
     * …* about something that was never refused — a sentence placed in front of
     * a person for approval, describing an event that did not happen.
     *
     * Same treatment as `owners` one branch up: the claim is recomputed here
     * rather than believed. It is the policy answering a question about itself,
     * which is arithmetic, and it is the parent asking — the one process the
     * confined side cannot reach.
     *
     * This does not require the agent to have *tried*. Asking for a permission
     * before reaching for it is a reasonable thing to do, and the wording says
     * "asked" rather than "refused" for exactly that case. What it rules out is
     * a request for something that is not refused at all.
     */
    // Nor for a `never_writes` path: that refusal is the policy, written on
    // purpose, and granting it is undoing a subtraction without deciding to.
    const v = explain(config, role, entry.action, entry.target);
    if (v.allowed || v.neverWrites) return;

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
   * Reference keys: resolved here, by the parent, before anything is spawned.
   *
   * The ordering is the security property, not a convenience. The provider
   * command holds the vault's own credential — the keychain prompt, the
   * 1Password session — and running it inside the box would mean putting that
   * credential in there too, which is the thing this feature exists to avoid.
   * The confined side cannot reach the parent; the parent can reach the vault;
   * so the parent resolves and hands over the result.
   *
   * A failure here stops the run. Not an empty value, not the file of the same
   * name, not a skipped key: a role that starts without a credential it
   * declared fails later, somewhere else, looking like something it is not.
   */
  const resolved = resolveKeys(config, config.roles[role]);
  const scratchKeys = join(dirname(sockPath), "keys");
  if (resolved.some((r) => r.mode === "scratch")) mkdirSync(scratchKeys, { recursive: true, mode: 0o700 });
  for (const { entry, mode, value } of resolved) {
    if (mode === "env") { env[entry.name] = value; continue; }
    // `scratch`: the value lands in the per-run directory this process already
    // makes for the spool and already removes on exit, so its lifetime is the
    // turn's by construction rather than by a cleanup somebody has to remember.
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
  }
  if (observe) env.SEISIN_OBSERVE = "1";
  if (mine.includes("--debug-env")) err(`${C.dim}seisin: dropped ${dropped.join(" ")}${C.off}\n`);

  err(
    `${C.dim}seisin: ${role} · writes ${settings.filesystem.allowWrite.length} path(s) · ` +
    `reads ${settings.filesystem.allowRead.length} key(s) · ` +
    `env ${Object.keys(env).length} kept, ${dropped.length} dropped` +
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
   * The kernel's own refusals, alongside the hook's.
   *
   * Started BEFORE the spawn, and that ordering is the whole difference between
   * this working and this recording nothing. `log stream` is a separate process
   * with its own startup; a `sh -c` that gets refused is over in single-digit
   * milliseconds. Started after the spawn, the first version of this caught
   * zero denials on exactly the short commands an agent runs most.
   *
   * Attribution still needs the child's pid, so it is handed over the moment
   * there is one — `attributeTo` below — and anything that arrived in between is
   * held and re-examined rather than credited to this role on faith.
   *
   * These lines go through the same `append()` the spool does, with `owners`
   * recomputed here exactly as they are for a hook line. The rule that nothing
   * is taken at its word still applies; what changes is who is claiming. The
   * hook is the process being recorded, and the kernel is the thing that
   * actually refused — so when the two disagree, this is the one that is right.
   */
  const scope = scopeOf(settings, config.root);
  const keyDirs = (config.keyDirs ?? []).map((d) => (d.startsWith("/") ? d : join(config.root, d)));
  let offPolicy = 0;                  // refused, but about nothing the policy names
  let walks = 0;                      // a recursive search reaching a closed door
  const denials = watchDenials((d) => {
    if (!inScope(d.path, scope)) { offPolicy++; return; }
    if (!reachedForContent(d)) { walks++; return; }
    // Relative inside the repo, absolute outside it. A role can be refused at
    // ~/.ssh under `isolate`, and "../../../.ssh/id_rsa" would be a worse
    // answer to "what was refused" than the path itself.
    const rel = toRepoRelative(config, d.path);

    /**
     * A refusal the hook never saw still leaves a request behind.
     *
     * Without this the two halves of the record disagree in the worst
     * direction: `review` would show a role stopped repeatedly on a directory
     * while the queue held nothing to approve, so the one refusal a person most
     * needed to see — the one that escaped the hook — would be the one with no
     * way to act on it.
     *
     * There is no double counting to avoid. When the hook catches something it
     * denies the tool call outright and the command never runs, so the kernel
     * never sees it. These are the ones that got past it, which is the whole
     * reason this exists. Inside the repo only: `~/.ssh` is refused on purpose
     * under `isolate` and is not a territory anyone is meant to ask for.
     */
    const barred = rel !== d.path && d.action === "write" && config.roles[role]
      ? explain(config, role, "write", rel).neverWrites
      : null;
    if (rel !== d.path && !barred)
      record(requestsPath(config.root), { role, action: d.action, target: rel, owners: ownersOf(config, rel) });

    append(logPath(config.root), {
      at: new Date().toISOString(),
      role,
      tool: "kernel",
      source: "kernel",
      action: d.action,
      kind: keyDirs.some((k) => d.path === k || d.path.startsWith(k + "/")) ? "key" : "file",
      target: rel,
      verdict: "denied",
      owners: ownersOf(config, rel),
      reason: d.operation,
      // So the log can tell a subtraction doing its job from a missing permission.
      ...(barred ? { neverWrites: barred } : {}),
    });
  }, { argv: cmd });

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

  const child = spawn(srt, ["--settings", file, "--", ...cmd], {
    stdio: outStream ? ["inherit", "pipe", "pipe"] : "inherit",
    env,
  });
  denials.attributeTo(child.pid);
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
  child.on("exit", async (code, signal) => {
    const status = signal ? 1 : code ?? 0;
    // The notice rides on what you are already looking at. A queue nobody opens
    // is not human-in-the-loop, and this is the terminal that just showed you
    // the denial — so it goes to stderr, beside it, not into the agent's stdout
    // where a pipeline would swallow it.
    // Close the spool before reading the queue: a line the hook sent on the
    // agent's last turn may still be in flight, and reporting a queue that is
    // one entry behind is how a request goes unnoticed for a day.
    audit.close();
    // Same reason, one layer further out: the kernel writes its line through a
    // separate process, so the last refusal of a run can still be in flight
    // here. This is the only wait the mechanism adds and it is per run — it
    // returns as soon as the stream goes quiet, so a run that was refused
    // nothing pays a tick.
    await denials.close({ drain: DRAIN_MS });
    // The run made this directory, so the run removes it.
    try { rmSync(dirname(sockPath), { recursive: true, force: true }); } catch {}

    // Say what was dropped rather than only what was kept. A filter nobody can
    // see is indistinguishable from a monitor that is not working, and this one
    // drops the majority of what the kernel says on a busy run.
    // Only when something was actually recorded. A run where every refusal was
    // filtered out has nothing to contextualise, and `0 recorded, 1 outside the
    // policy's paths` is a line that answers a question nobody asked — the
    // counts exist to explain a filter, not to announce that one ran.
    const { attributed, foreign } = denials.stats;
    const recorded = attributed - offPolicy - walks;
    if (recorded > 0)
      err(`${C.dim}seisin: ${recorded} kernel denial(s) recorded` +
          `${walks ? `, ${walks} directory scan(s)` : ""}` +
          `${offPolicy ? `, ${offPolicy} outside the policy's paths` : ""}` +
          `${foreign ? `, ${foreign} from other sandboxes` : ""}${C.off}\n`);

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
