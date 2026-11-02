/**
 * The other half of the record: what the KERNEL refused, not what the hook saw.
 *
 * ── Why this exists ──
 * The hook runs one layer above the boundary and reports the attempt before it
 * happens. That is most of the log, and it is deliberately imperfect — a hook
 * that misreads a shell command costs an explanation, never a boundary. But it
 * means the log only ever contains what the hook understood. Everything that
 * escaped it went **unexplained**, and an escape looks exactly like nothing
 * happening: the agent gets a bare `Operation not permitted` on its stderr, with
 * no path and no reason, and the record does not grow.
 *
 * That failure mode has a shape, and it has cost real time. Four defects found
 * while wrapping a live cell all presented the same way — a file that stopped
 * growing — because nothing anywhere said which path had been refused.
 *
 * macOS already writes the missing line. Every Seatbelt denial lands in the
 * system log with the operation, the absolute path, and the sandbox runtime's
 * own attribution tag attached:
 *
 *     Sandbox: bash(65518) deny(1) file-write-create /repo/src/api/orders.ts
 *     CMD64_c2ggLWMgJ2VjaG8g…_END__qlvxb5sax_SBX
 *
 * This module reads that stream and hands each denial to the parent, which
 * already owns the log file. Nothing here enforces anything: the boundary held
 * before this existed and holds the same afterwards. It is an instrument.
 *
 * ── Why it does not go through the runtime ──
 * The runtime collects these itself — `startMacOSSandboxLogMonitor` — but only
 * for a caller that embeds the library AND passes `enableLogMonitor: true`. The
 * `srt` binary omits that argument, so on the CLI path the collector is never
 * constructed. Filed upstream: docs/upstream/cli-violations.md.
 *
 * ── Why macOS only, stated rather than papered over ──
 * There is no Linux equivalent to read. bubblewrap does not log refusals; the
 * runtime synthesises them by observing write-intent syscalls through its own
 * `apply-seccomp` stub, which reports over a socket the runtime creates and
 * reads paths out of the traced process's memory — its own comment calls those
 * events attacker-controlled and racy. That is not a stream an outside process
 * can attach to, and it is not one to reimplement. On Linux this returns an
 * unavailable watcher with the reason. `seisin run` does not print it — once
 * per run is a line nobody can act on — and `seisin check` says it, with the
 * platform's other standing limits.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { createDenialAttribution, processTree, TREE_MS } from "./denial-attribution.js";

// Keep the existing helper imports available to callers and tests.
export { shellSplit, isOurs, descends, processTree, underAnotherRun } from "./denial-attribution.js";

/** Only sandbox-runtime tags its violations this way. Everything else on the
 *  machine — Safari, mDNSResponder, Spotlight — is filtered out by the OS
 *  before a byte reaches us, which is why the predicate is not a grep. */
const PREDICATE = 'eventMessage ENDSWITH "_SBX"';

/**
 * What `log stream` prints in place of the messages it could not keep up with.
 *
 * The one way this instrument loses a denial without anything else noticing:
 * the kernel refuses, the agent sees EPERM, and the line never arrives. It
 * happens when the unified log is flooded — measured, a network filter's
 * kernel extension writing ~6,700 lines a second while it dropped two
 * sessions' connections — and the predicate does not help, because the stream
 * is dropped before it is filtered. The marker carries no count and no names:
 * one line per batch lost, which is all there is to report.
 */
const DROPPED = /^=== Messages dropped during live streaming\b/gm;

/** How many batches `log stream` says it dropped in this text. */
export function droppedIn(text) {
  return (String(text).match(DROPPED) ?? []).length;
}

/** `Sandbox: <proc>(<pid>) deny(<n>) <operation> <detail>` */
const DENY = /Sandbox:\s+(\S+)\((\d+)\)\s+deny\(\d+\)\s+(\S+)\s+(.+?)\s*$/;

/** `CMD64_<base64 of the first 100 chars>_END_<per-srt-process suffix>` */
const TAG = /CMD64_(.*?)_END_(\S*_SBX)\s*$/;

