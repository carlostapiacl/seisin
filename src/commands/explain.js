/**
 * `seisin explain` — ask one question, get the owner back.
 *
 * Exits 1 on a denial so it composes in a script: `seisin explain … || echo no`.
 * That is the only reason the exit code is not always 0 — a denial is an answer,
 * not a failure, but a shell has one channel for both.
 */
import { toRepoRelative, fromCwd } from "../paths.js";
import { isAbsolute } from "node:path";
import { explain, readTarget } from "../owners.js";
import { unknownRole } from "../suggest.js";
import { twinsOf, whereIs } from "../worktree.js";
import { renderVerdict, C, out } from "../render.js";

export function explainCommand(config, argv = []) {
  const [role, action, target] = argv;
  if (!role || !action || !target)
    throw new Error("usage: seisin explain <role> <read|write|mcp> <path, key or MCP server>");
  if (!config.roles[role]) throw unknownRole(config, role);
  // Anything else used to be answered as a write, confidently, to a question
  // nobody asked. An unknown action is a usage error, like an unknown flag.
  if (!["read", "write", "mcp"].includes(action))
    throw new Error(`unknown action "${action}" — use read, write or mcp`);

  if (action === "mcp") {
    const verdict = explain(config, role, "mcp", target);
    out(renderVerdict(role, "mcp", target, verdict));
    return { ...verdict, worktree: [] };
  }

  const verb = action;

  if (verb === "read") {
    const asked = readTarget(config, target);
    const verdict = explain(config, role, "read", target, process.cwd());
    out(renderVerdict(role, verb, asked.target, verdict));
    return { ...verdict, worktree: [] };
  }

  /**
   * An absolute path inside the repo is the same question as the relative one.
   *
   * It was not being read that way: the policy is written in repo-relative
   * paths, so an absolute target matched nothing and came back **denied — has
   * no owner**, for a file its role could write perfectly well. `whose` has
   * always stripped the root; the hook does too. Only this command did not, so
   * the two answered differently about the same file, and the one people run to
   * check a boundary was the one that was wrong.
   *
   * Wrong in the direction that matters, too: it reported a path as unowned and
   * denied while the kernel allowed it — see "Refusing beats widening" in
   * docs/decisions.md. A path outside the root is left exactly as written,
   * because that is a question about somewhere else and it still deserves its
   * honest "no owner".
   */
  //
  // A relative path is relative to where you are standing, as in every other
  // command line tool: from frontend/src, `app.js` is frontend/src/app.js. It
  // was read against the policy's root, so the same question asked from a
  // subdirectory came back "no owner". The answer prints the path the policy
  // was asked about, so the reader sees which file was meant.
  const asked = toRepoRelative(config, fromCwd(config, target));

  const verdict = explain(config, role, verb, asked);
  out(renderVerdict(role, verb, asked, verdict));

  const worktree = elsewhere(config, role, isAbsolute(target) ? target : asked, verdict);
  for (const w of worktree) out(renderElsewhere(w));
  return { ...verdict, worktree };
}

/**
 * The same question, asked about the same file in the other checkouts.
 *
 * Only a twin that gets a DIFFERENT answer is worth a line. A worktree where
 * the role is equally allowed, or equally denied, changes nothing about what
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
 * which of the two the policy names — the sentence the denial never carried.
 */
function renderElsewhere(t) {
  const there = t.verdict.allowed
    ? `is inside ${t.verdict.owners.join(", ")}'s territory`
    : t.verdict.owners.length ? `belongs to ${t.verdict.owners.join(", ")}` : "has no owner";
  const named = t.asked.allowed ? t.here : t;
  const other = t.asked.allowed ? t : t.here;
  // "allowed" is the answer that misleads, so it is the one that gets told
  // where the denial is. After "denied" that clause would only repeat it.
  const denied = t.asked.allowed ? ` — a write in ${kind(other)} is denied` : "";
  return (
    `  ${C.yellow}worktree${C.off}  ${t.where}\n` +
    `  ${C.dim}          the same file there is ${C.off}${C.b}${t.rel}${C.off}${C.dim}, and it ${there}.\n` +
    `            The policy names ${kind(named)}, not ${kind(other)}${denied}.${C.off}\n\n`
  );
}

const kind = (c) => (c.worktree ? "the worktree" : "the canonical checkout");
