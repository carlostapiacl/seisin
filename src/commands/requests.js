/**
 * `seisin requests`, `grant` and `deny` — the human end of the loop.
 *
 * These live in the CLI and in the console, and deliberately NOT in the MCP
 * server. An agent may ask and may draft; turning a request into policy takes a
 * person acting in a channel the agent does not have. That is the invariant the
 * whole feature rests on — see docs/permission-requests.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pending, settle, applyGrant, refuseIfBarred, requestsPath } from "../requests.js";
import { C, out } from "../render.js";

/**
 * Which request you meant — by position, or by the identity it carries.
 *
 * "Stable while you read it" was the old claim and it is false exactly where it
 * matters. The queue is filled by agents that are still running: on a live
 * repository it grew and shrank between a listing and the next command, and
 * `deny 1` settled a different request than the one printed as #1 seconds
 * earlier. That is time-of-check-to-time-of-use in the one command whose whole
 * job is deciding a permission, and it happened twice in one session.
 *
 * A position is still accepted, because reading a list and typing a number is
 * how anyone will use this. An argument that is not a number is matched against
 * the request's own id — `<role>:<action>:<path>` — which does not move when
 * the queue does. `seisin requests` prints it under each entry.
 *
 * An ambiguous match is refused rather than resolved. Choosing for you is the
 * failure being fixed.
 */
function pick(config, n) {
  const queue = pending(requestsPath(config.root));
  if (!queue.length) throw new Error("no pending requests");

  const arg = String(n).trim();
  if (/^\d+$/.test(arg)) {
    const req = queue[Number(arg) - 1];
    if (!req) throw new Error(`no request #${arg} — there are ${queue.length}`);
    return req;
  }

  const hits = queue.filter((r) => r.key === arg || r.key.startsWith(arg));
  if (hits.length === 1) return hits[0];
  if (!hits.length)
    throw new Error(
      `no pending request matches "${arg}".\n` +
      "  Use its number, or the id printed under it by `seisin requests`.");
  throw new Error(
    `"${arg}" matches ${hits.length} pending requests:\n` +
    hits.slice(0, 5).map((r) => `    ${r.key}`).join("\n") +
    "\n  Name one exactly. Choosing for you is the mistake this avoids.");
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
      // The stable way to name it: a number is a position in a queue that agents
      // are still writing to, and this does not move when the queue does.
      lines.push(`        ${C.dim}id ${r.key}${C.off}\n`);
    const note = handoffNote(r.handoff);
    if (note) lines.push(`        ${C.yellow}${note}${C.off}\n`);
  });
  lines.push(`\n    ${C.dim}seisin grant <n> [--reason "…"]   ·   seisin decline <n> [--reason "…"]${C.off}\n\n`);
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

  refuseIfBarred(config, req);
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