/**
 * A Seatbelt operation, as one of the three verbs the log speaks.
 *
 * `network-outbound` is `connect` — a refused dial to a local port or socket,
 * kept narrow by `connectTarget` below. Everything else that is not a file
 * operation — `mach-lookup`, `sysctl-read` — returns null and is dropped: the
 * sandbox doing its job against the machine, not a role reaching for anything
 * a person could decide about. Refusals by the proxy (a domain not on the
 * list) never reach this log at all; see docs/decisions.md.
 *
 * **`file-read-metadata` is dropped too, and that one was learned the hard
 * way.** It is a refused `stat()`, which is what any directory walk produces
 * against a denied path — `rg`, `find`, a glob, a tool listing the repo. It is
 * not an attempt to read a secret and recording it as one is actively harmful:
 * the first real run against a policy with a populated key directory wrote
 * **721 of them in two runs**, against 4 genuine `file-read-data` attempts. That
 * buried the nine lines that mattered, told `review` that the policy was
 * catastrophically wrong about a directory where nothing had happened, and filed
 * a separate permission request per file — 327 of them — in a queue whose whole
 * promise is that many refusals in one place are one question.
 *
 * `file-read-data` is the operation that means content was reached for. That is
 * the one worth a line.
 */
export function actionOf(operation) {
  if (operation.startsWith("file-write")) return "write";
  if (operation === "file-read-data") return "read";
  if (operation === "network-outbound") return "connect";
  if (SYSTEM.test(operation)) return "system";
  return null;
}

/**
 * The operations that are neither a file nor a connection — `mach-register`,
 * `mach-lookup`, `sysctl-read`, `iokit-open`… — and that used to be dropped.
 *
 * They were dropped as the sandbox doing its job against the machine, and most
 * of them are: a browser asks for the window server and carries on. But one of
 * them was the whole failure of a headless Chromium — a refused
 * `mach-register` that killed the browser at start — and from seisin's record
 * there was no way to know: five file reads in the log, and a crash. So they
 * are recorded now, by operation and name, once per run each (intake.js), and
 * never as a request: there is no territory to hand them to. What grants one
 * is a preset like `browsers`, not `seisin grant`.
 */
const SYSTEM = /^(mach|sysctl|iokit|ipc|signal|process|system|user-preference|darwin|nvram|lsopen|appleevent)-/;

/**
 * The target of a refused connection, or null when it is not one worth a line.
 *
 * `network-outbound` was dropped with the rest of the non-file operations, and
 * that hid the one refusal an agent misreads the most: a role that cannot reach
 * the test database gets `connect EPERM`, no path, and concludes the service is
 * down (measured: a whole cell spent two rounds reporting Docker as broken
 * while Docker was up). Kept narrow, because the lesson of
 * `file-read-metadata` applies here as well:
 *
 *   - `remote:*:<port>` — a TCP dial the profile refused. The kernel does not
 *     name the host, so the target is the port and nothing more.
 *   - a unix socket path — except under /var/run, where the system daemons
 *     live: every DNS lookup inside the sandbox is a refused connect to
 *     mDNSResponder, and recording those would bury everything else.
 *   - anything else (an empty detail, which the kernel also writes) — dropped.
 */
