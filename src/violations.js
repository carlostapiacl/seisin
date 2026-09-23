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
 * unavailable watcher with the reason, and `seisin run` says so once.
 */
import { spawn, execFileSync } from "node:child_process";
import { statSync } from "node:fs";

/** Only sandbox-runtime tags its violations this way. Everything else on the
 *  machine — Safari, mDNSResponder, Spotlight — is filtered out by the OS
 *  before a byte reaches us, which is why the predicate is not a grep. */
const PREDICATE = 'eventMessage ENDSWITH "_SBX"';

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
  return null;
}

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
 *     live: every DNS lookup inside the box is a refused connect to
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
 * Split a POSIX shell word list, the way a shell would.
 *
 * This reads the runtime's attribution tag, which carries the wrapped command
 * re-quoted for `sh -c` and truncated to 100 characters. Parsing it beats
 * re-generating it: any correct quoting of the same argument list parses back to
 * that list, so this keeps matching if the runtime changes how it quotes, which
 * re-implementing its `quote()` would not.
 *
 * Truncation means the last word is usually a fragment and the closing quote is
 * usually missing. That is expected, not an error — an unterminated word is
 * returned as far as it got, and {@link isOurs} treats the final word as a
 * prefix.
 */
export function shellSplit(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ""; continue; }
    if (c === "\\" && i + 1 < line.length) { word = (word ?? "") + line[++i]; continue; }
    if (/\s/.test(c)) { if (word !== null) { words.push(word); word = null; } continue; }
    word = (word ?? "") + c;
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * Was this tagged command the one this run launched?
 *
 * The second of two anchors, and it exists because the first one is racy: a
 * refused `sh -c` can be dead before `ps` runs, and then a process tree proves
 * nothing. This one does not depend on the process still existing.
 *
 * Compared as a *prefix*, because the tag holds only the first 100 characters:
 * every complete word must match exactly, and the last word — the one the
 * truncation cut — only has to start the same way. A command that agrees with
 * ours for 100 characters and then differs would be credited to us, which is a
 * wrong attribution we accept: it requires another sandbox on the same machine
 * launching a command that matches ours to the byte for 100 bytes.
 */
export function isOurs(tagged, argv) {
  if (!tagged) return false;
  const words = shellSplit(tagged);
  if (words.length === 0 || words.length > argv.length) return false;
  for (let i = 0; i < words.length - 1; i++) if (words[i] !== argv[i]) return false;
  const last = words[words.length - 1];
  return argv[words.length - 1]?.startsWith(last) ?? false;
}

/**
 * Is `pid` a descendant of `root`?
 *
 * This is the anchor for attribution, and it is the reason a denial from
 * somebody else's sandbox never lands in this repo's log. The alternative was
 * matching the decoded command against the one we launched, which would mean
 * reimplementing the runtime's shell quoting and inheriting its bugs; a process
 * tree is a fact the OS already holds.
 *
 * One `ps` per unseen pid, and only until the session suffix is learned — after
 * that the suffix alone is exact, because it is generated once per `srt`
 * process. In practice that is one `ps` per run.
 */
export function descends(pid, root, snapshot) {
  const parent = new Map(snapshot);
  const seen = new Set();
  let at = pid;
  while (at && at !== 1 && !seen.has(at)) {
    if (at === root) return true;
    seen.add(at);
    at = parent.get(at);
  }
  return false;
}

