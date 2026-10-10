/**
 * `seisin requests`, `grant` and `decline` — a person's end of the loop.
 *
 * These live in the CLI and in the console, and deliberately NOT in the MCP
 * server. An agent may ask and may draft; turning a request into policy takes a
 * person acting in a channel the agent does not have. That is the invariant the
 * whole feature rests on — see docs/permission-requests.md.
 */
import { pending, settle, applyGrant, refuseIfBarred, requestsPath, markStale, editPolicy, withDeclarers, shellId } from "../requests.js";
import { keyHolders } from "../owners.js";
import { loadConfig } from "../config.js";
import { read, logPath } from "../log.js";
import { C, out, safe } from "../render.js";

/**
 * Which request you meant — by position, or by the identity it carries.
 *
 * "Stable while you read it" was the old claim and it is false exactly where it
 * matters. The queue is filled by agents that are still running: on a live
 * repository it grew and shrank between a listing and the next command, and
 * `seisin deny 1` (now `decline`) settled a different request than the one printed as #1 seconds
 * earlier. That is time-of-check-to-time-of-use in the one command whose whole
 * job is deciding a request, and it happened twice in one session.
 *
 * A position is still accepted, because reading a list and typing a number is
 * how anyone will use this. An argument that is not a number is matched against
 * the request's own id — `<role>:<action>:<path>` — which does not move when
 * the queue does. `seisin requests` prints it under each entry.
 *
 * An ambiguous match is refused rather than resolved. Choosing for you is the
 * failure being fixed.
 */
function pick(config, n, verb = "grant") {
  if (n === undefined || n === "" || String(n).startsWith("--"))
    throw new Error(`usage: seisin ${verb} <n|id> [--reason "…"] — the numbers and ids are in: seisin requests`);
  const queue = queueOf(config);
  if (!queue.length) throw new Error("no pending requests");

  const arg = String(n).trim();
  if (/^\d+$/.test(arg)) {
    const req = queue[Number(arg) - 1];
    if (!req) throw new Error(`no request #${arg} — there are ${queue.length}`);
    return req;
  }

  // Exactly, never by prefix. A prefix let an id that had just been settled
  // select a newer request whose id merely starts the same (`lib` → `lib-x`),
  // and an agent chooses the paths ids are made of.
  const hit = queue.find((r) => r.key === arg);
  if (hit) return hit;
  const near = queue.filter((r) => r.key.startsWith(arg));
  throw new Error(
    `no pending request has the id "${arg}".\n` +
    (near.length
      ? `  ${near.length} start with it:\n` + near.slice(0, 5).map((r) => `    ${r.key}`).join("\n") +
        "\n  Name one exactly. Choosing for you is the mistake this avoids."
      : "  Use its number, or the id printed under it by `seisin requests`."));
}

/** The pending queue, with keys in the policy's own form and their declarers. */
export function queueOf(config) {
  return withDeclarers(config, pending(requestsPath(config.root), { keyDirs: config.keyDirs }));
}

export function requests(config) {
  const queue = markStale(queueOf(config), read(logPath(config.root)));
  out(renderQueue(queue));
  return queue;
}

/** The pending queue as text. Pure, so the same list renders the same everywhere. */
export function renderQueue(queue) {
  if (queue.length === 0) return `\n  ${C.dim}no pending requests${C.off}\n\n`;

  const lines = [`\n  ${C.yellow}${queue.length} pending request(s)${C.off}\n\n`];
  queue.forEach((r, i) => lines.push(...entryLines(r, i + 1)));
  lines.push(`\n    ${C.dim}seisin grant <n|id> [--reason "…"]   ·   seisin decline <n|id> [--reason "…"]${C.off}\n`);
  // Said, because it bites: grant #1 and the old #2 is #1 now.
  lines.push(`    ${C.dim}#n is a position and shifts as requests are settled; the id does not.${C.off}\n\n`);
  return lines.join("");
}

/**
 * What one run added to the queue, for the end of `seisin run`. Each entry
 * carries `n`, its number in the whole queue, so `grant <n>` works from here.
 */
export function renderAdded(added, older) {
  if (!added.length) return "";
  const lines = ["\n"];
  for (const r of added) lines.push(...entryLines(r, r.n));
  lines.push(`\n  ${C.dim}this run: ${added.length} new request(s)` +
    `${older ? ` · ${older} older pending` : ""} — seisin requests${C.off}\n\n`);
  return lines.join("");
}