export function connectTarget(detail) {
  const port = /^remote:\S*:(\d+)$/.exec(detail)?.[1];
  if (port) return `tcp:${port}`;
  if (detail.startsWith("/") && !/^\/(private\/)?var\/run\//.test(detail)) return detail;
  return null;
}

/**
 * One chunk of `log stream` output into a denial, or null.
 *
 * Kept pure and exported so the parsing is testable without a kernel: every
 * fixture in the test suite is a real chunk captured from a real refusal.
 */
export function parseChunk(chunk) {
  let deny = null;
  let tag = null;
  for (const line of chunk.split("\n")) {
    // "3 duplicate reports for Sandbox: …" is the OS collapsing a repeat. The
    // first one was already reported on its own line, so counting it again
    // would inflate `review`, which exists to do arithmetic over this file.
    if (!deny && !/\bduplicate reports? for\b/.test(line)) {
      const m = line.match(DENY);
      if (m) deny = { proc: m[1], pid: Number(m[2]), operation: m[3], detail: m[4] };
    }
    if (!tag) {
      const m = line.match(TAG);
      if (m) tag = { command: decode(m[1]), suffix: m[2] };
    }
  }
  if (!deny) return null;
  const action = actionOf(deny.operation);
  if (!action) return null;
  if (action === "connect") {
    const target = connectTarget(deny.detail);
    if (!target) return null;
    return { ...deny, action, path: target, suffix: tag?.suffix ?? null, command: tag?.command ?? null };
  }
  // The name as the kernel gave it ("com.apple.tsm.portname (per-pid)"); an
  // operation with no name is not a line anyone can act on.
  if (action === "system") {
    const name = deny.detail.trim();
    if (!name) return null;
    return { ...deny, action, path: name, suffix: tag?.suffix ?? null, command: tag?.command ?? null };
  }
  // Only an absolute path is a territory question. A relative or malformed
  // detail means the line was not what it looked like; dropping beats guessing.
  if (!deny.detail.startsWith("/")) return null;
  return { ...deny, action, path: deny.detail, suffix: tag?.suffix ?? null, command: tag?.command ?? null };
}

function decode(b64) {
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Did this refusal reach for content, or just walk past the door?
 *
 * `file-read-data` on a *file* is a read. On a *directory* it is `opendir` —
 * what any recursive search produces when it reaches a denied path. `rg`, `find`
 * and `grep -r` from the repo root hit every key directory on every invocation,
 * and the kernel refuses each one.
 *
 * This is the same lesson as `file-read-metadata`, one layer up, and it was
 * missed the first time because the operation name is identical: the difference
 * is not in what the kernel said, it is in what was on the other end. Measured
 * on the real log after the metadata fix: **78 of 116 lines** were directory
 * opens of a key directory, and **not one of them named a file inside it**. A
 * role going for a secret names the file.
 *
 * It matters more than volume. Those lines carry no owner — a key directory is
 * closed to everyone, not held by someone — so they arrive at `review` as
 * repeated friction with nobody to hand the work to, and its advice for
 * repeated friction is *grant it, or move the territory*. Left alone, the
 * strongest recommendation the tool made about a real repository was to grant
 * two roles the credential directory.
 *
 * Writes are not filtered this way. A refused `file-write-create` names
 * something that does not exist yet, and there is nothing to stat.
 */
export function reachedForContent(denial, stat = statSync) {
  if (denial.action !== "read") return true;
  try {
    return !stat(denial.path).isDirectory();
  } catch {
    // Gone, or never there. A read of something that is not on disk is not a
    // directory walk, so it keeps its line rather than being filtered on a
    // guess.
    return true;
  }
}

/**
 * Is this path one the policy has anything to say about?
 *
 * The kernel refuses plenty that is not a territory question: `/dev/tty` on
 * every command a CLI runs, a font cache, a dtrace helper. Those are the
 * sandbox holding the line against the machine, they repeat on every single
 * invocation, and recording them would bury the one line that matters under
 * thousands that never do — in a file whose whole purpose is that `review` can
 * do arithmetic over it.
 *
 * So a denial is recorded when it lands inside the repo, or inside a path this
 * role's policy actually named: its territory, its scratch space, its key
 * directories, the state directory, the denied credential locations under
 * `isolate`. Everything else is counted and reported as a number when the run
 * ends, so that filtering them is visible rather than silent.
 *
 * This is a reporting filter and nothing else. It cannot widen or narrow a
 * boundary; by the time a line exists here the kernel has already refused.
 */
export function inScope(path, prefixes) {
  return prefixes.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/"));
}

/**
 * Every path the role's settings mention, plus the repo itself.
 *
 * Read off the generated settings rather than off the config, so it covers
 * exactly what was handed to the kernel — including the paths seisin adds on
 * the role's behalf, which are the ones a reader would not think to look for.
 */
export function scopeOf(settings, root) {
  const fs = settings.filesystem ?? {};
  return [root, ...(fs.allowWrite ?? []), ...(fs.denyWrite ?? []),
          ...(fs.allowRead ?? []), ...(fs.denyRead ?? [])];
}

/**
 * Follows the kernel's refusals for one `seisin run`.
 *
 * `onDeny` receives `{ action, path, operation, proc, pid }` for each denial
 * attributable to this run. `pid` is the pid of the `srt` process; denials from
 * anything that is not its descendant belong to someone else and are dropped.
 *
 * Returns `{ available, reason, close, stats }`. `available: false` is a normal
 * outcome, not a failure — it is what Linux looks like, and what a machine
 * without `log` looks like — and the caller says so once rather than silently
 * logging less than it used to.
 */
export function watchDenials(onDeny, { pid = null, argv = null, platform = process.platform, spawnFn = spawn, treeFn = processTree, now = () => performance.now() } = {}) {
  const stats = { attributed: 0, foreign: 0, unattributed: 0, dropped: 0 };

  /**
   * Unavailable is a watcher that does nothing, NOT a different shape.
   *
   * This returned an object without `attributeTo`, and `seisin run` calls that
   * unconditionally — so on Linux, where this branch is always taken, every
   * single run died with `denials.attributeTo is not a function` before the
   * agent started. The tool did not degrade on the platform it cannot watch;
   * **it stopped working there.**
   *
   * It went unnoticed for a day because the suite could not see it either: the
   * fourteen tests that run real commands decided whether the runtime was
   * present with `command -v srt`, which misses the bundled one, so they
   * skipped and the run came back green. Two defects covering for each other,
   * and it took running the suite on the other platform to part them.
   *
   * So the contract is the object, not the flag. Everything a caller may invoke
   * exists at both ends; `available` says whether it will find anything.
   */
  if (platform !== "darwin")
    return {
      available: false,
      reason: platform === "linux"
        ? "kernel denials are not readable from outside the runtime on Linux — see https://github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md"
        : `no kernel denial stream on ${platform}`,
      stats,
      attributeTo() {},
      close: () => Promise.resolve(stats),
    };

  let recheck = null;              // a deferred look, when a snapshot was refused
  const attribution = createDenialAttribution(onDeny, {
    pid, argv, treeFn, now, stats,
    requestRecheck() {
      if (recheck) return;
      recheck = setTimeout(() => { recheck = null; attribution.revisitPending(); }, TREE_MS);
      recheck.unref?.();
    },
  });

  let child;
  try {
    child = spawnFn("/usr/bin/log", ["stream", "--predicate", PREDICATE, "--style", "compact"],
      { stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // The same shape as the unavailable watcher above, for the same reason:
    // `run` calls attributeTo() and awaits close() unconditionally.
    return {
      available: false, reason: `could not start the log stream: ${e.message}`, stats,
      attributeTo() {},
      close: () => Promise.resolve(stats),
    };
  }

  let buf = "";
  child.stdout?.on("data", (data) => {
    buf += data.toString();
    // The OS emits one event per chunk, but a chunk can split across reads.
    // Split on the tag, which always terminates an event.
    let cut;
    while ((cut = buf.indexOf("_SBX")) !== -1) {
      const chunk = buf.slice(0, cut + 4);
      buf = buf.slice(cut + 4);
      // A marker never contains the tag, so it is whole in one chunk or still
      // in `buf`, which close() counts.
      stats.dropped += droppedIn(chunk);
      const d = parseChunk(chunk);
      if (d) attribution.accept(d);
    }
    // A stream we cannot parse is not a leak. A flooded one is mostly markers
    // with no tag between them, so they are counted before they go.
    if (buf.length > 64_000) { stats.dropped += droppedIn(buf); buf = ""; }
  });
  // A monitor that cannot run must never take the run down with it. Same rule
  // as append(): the instrument is allowed to fail, the agent is not.
  child.on("error", () => {});

  return {
    available: true,
    reason: null,
    stats,

    attributeTo(childPid) {
      attribution.attributeTo(childPid);
    },

    /**
     * Stop, after giving the kernel time to finish talking.
     *
     * `log stream` is a separate process and the last denial of a run can still
     * be in flight when the child exits. The wait is per run and it is the only
     * latency this whole mechanism adds; nothing here sits on the path of a tool
     * call. Resolves early once the stream goes quiet, so the common case —
     * nothing pending — costs one tick rather than the full window.
     */
    close({ drain = 0 } = {}) {
      // Cancel before draining without resetting the handle: preserve replay scheduling.
      clearTimeout(recheck);
      const stop = () => ended(child).then(() => { stats.dropped += droppedIn(buf); buf = ""; return stats; });
      if (drain <= 0) return stop();
      return new Promise((resolve) => {
        let quiet = null;
        const settle = () => { clearTimeout(quiet); clearTimeout(cap); resolve(stop()); };
        const cap = setTimeout(settle, drain);
        const bump = () => { clearTimeout(quiet); quiet = setTimeout(settle, QUIET_MS); };
        child.stdout?.on("data", bump);
        bump();
      });
    },
  };
}

/**
 * Stop a `log stream` and wait for what it was still holding.
 *
 * SIGINT, not SIGTERM. Writing to a pipe, `log` buffers its own notices — a
 * denial's line arrives at once, but the "messages dropped" markers were buffered
 * 8 KB at a time and came out together, measured twelve seconds after the flood
 * began. SIGINT makes it flush them before it exits; SIGTERM threw them away
 * (18 markers against 0 in the same flood). Bounded, so a stream that will not
 * exit cannot hold up the end of a run.
 */
function ended(child, cap = END_MS) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, cap);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    try { child.kill("SIGINT"); } catch { clearTimeout(timer); resolve(); }
  });
}