/** pid → ppid for every process this user can see. */
export function processTree(run = execFileSync) {
  const tree = new Map();
  try {
    const out = run("/bin/ps", ["-Ao", "pid=,ppid="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) tree.set(Number(m[1]), Number(m[2]));
    }
  } catch {
    // No tree means nothing can be attributed, which the caller handles by
    // recording nothing. A permission tool does not invent an owner.
  }
  return tree;
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
export function watchDenials(onDeny, { pid = null, argv = null, platform = process.platform, spawnFn = spawn, treeFn = processTree } = {}) {
  const stats = { attributed: 0, foreign: 0, unattributed: 0 };

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
        ? "kernel denials are not readable from outside the runtime on Linux — see docs/upstream/cli-violations.md"
        : `no kernel denial stream on ${platform}`,
      stats,
      attributeTo() {},
      close: () => Promise.resolve(stats),
    };

  let suffix = null;               // learned once, exact from then on
  let tree = null;                 // refreshed only while still learning
  let root = pid;                  // the srt pid; not known until after spawn
  const mine = new Set();          // pids already proven to be ours
  const held = [];                 // denials seen before they could be attributed

  /**
   * Two anchors, and either one is enough.
   *
   * Neither works alone. The process tree is exact while the process exists and
   * proves nothing once it has exited — which, for the short commands that get
   * refused most, is by the time the line arrives. The command tag survives the
   * process but depends on the runtime's quoting staying recognisable.
   *
   * Whichever answers first hands over the session suffix, and from that point
   * attribution is one string comparison: the suffix is generated once per `srt`
   * process, so it separates this run from every other sandbox on the machine
   * exactly. In practice the tag settles it on the first denial and the tree is
   * never consulted.
   */
  const attribute = (d) => {
    if (suffix) return d.suffix === suffix;
    if (argv && isOurs(d.command, argv)) {
      if (d.suffix) suffix = d.suffix;
      return true;
    }
    if (root === null) return false;   // nothing to descend from yet
    if (mine.has(d.pid)) return true;
    if (tree === null) tree = treeFn();
    if (!descends(d.pid, root, tree)) {
      // A pid we have never seen may simply be younger than the snapshot.
      // Refresh once, then believe the answer.
      tree = treeFn();
      if (!descends(d.pid, root, tree)) return false;
    }
    mine.add(d.pid);
    // The first proven denial hands us the suffix for every later one.
    if (d.suffix) suffix = d.suffix;
    return true;
  };

  /**
   * The same refusal, reported twice.
   *
   * macOS emits a violation from `kernel` and, for some of them, a second
   * extended report from `sandboxd` carrying the identical `Sandbox:` line.
   * They are one event and the log has to say so — `review` counts lines, and a
   * denial that shows as two is a policy that looks twice as wrong as it is.
   * Measured on the first real run: 31 doubled events out of 730.
   *
   * Keyed on what the kernel said, not on when we read it: two deliveries of one
   * event agree on pid, operation and path and disagree on arrival time.
   */
  const recent = new Map();
  const isRepeat = (d) => {
    const key = `${d.pid}|${d.operation}|${d.path}`;
    const now = Date.now();
    for (const [k, t] of recent) if (now - t > REPEAT_MS) recent.delete(k); else break;
    if (recent.has(key)) return true;
    recent.set(key, now);
    return false;
  };

  const consider = (d) => {
    if (attribute(d)) {
      stats.attributed++;
      onDeny(d);
      // Learning the suffix makes every held line decidable. Without this,
      // denials that arrived while the first process was being identified —
      // which on a fast command is all of them — are lost.
      if (suffix && held.length) revisit();
      return;
    }
    // Not ours *yet*. Two reasons, both temporary: the run has not spawned the
    // child whose pid anchors attribution, or the process died before `ps`
    // could see it. Either way a foreign sandbox and one of ours look the same
    // from here, so hold the line rather than credit or discard it.
    if (!suffix && d.suffix) {
      stats.unattributed++;
      held.push(d);
      // Bounded, because the common case on a busy machine is a run that is
      // never refused anything: it never learns its own suffix, so every
      // denial from every other sandbox lands here and nothing ever drains it.
      // Several cells running at once for hours is exactly that shape, and an
      // unbounded array is how an instrument becomes the leak.
      //
      // Dropping the oldest is the right end to drop. What is still worth
      // replaying is whatever arrived near the run's own first refusal; a
      // denial from an hour ago that is still unattributed is not ours.
      while (held.length > HELD_MAX) { held.shift(); stats.unattributed--; stats.foreign++; }
      return;
    }
    stats.foreign++;
  };

  /** Re-examine what was held, now that something new is known. */
  const revisit = () => {
    for (const h of held.splice(0)) { stats.unattributed--; consider(h); }
  };

  let child;
  try {
    child = spawnFn("/usr/bin/log", ["stream", "--predicate", PREDICATE, "--style", "compact"],
      { stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return { available: false, reason: `could not start the log stream: ${e.message}`, stats, close() {} };
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
      const d = parseChunk(chunk);
      // Deduplicated here and not in consider(), because a held denial goes
      // through consider() a second time when it is finally attributed. Doing
      // this there would drop every line that arrived before the child had a
      // pid — which, on a short command, is all of them.
      if (d && !isRepeat(d)) consider(d);
    }
    if (buf.length > 64_000) buf = "";   // a stream we cannot parse is not a leak
  });
  // A monitor that cannot run must never take the run down with it. Same rule
  // as append(): the instrument is allowed to fail, the agent is not.
  child.on("error", () => {});

  return {
    available: true,
    reason: null,
    stats,

    /**
     * Name the process whose descendants count as ours.
     *
     * Separate from the constructor because the stream has to be listening
     * *before* the child starts. A short command — the kind an agent runs
     * hundreds of times — is refused and gone in single-digit milliseconds, so
     * a monitor started after the spawn misses precisely the denials it exists
     * to catch. Measured: with the stream started afterwards, a one-line `sh -c`
     * refusal recorded nothing at all.
     */
    attributeTo(childPid) {
      root = childPid;
      if (held.length) revisit();
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
      const stop = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
      if (drain <= 0) { stop(); return Promise.resolve(stats); }
      return new Promise((resolve) => {
        let quiet = null;
        const settle = () => { clearTimeout(quiet); clearTimeout(cap); stop(); resolve(stats); };
        const cap = setTimeout(settle, drain);
        const bump = () => { clearTimeout(quiet); quiet = setTimeout(settle, QUIET_MS); };
        child.stdout?.on("data", bump);
        bump();
      });
    },
  };
}

/**
 * How long the stream has to stay silent before a drain gives up on it.
 *
 * Short, because the measured lag between a refusal and its line arriving is
 * under a millisecond — the line had already landed before `srt` finished
 * exiting. This is a floor against scheduling noise, not a guess at the lag.
 */
const QUIET_MS = 60;

/**
 * How many undecided denials to keep while waiting to learn our own suffix.
 *
 * Generous enough to cover the startup window — where every denial arrives
 * before there is anything to attribute it to — and small enough that a run
 * which is never refused anything cannot accumulate another sandbox's traffic
 * for the length of an agent session.
 */
const HELD_MAX = 500;

/**
 * How long two reports of one refusal can be apart and still be one event.
 *
 * The second copy — `sandboxd`'s extended report — follows the kernel's within
 * milliseconds. Kept short so that a role genuinely retrying the same path a
 * second later is still recorded as a second attempt, which is what makes
 * `asked 3×` mean anything.
 */
const REPEAT_MS = 1000;
