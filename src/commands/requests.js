/**
 * `seisin requests`, `grant` and `deny` — the human end of the loop.
 *
 * These live in the CLI and in the console, and deliberately NOT in the MCP
 * server. An agent may ask and may draft; turning a request into policy takes a
 * person acting in a channel the agent does not have. That is the invariant the
 * whole feature rests on — see docs/permission-requests.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pending, settle, applyGrant, requestsPath } from "../requests.js";
import { C, out } from "../render.js";

/** Requests are addressed by position in the pending list — stable while you read it. */
function pick(config, n) {
  const queue = pending(requestsPath(config.root));
  const req = queue[Number(n) - 1];
  if (!req) throw new Error(queue.length ? `no request #${n} — there are ${queue.length}` : "no pending requests");
  return req;
}

export function requests(config) {
  const queue = pending(requestsPath(config.root));
  out(renderQueue(queue));
  return queue;
}

/** The pending queue as text. Pure, so the same list renders the same everywhere. */
export function renderQueue(queue) {
  if (queue.length === 0) return `\n  ${C.dim}no pending requests${C.off}\n\n`;

  const lines = [`\n  ${C.yellow}${queue.length} pending request(s)${C.off}\n\n`];
  queue.forEach((r, i) => {
    const owners = r.owners.length ? ` ${C.dim}(owned by ${r.owners.join(", ")})${C.off}` : ` ${C.dim}(unowned)${C.off}`;
    const times = r.times > 1 ? ` ${C.dim}· asked ${r.times}×${C.off}` : "";
    lines.push(`    ${C.b}#${i + 1}${C.off}  ${r.role} wants ${r.action} on ${C.b}${r.grant}${C.off}${owners}${times}\n`);
    lines.push(`        ${C.dim}first asked over ${r.target}${C.off}\n`);
    const note = handoffNote(r.handoff);
    if (note) lines.push(`        ${C.yellow}${note}${C.off}\n`);
  });
  lines.push(`\n    ${C.dim}seisin grant <n> [--reason "…"]   ·   seisin deny <n> [--reason "…"]${C.off}\n\n`);
  return lines.join("");
}

/**
 * One line saying why no worker is running for a request that is still open.
 *
 * Deliberately not a scheduler view. The failure this closes is narrow and
 * expensive: work that was refused admission, left the queue looking idle, and
 * was never done by anybody. A row that says which limit held it back is the
 * whole fix; deciding who retries and when is a separate question that this
 * does not have to answer first.
 */
export function handoffNote(h) {
  if (!h) return "";
  switch (h.outcome) {
    case "throttled":
      return `handoff held: ${limitWords(h.limit, h.role)} ${h.max}/${h.max} — still to do`;
    case "cycle":
      return `handoff stopped: ${h.role} is already in this chain — needs a person to split the work`;
    case "depth":
      return `handoff stopped: chain reached ${h.depth} of ${h.max} — needs a person`;
    case "human":
      return `handoff stopped: ${h.reason === "ambiguous" ? "more than one role owns this" : "no role owns this"}`;
    case "route":
      return `handed to ${h.role}`;
    case "resolved":
      return `no handoff needed — the policy moved and ${h.role} owns it now`;
    default:
      return `handoff outcome: ${h.outcome}`;
  }
}

/** The limit names are internal; what a person reads should not be a field name. */
function limitWords(limit, role) {
  if (limit === "senderChains") return "open chains for this role";
  if (limit === "receiverConcurrent") return `${role ?? "the owner"} already running`;
  return limit ?? "a limit";
}

export function grant(config, argv = []) {
  const req = pick(config, argv[0]);
  const i = argv.indexOf("--reason");
  const reason = i === -1 ? "" : argv[i + 1] ?? "";

  const before = readFileSync(config.path, "utf8");
  const { toml, changed } = applyGrant(before, req, reason);
  if (!changed) throw new Error(`${req.role} already has ${req.grant} — nothing to add`);

  writeFileSync(config.path, toml);
  settle(requestsPath(config.root), req.key, "granted", reason);
  out(
    `\n  ${C.green}granted${C.off}  ${req.role} → ${C.b}${req.grant}${C.off}\n` +
    `  ${C.dim}written into ${config.path} with its provenance. It applies on the next run.${C.off}\n\n`
  );
  return { request: req, grant: req.grant };
}

export function deny(config, argv = []) {
  const req = pick(config, argv[0]);
  const i = argv.indexOf("--reason");
  const reason = i === -1 ? "" : argv[i + 1] ?? "";

  settle(requestsPath(config.root), req.key, "denied", reason);
  out(
    `\n  ${C.yellow}declined${C.off}  ${req.role} ✕ ${req.grant}\n` +
    `  ${C.dim}${reason || "no reason recorded"}${C.off}\n\n`
  );
  return { request: req, reason };
}
