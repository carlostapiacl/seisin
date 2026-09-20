/**
 * The walls a role has already hit.
 *
 * seisin answers *whose is this* at the moment of the refusal, once, in the
 * middle of a turn, and then the sentence is gone. Nothing carries it forward,
 * so the agent tries again — and the measurement that made this module exist
 * says how often: of 345 blocks on a real team, **88 (25%) were a repeat of
 * something that same role had already been refused**. One role spent 37 calls
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
import { read } from "./log.js";
import { explain } from "./owners.js";

/** A wall is something you hit more than once. Once is information; twice is a pattern. */
export const MIN_HITS = 2;

/**
 * What `role` keeps being refused, most-repeated first.
 *
 * Each entry is `{ action, target, times, reason, owners, firstAt, lastAt }`.
 * The grain is action+target and it is deliberately not collapsed to a
 * directory: two writes into two different repositories are two walls, and
 * merging them hides which one the agent actually hit.
 */
export function walls(config, role, { file, min = MIN_HITS, since = null, limit = 6 } = {}) {
  const denied = read(file, { role, verdict: "denied", ...(since ? { since } : {}) });

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
    const verdict = explain(config, role, w.action, w.target);
    if (verdict.allowed) continue;
    out.push({ ...w, reason: verdict.reason, owners: verdict.owners });
  }
  out.sort((a, b) => b.times - a.times || a.target.localeCompare(b.target));
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * How many times this exact refusal is already in the log for this role.
 *
 * Deliberately NOT the same question as `walls()`: no policy recomputation, no
 * threshold, no window. The hook calls this while deciding, and the only thing
 * it needs is a count — the policy has just been consulted, so asking it again
 * would be asking a question already answered, in the one place that runs on
 * every tool call.
 */
export function timesHit(file, role, action, target) {
  let n = 0;
  for (const e of read(file, { role, verdict: "denied" }))
    if (e.action === action && e.target === target) n++;
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
    "WALLS — you have already been refused these, and the policy still refuses them.",
    "Do not retry; the reason is where the other way in is.",
  ];
  for (const w of list) {
    lines.push(`  ${w.times}× ${w.action} ${w.target}`);
    lines.push(`      ${w.reason}`);
  }
  const n = wasted(list);
  // Said to the agent, not about it. The number is the point: an agent that
  // can see what retrying cost has a reason to stop, and one that is only told
  // "do not retry" has an instruction.
  if (n > 0) lines.push(`  (${n} of your calls went into retrying these.)`);
  return lines.join("\n") + "\n";
}