/** How long a stopped `log stream` gets to flush and exit. */
const END_MS = 1000;

/**
 * How long the stream has to stay silent before a drain gives up on it.
 *
 * Short, because the measured lag between a refusal and its line arriving is
 * under a millisecond — the line had already landed before `srt` finished
 * exiting. This is a floor against scheduling noise, not a guess at the lag.
 */
const QUIET_MS = 60;

/**
 * Is the system log dropping messages right now, and who is writing the most?
 *
 * For `seisin check --system-log`. Two streams for `seconds`: one with the run's
 * own predicate, counting the batches it loses — the number a run would have
 * seen — and one unfiltered, counting messages by sender, because a flood
 * comes from somebody and naming them is the only fix there is. A kernel
 * message is named by its first word, which is the function that wrote it
 * (`cfil_inp_log`): "kernel" alone names nothing.
 *
 * Reads the log and starts no sandbox. Not available off macOS, where denials
 * are not read from a log at all.
 */
export function measureSystemLog({ seconds = 3, platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== "darwin") return Promise.resolve({ available: false, reason: `no system log stream on ${platform}` });
  const streams = [];
  const start = (args) => {
    const child = spawnFn("/usr/bin/log", ["stream", ...args], { stdio: ["ignore", "pipe", "ignore"] });
    child.on("error", () => {});
    streams.push(child);
    return child;
  };
  return new Promise((resolve) => {
    let dropped = 0, lines = 0, tail = "", rest = "";
    const by = new Map();
    let ours, all;
    try {
      ours = start(["--predicate", PREDICATE, "--style", "compact"]);
      all = start(["--style", "ndjson"]);
    } catch (e) {
      for (const c of streams) try { c.kill("SIGTERM"); } catch {}
      return resolve({ available: false, reason: `could not start the log stream: ${e.message}` });
    }
    ours.stdout?.on("data", (d) => {
      const text = tail + d.toString();
      const cut = text.lastIndexOf("\n");
      dropped += droppedIn(text.slice(0, cut + 1));
      tail = text.slice(cut + 1);
    });
    all.stdout?.on("data", (d) => {
      const parts = (rest + d.toString()).split("\n");
      rest = parts.pop();
      for (const line of parts) {
        if (!line.startsWith("{")) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        lines++;
        const proc = basename(String(e.processImagePath ?? "?"));
        const who = e.subsystem
          ? `${proc} · ${e.subsystem}`
          : proc === "kernel" ? `kernel · ${String(e.eventMessage ?? "").split(/[\s:]/)[0] || "?"}` : proc;
        by.set(who, (by.get(who) ?? 0) + 1);
      }
      if (rest.length > 1_000_000) rest = "";
    });
    setTimeout(async () => {
      await Promise.all(streams.map((c) => ended(c)));
      dropped += droppedIn(tail);
      const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([who, n]) => ({ who, perSecond: Math.round(n / seconds) }));
      resolve({ available: true, seconds, dropped, perSecond: Math.round(lines / seconds), top });
    }, seconds * 1000);
  });
}
