/**
 * `seisin explain` — ask one question, get the owner back.
 *
 * Exits 1 on a denial so it composes in a script: `seisin explain … || echo no`.
 * That is the only reason the exit code is not always 0 — a denial is an answer,
 * not a failure, but a shell has one channel for both.
 */
import { isAbsolute } from "node:path";
import { explain } from "../owners.js";
import { twinsOf, whereIs } from "../worktree.js";
import { renderVerdict, C, out } from "../render.js";

export function explainCommand(config, argv = []) {
  const [role, action, target] = argv;
  if (!role || !action || !target)
    throw new Error("usage: seisin explain <role> <read|write> <path-or-key>");
  if (!config.roles[role]) throw new Error(`unknown role "${role}"`);

  const verb = action.startsWith("r") ? "read" : "write";
  const verdict = explain(config, role, verb, target);
  out(renderVerdict(role, verb, target, verdict));

  const worktree = verb === "write" ? elsewhere(config, role, target, verdict) : [];
  for (const w of worktree) out(renderElsewhere(w));
  return { ...verdict, worktree };
}

/**
 * The same question, asked about the same file in the other checkouts.
 *
 * Only a twin that gets a DIFFERENT answer is worth a line. A worktree where
 * the role is equally allowed, or equally refused, changes nothing about what
 * was just printed, and a diagnosis that mentions it anyway is the noise this
 * tool keeps having to remove.
 *
 * The twin is asked about in the spelling the question used — root-relative
 * for a root-relative question — so the two answers come from the same rule
 * and differ only in where the file is.
 */
function elsewhere(config, role, target, verdict) {
  const { here, twins } = twinsOf(config, target);
  return twins
    .map((t) => ({ ...t, verdict: explain(config, role, "write", isAbsolute(target) ? t.path : t.rel) }))
    .filter((t) => t.verdict.allowed !== verdict.allowed)
    .map((t) => ({ ...t, here, where: whereIs(config, here, t), asked: verdict }));
}

/**
 * Three lines: where the other checkout is, what the answer is there, and
 * which of the two the policy names — the sentence the refusal never carried.
 */
function renderElsewhere(t) {
  const there = t.verdict.allowed
    ? `is inside ${t.verdict.owners.join(", ")}'s territory`
    : t.verdict.owners.length ? `belongs to ${t.verdict.owners.join(", ")}` : "has no owner";
  const named = t.asked.allowed ? t.here : t;
  const other = t.asked.allowed ? t : t.here;
  // "allowed" is the answer that misleads, so it is the one that gets told
  // where the refusal is. After "denied" that clause would only repeat it.
  const refused = t.asked.allowed ? ` — a write in ${kind(other)} is refused` : "";
  return (
    `  ${C.yellow}worktree${C.off}  ${t.where}\n` +
    `  ${C.dim}          the same file there is ${C.off}${C.b}${t.rel}${C.off}${C.dim}, and it ${there}.\n` +
    `            The policy names ${kind(named)}, not ${kind(other)}${refused}.${C.off}\n\n`
  );
}

const kind = (c) => (c.worktree ? "the worktree" : "the canonical checkout");
