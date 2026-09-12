/**
 * `seisin explain` — ask one question, get the owner back.
 *
 * Exits 1 on a denial so it composes in a script: `seisin explain … || echo no`.
 * That is the only reason the exit code is not always 0 — a denial is an answer,
 * not a failure, but a shell has one channel for both.
 */
import { explain } from "../owners.js";
import { renderVerdict, out } from "../render.js";

export function explainCommand(config, argv = []) {
  const [role, action, target] = argv;
  if (!role || !action || !target)
    throw new Error("usage: seisin explain <role> <read|write> <path-or-key>");
  if (!config.roles[role]) throw new Error(`unknown role "${role}"`);

  const verb = action.startsWith("r") ? "read" : "write";
  const verdict = explain(config, role, verb, target);
  out(renderVerdict(role, verb, target, verdict));
  return verdict;
}
