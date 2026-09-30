/**
 * The walls a role has already hit.
 *
 * seisin answers *whose is this* at the moment of the refusal, once, in the
 * middle of a turn, and then the sentence is gone. Nothing carries it forward,
 * so the agent tries again — and the measurement that made this module exist
 * says how often: of 345 denials in a multi-repo workspace, **88 (25%) were a repeat of
 * something that same role had already been denied**. One role spent 37 calls
 * on two walls, hitting the same one nineteen times.
 *
 * A block that repeats nineteen times is not a boundary working. It is a
 * boundary that failed to communicate. The refusal was correct every time and
 * still cost thirty-seven calls, because *correct* and *heard* are different
 * properties and only one of them was being measured.
 *
 * So this reads what the role has already been told and hands it back, with
 * the reason — the reason is the part that lets it look for the other way in.
 *
 * ## Why it recomputes instead of trusting the log
 *
 * The obvious version of this is a time window: only count the last two days,
 * because an old wall may have been granted since and telling an agent not to
 * do something it can now do is worse than saying nothing. That is what the
 * prior art does, and the window is a proxy for the thing you actually want to
 * know.
 *
 * seisin can ask the real question instead. The policy is right here, so every
 * candidate is checked against it **now**: if the role would be allowed today,
 * it is not a wall, whatever the log says. Same move as `owners` and the
 * request queue — recompute rather than believe — and it means a grant makes
 * its wall disappear on the next turn instead of two days later.
 *
 * A window is still accepted, and still useful for a different reason: a
 * refusal from three weeks ago is noise even if it is still refused today.
 */
import { read, readEntries } from "./log.js";
import { explain } from "./owners.js";
import { STALE_RUNS, RUN_GAP_MS, runsAfter } from "./requests.js";

/** A wall is something you hit more than once. Once is information; twice is a pattern. */
export const MIN_HITS = 2;

/**
 * What `role` keeps being denied, most-repeated first.
 *
 * Each entry is `{ action, target, times, reason, owners, firstAt, lastAt }`.
 * The grain is action+target, not the directory above it: two writes into two
 * different repositories are two walls, and merging them hides which one was
 * hit.
 */
export function walls(config, role, { file, entries = null, min = MIN_HITS, since = null, limit = 6, fresh = false, ask = explain } = {}) {
  // `entries`: the log already read, for a caller asking about every role at
  // once (the console asks for 32 on a real policy) — one read instead of 32.
  const denied = entries
    ? entries.filter((e) => e.role === role && e.verdict === "denied" && (!since || e.at >= since))
    : read(file, { role, verdict: "denied", ...(since ? { since } : {}) });

  const byKey = new Map();
  for (const e of denied) {
    if (!e.target || !e.action) continue;
    const key = `${e.action}\u0000${e.target}`;
    const seen = byKey.get(key);
    if (seen) { seen.times++; seen.lastAt = e.at; continue; }
    byKey.set(key, { action: e.action, target: e.target, times: 1, firstAt: e.at, lastAt: e.at });
  }

  const out = [];
  for (const w of byKey.values()) {
    if (w.times < min) continue;
    // The policy as it stands, not as it stood. A granted wall is not a wall,
    // and the whole point of saying this to an agent is that it is true now.
    // `ask` is explain, or a remembered one (views.js) for a caller asking
    // about every role at once.
    const verdict = ask(config, role, w.action, w.target);
    if (verdict.allowed) continue;
    out.push({ ...w, reason: verdict.reason, owners: verdict.owners });
  }
  // A wall the role stopped hitting — it ran STALE_RUNS times since, refused
  // elsewhere but not here — is still true and no longer worth saying. Same
  // rule as an old request. `fresh` drops them; otherwise they are marked.
  for (const w of out) {
    const n = runsAfter(denied, Date.parse(w.lastAt), RUN_GAP_MS);
    if (n >= STALE_RUNS) w.stale = { runs: n };
  }
  const kept = fresh ? out.filter((w) => !w.stale) : out;
  kept.sort((a, b) => b.times - a.times || a.target.localeCompare(b.target));
  return limit > 0 ? kept.slice(0, limit) : kept;
}

/**
 * How much of the log `timesHit` will look at.
 *
 * The log is append-only and a segment only rotates at 8 MiB, so "read the
 * file" is O(everything since the last rotation), on a path that runs inside
 * the hook. Measured on a 372 KB log: 3 ms per
 * call, which is nothing, and 300 ms at 37 MB, which is not, on every denial
 * of every session forever.
 *
 * So it reads the tail. That makes the count **recent repetition** rather than
 * lifetime repetition, and recent is the one the sentence is about anyway: an
 * agent being told "you have hit this three times" means this session, not
 * last month. 4 MB is thousands of entries — far more than a turn produces,
 * and bounded. Right after a rotation the tail is short, and so is the count:
 * the current segment only, on purpose.
 */
const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * How many times this exact denial is already in the recent log for this role.
 *
 * Deliberately NOT the same question as `walls()`: no policy recomputation, no
 * threshold. The hook calls this while deciding, and the only thing it needs is
 * a count — the policy has just been consulted, so asking it again would be
 * asking a question already answered, in the one place that runs on every tool
 * call.
 */
export function timesHit(file, role, action, target) {
  // The line the tail cut lands in is dropped (readLines checks the byte before
  // the cut, so a cut on a boundary keeps it). Comparing the file's byte size
  // with the text's UTF-16 length used to decide that, and with any multibyte
  // character in the tail it kept the fragment of a line or dropped a whole one.
  let n = 0;
  for (const e of readEntries(file, { tail: TAIL_BYTES }))
    if (e.role === role && e.verdict === "denied" && e.action === action && e.target === target) n++;
  return n;
}

/**
 * The calls that went into hitting the same wall twice or more.
 *
 * `times - 1` per wall, because the first one is the agent finding out. Every
 * one after that is the cost of not having been able to remember.
 */
export function wasted(list) {
  return list.reduce((n, w) => n + w.times - 1, 0);
}

/**
 * The block an agent reads, or `""` when there is nothing to say.
 *
 * Empty rather than "no walls found", because this goes into a prompt: a line
 * that says nothing happened, every turn, is how an agent learns to skip the
 * whole section — and then the one turn it matters, it is skipped too.
 */
export function render(list) {
  if (!list.length) return "";
  const lines = [
    "WALLS — you have already been denied these, and the policy still denies them.",
    "Do not retry; the reason is where the other way in is.",
  ];
  for (const w of list) {
    lines.push(`  ${w.times}× ${w.action} ${w.target}`);
    // The reason for an owned path starts with the path again; the owner is the news.
    lines.push(`      ${w.owners?.length ? `belongs to ${w.owners.join(", ")}` : w.reason}`);
  }
  const n = wasted(list);
  // Said to the agent, not about it. One that can see what retrying cost has a
  // reason to stop; one told "do not retry" has an instruction.
  if (n > 0) lines.push(`  (${n} of your calls went into retrying these.)`);
  return lines.join("\n") + "\n";
}
