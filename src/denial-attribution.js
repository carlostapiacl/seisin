import { execFileSync } from "node:child_process";

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
 * At most one `ps` per TREE_MS, and only until the session suffix is learned —
 * after that the suffix alone is exact, because it is generated once per `srt`
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

/**
 * pid → ppid for every process this user can see, and in `tree.roots` the
 * pids that are a sandbox run's root: an `srt`, or a `seisin run`.
 *
 * The roots are what makes "not ours" provable. A process outside our tree is
 * someone else's only if its ancestry reaches another run; one whose ancestry
 * ends at init was orphaned — `cmd &`, a build daemon, git's fsmonitor — and
 * may well be ours, reparented when the shell that started it exited.
 */
export function processTree(run = execFileSync) {
  const tree = new Map();
  tree.roots = new Set();
  try {
    const out = run("/bin/ps", ["-Ao", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
      if (!m) continue;
      tree.set(Number(m[1]), Number(m[2]));
      if (m[3] && RUN_ROOT.test(m[3])) tree.roots.add(Number(m[1]));
    }
  } catch {
    // No tree means nothing can be attributed, which the caller handles by
    // recording nothing. A permission tool does not invent an owner.
  }
  return tree;
}

/** The command line of an `srt` (however it was installed) or of `seisin run`. */
const RUN_ROOT = /(?:^|[\s/])srt(?:\s|$)|sandbox-runtime\/dist\/cli\.js(?:\s|$)|(?:^|[\s/])(?:seisin|cli\.js)\s+run\s/;

/**
 * Does `pid` descend from a run root other than `root`?
 *
 * A table without command lines (`roots` absent) cannot tell an orphan from a
 * stranger, and answers as before: alive and not ours is someone else's.
 */
export function underAnotherRun(pid, root, snapshot) {
  if (!snapshot.roots) return true;
  const seen = new Set();
  for (let at = pid; at && at !== 1 && !seen.has(at); at = snapshot.get(at)) {
    if (at !== root && snapshot.roots.has(at)) return true;
    seen.add(at);
  }
  return false;
}

/**
 * Attribution state for one run, independent of the log reader.
 *
 * The transport owns scheduling and shutdown. A refused snapshot requests a
 * later look; revisiting held events must bypass arrival deduplication.
 */
export function createDenialAttribution(onDeny, {
  pid = null, argv = null, treeFn = processTree, now = () => performance.now(),
  stats = { attributed: 0, foreign: 0, unattributed: 0, dropped: 0 },
  requestRecheck = () => {},
} = {}) {
  let suffix = null;               // learned once, exact from then on
  let tree = null;                 // refreshed only while still learning
  let treeAt = -Infinity;          // when `tree` was taken
  let root = pid;                  // the srt pid; not known until after spawn
  const mine = new Set();          // pids already proven to be ours
  const held = [];                 // denials seen before they could be attributed
  const foreignSuffixes = new Set(); // other sandboxes, proven while they were alive

  /**
   * One `ps` per TREE_MS at most, and a later look instead of a skipped one.
   *
   * `ps` is synchronous and it was taken for every denial from another sandbox
   * while this run had not learned its own suffix — which, for a run that is
   * never refused anything, is the whole run. Several cells at once is exactly
   * that: 83 ms of blocked event loop per foreign line, measured. A line whose
   * process may be younger than the last snapshot is not decided on it; it is
   * held, and looked at again once the window has passed.
   */
  const snapshot = () => { tree = treeFn(); treeAt = now(); };

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
    // A suffix already proven foreign needs no `ps`: the suffix is per `srt`.
    if (d.suffix && foreignSuffixes.has(d.suffix)) return false;
    if (tree === null) snapshot();
    if (!descends(d.pid, root, tree)) {
      // A pid the snapshot does not have may simply be younger than it.
      // Refresh once, then believe the answer — unless the last refresh was
      // moments ago, and then look again later rather than refresh now. A pid
      // it does have is answered: its parents do not change into ours.
      if (treeAt < d.seen && !tree.has(d.pid)) {
        if (now() - treeAt < TREE_MS) { requestRecheck(); return LATER; }
        snapshot();
      }
      if (!descends(d.pid, root, tree)) {
        // Alive, not ours by either anchor, and under another run — the tag
        // did not match above. Every later line from that `srt` is someone
        // else's without asking. Alive but under no run at all is an orphan
        // (`cmd &`, a daemon): possibly ours, so its suffix stays undecided
        // rather than turning this run's own later lines into strangers.
        if (d.suffix && tree.has(d.pid) && underAnotherRun(d.pid, root, tree)) foreignSuffixes.add(d.suffix);
        return false;
      }
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
    const verdict = attribute(d);
    if (verdict === true) {
      stats.attributed++;
      // Report the deciding denial first: callbacks observe this replay order.
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
    // A line put off to the next snapshot is held with or without a suffix:
    // the look it is waiting for is the only thing that can decide it.
    if (verdict === LATER || (!suffix && d.suffix && !foreignSuffixes.has(d.suffix))) {
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

  return {
    stats,

    accept(d) {
      d.seen = now();
      // Deduplicated here and not in consider(), because a held denial goes
      // through consider() a second time when it is finally attributed. Doing
      // this there would drop every line that arrived before the child had a
      // pid — which, on a short command, is all of them.
      if (!isRepeat(d)) consider(d);
    },

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

    revisitPending() {
      if (!suffix && held.length) revisit();
    },
  };
}

/**
 * The shortest time between two `ps` snapshots while attribution is learning.
 *
 * Long enough that a burst of foreign denials costs one snapshot, not one
 * each; short enough that a line held for a younger process is decided before
 * anyone reads the log.
 */
export const TREE_MS = 250;

/** What `attribute` answers for a line it has put off to the next snapshot. */
const LATER = "later";

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