function entryLines(r, n) {
  const lines = [];
  {
    const owners = r.declared
      ? ` ${C.dim}(${r.owners.length ? `declared by ${r.owners.join(", ")}` : "declared by no role"})${C.off}`
      : r.owners.length ? ` ${C.dim}(owned by ${r.owners.join(", ")})${C.off}` : ` ${C.dim}(unowned)${C.off}`;
    const times = r.times > 1 ? ` ${C.dim}· asked ${r.times}×${C.off}` : "";
    lines.push(`    ${C.b}#${n}${C.off}  ${safe(r.role)} wants ${r.action} on ${C.b}${safe(r.grant)}${C.off}${owners}${times}\n`);
    lines.push(`        ${C.dim}first asked over ${safe(r.target)}${C.off}\n`);
      // The stable way to name it: a number is a position in a queue that agents
      // are still writing to, and this does not move when the queue does.
      lines.push(`        ${C.dim}id ${safe(r.key)}${C.off}\n`);
    // Marked, not moved: the number above is what `grant <n>` is typed against.
    if (r.stale)
      lines.push(`        ${C.dim}not asked again in ${r.stale.runs} runs of ${r.role} since — likely no longer needed${C.off}\n`);
    const note = handoffNote(r.handoff);
    if (note) lines.push(`        ${C.yellow}${note}${C.off}\n`);
  }
  return lines;
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
      return `handoff stopped: ${h.role} is already in this handoff chain — needs a person to split the work`;
    case "depth":
      return `handoff stopped: handoff chain reached ${h.depth} of ${h.max} — needs a person`;
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
  if (limit === "senderChains") return "open handoff chains for this role";
  if (limit === "receiverConcurrent") return `${role ?? "the owner"} already running`;
  return limit ?? "a limit";
}

export function grant(config, argv = []) {
  const i = argv.indexOf("--reason");
  const reason = i === -1 ? "" : argv[i + 1] ?? "";

  // Looked up, applied and settled under one lock — the one the console's
  // decide takes too. Picking before the lock let this and the console both
  // find the same request open and act on it twice.
  let req;
  const { changed } = underLock(() => editPolicy(config, (before) => {
    const current = loadConfig(config.path, before);
    req = pick(current, argv[0], "grant");
    refuseIfBarred(current, req);
    return applyGrant(before, req, reason);
  }, { after: () => settle(requestsPath(config.root), req.key, "granted", reason) }));
  // Already in the policy: the request is answered all the same, as the
  // console answers it. Throwing here left it pending forever — the person had
  // said yes, the role had the path, and the queue kept asking.
  if (!changed) {
    out(
      `\n  ${C.green}already granted${C.off}  ${req.role} → ${C.b}${req.grant}${C.off}\n` +
      `  ${C.dim}${config.path} already gives it; nothing written, the request is closed.${C.off}\n\n`
    );
    out(remaining(config));
    return { request: req, grant: req.grant, changed: false };
  }

  // A key another role declares is shared by this grant, not moved: both roles
  // read it from now on. That is sometimes the point, and never a thing to find
  // out later.
  const others = req.action === "read" ? keyHolders(config, req.target).filter((r) => r !== req.role) : [];
  out(
    `\n  ${C.green}granted${C.off}  ${req.role} → ${C.b}${req.grant}${C.off}\n` +
    (others.length
      ? `  ${C.yellow}shared: ${req.grant} is also declared by ${others.join(", ")} — both roles read it now${C.off}\n`
      : "") +
    `  ${C.dim}written into ${config.path} with its provenance. It applies on the next run.${C.off}\n\n`
  );
  out(remaining(config));
  return { request: req, grant: req.grant, shared: others };
}

/** A held lock is another decision in flight, not a failure of this one. */
function underLock(fn) {
  try {
    return fn();
  } catch (e) {
    if (e.code === "ELOCKED")
      throw new Error("another decision is in progress — run this again in a moment");
    throw e;
  }
}

export function deny(config, argv = []) {
  const i = argv.indexOf("--reason");
  const reason = i === -1 ? "" : argv[i + 1] ?? "";

  // The policy is not edited, but the lock is still the policy's: it is the one
  // every decision takes, so a decline cannot settle what a grant is applying.
  let req;
  underLock(() => editPolicy(config, (before) => {
    req = pick(config, argv[0], "decline");
    return { toml: before, changed: false };
  }, { after: () => settle(requestsPath(config.root), req.key, "denied", reason) }));
  out(
    `\n  ${C.yellow}declined${C.off}  ${req.role} ✕ ${req.grant}\n` +
    `  ${C.dim}${reason || "no reason recorded"}${C.off}\n\n`
  );
  out(remaining(config));
  return { request: req, reason };
}

/**
 * The queue after a decision, numbered as it now is.
 *
 * Numbers are positions: settling #1 makes the old #2 the new #1, and the next
 * `grant 2` — typed from the listing still on screen — lands on what used to
 * be #3. One line with the new numbering, so the screen is right again.
 */
export function remaining(config) {
  const queue = queueOf(config);
  if (!queue.length) return `  ${C.dim}no requests left${C.off}\n\n`;
  const shown = queue.slice(0, 5).map((r, i) => `#${i + 1} ${safe(r.role)} ${r.action} ${safe(r.grant)}`);
  const more = queue.length > 5 ? ` · +${queue.length - 5} more` : "";
  return `  ${C.dim}left, renumbered: ${shown.join(" · ")}${more}${C.off}\n\n`;
}
