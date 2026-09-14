/**
 * What the log says about the policy.
 *
 * Everything here is arithmetic over `.seisin/log.jsonl` and the config. No
 * model, no network, no heuristics that could be wrong in an interesting way —
 * and that is deliberate rather than modest. This project's whole argument is
 * that interpreting text is the wrong way to decide things; adding something
 * that reads the log and forms an opinion would contradict it on the way in.
 *
 * Three questions, and the second is the one nothing else can answer.
 *
 *   1. What is a role being stopped by, over and over?
 *      Forty denials on one directory is not an agent misbehaving. It is a
 *      policy that is wrong, and today it reads as forty tidy amber lines
 *      nobody adds up.
 *
 *   2. What was granted and never used?
 *      Every permission file only ever grows, everywhere, and the reason is
 *      always the same: nobody can prove a line is dead, so the safe move is to
 *      leave it. Here the log can prove it. This is the only direction that
 *      makes a policy smaller.
 *
 *   3. What does nobody own?
 *      `explain` says it one path at a time. Added up, it is the shape of the
 *      hole in the map.
 *
 * Every answer carries the window it was computed over, because "never used"
 * means nothing without "…in how long".
 */
import { read, logPath } from "./log.js";
import { covers, ownersOf } from "./owners.js";

/**
 * One reading of the log against the policy.
 *
 * `minDenials` is the point at which repetition stops being an accident. Three
 * is low on purpose: the cost of mentioning it is a line, and the cost of
 * missing it is a role that quietly cannot do its job.
 */
export function review(config, { minDenials = 3 } = {}) {
  const entries = read(logPath(config.root), { limit: 0 });

  if (entries.length === 0)
    return { window: null, entries: 0, friction: [], guarded: [], unused: [], unusedKnowable: false, unowned: [] };

  const at = entries.map((e) => e.at).filter(Boolean).sort();
  const window = { from: at[0], to: at[at.length - 1], entries: entries.length };

  return { window, entries: entries.length, ...findings(config, entries, minDenials) };
}

function findings(config, entries, minDenials) {
  /* ── 1. what keeps stopping a role ──────────────────────────────────── */

  /**
   * Two piles, because they are two different decisions and only one of them is
   * "grant it".
   *
   * A role stopped at another role's territory is a policy question: either the
   * territory is drawn wrong or the work belongs to somebody else. That is what
   * the advice *grant, or move the territory* is for.
   *
   * A role stopped at a `[keys] dir` is **the policy working**. A key directory
   * is closed to everyone — nobody holds it, so there is nobody to hand the work
   * to — and it is the one place where a grant is never the answer.
   *
   * Counting them together was not cosmetic. Measured against a real repository:
   * six of the eight lines at the top of this report were key directories, so
   * the strongest recommendation this tool made about that repo was to grant two
   * roles the credential directory. The distinction sat in the config the whole
   * time and this report was the only thing not using it.
   */
  const stopped = new Map();                 // role + directory -> how often
  for (const e of entries) {
    if (e.verdict !== "denied" || !e.target) continue;
    const dir = e.action === "read" ? e.target : dirOf(e.target);
    const key = `${e.role} ${e.action} ${dir}`;
    const seen = stopped.get(key) ?? {
      role: e.role, action: e.action, where: dir, times: 0,
      owners: e.owners ?? [],
      // Carried by the log from both writers — the hook sets it from the config
      // and so does the parent for a kernel denial. Recomputing it from the path
      // here would be a second opinion on a settled question.
      kind: e.kind === "key" ? "key" : "file",
    };
    seen.times++;
    stopped.set(key, seen);
  }

  const repeated = [...stopped.values()]
    .filter((f) => f.times >= minDenials)
    .sort((a, b) => b.times - a.times);

  const friction = repeated.filter((f) => f.kind !== "key");
  const guarded = repeated.filter((f) => f.kind === "key");

  /* ── 2. what was granted and never used ─────────────────────────────── */

  /**
   * This question refuses to answer when the log cannot support an answer, and
   * that refusal is the whole of the second finding.
   *
   * "Never used" is read off `allowed` lines, and **only the hook writes those**.
   * The kernel reports what it refused; it has nothing to say about what went
   * through. So a log with no hook behind it holds denials and nothing else,
   * every grant falls through as unused, and this section reports that the whole
   * policy is dead — under a heading calling itself the only evidence anyone
   * will ever have for making a permission file smaller.
   *
   * Measured on a real repository with the hook not installed: every write
   * permission of every role listed as never used, while those roles were
   * working.
   *
   * It became reachable the day the kernel started writing here. Before that an
   * unwired repo had an empty log and this section said nothing, which was
   * accidentally right. A partial input is more dangerous than no input, because
   * it looks like an answer.
   *
   * So: no `allowed` line in the window, no answer. `unused` stays empty rather
   * than full — a consumer that has never heard of `unusedKnowable` then reports
   * nothing instead of everything, which is the direction this has to fail in.
   */
  const knowable = entries.some((e) => e.verdict === "allowed");

  // Only writes. A key that is declared and not read is ordinary — most roles
  // hold a credential for the one turn a month that needs it — but a folder a
  // role owns and has never written to in the whole log is a line nobody would
  // miss, and the only evidence anyone will ever have for removing it.
  const used = new Set();
  for (const e of entries) {
    if (e.verdict !== "allowed" || e.action !== "write" || !e.target) continue;
    for (const role of Object.values(config.roles))
      for (const glob of role.writes)
        if (role.name === e.role && covers(glob, e.target)) used.add(`${role.name} ${glob}`);
  }

  const unused = [];
  if (knowable)
    for (const role of Object.values(config.roles))
      for (const glob of role.writes)
        if (!used.has(`${role.name} ${glob}`)) unused.push({ role: role.name, glob });

  /* ── 3. what nobody owns ────────────────────────────────────────────── */

  const unowned = new Map();
  for (const e of entries) {
    if (!e.target || e.kind === "key") continue;
    if (ownersOf(config, e.target).length) continue;
    const dir = dirOf(e.target);
    unowned.set(dir, (unowned.get(dir) ?? 0) + 1);
  }

  return {
    friction,
    guarded,
    unused,
    unusedKnowable: knowable,
    unowned: [...unowned.entries()]
      .map(([where, times]) => ({ where, times }))
      .sort((a, b) => b.times - a.times),
  };
}

/** The directory a path sits in, or "." for a bare filename. */
function dirOf(p) {
  return p.split("/").slice(0, -1).join("/") || ".";
}
