/**
 * Who a refused write should be handed to — decided, not executed.
 *
 * Nothing in here spawns, connects, reads a file or talks to a model. It takes
 * the request, the policy as it stands right now, the chain it belongs to and
 * what the sender and receiver already have running, and returns one decision.
 * Something else acts on it.
 *
 * That split is the whole reason this file exists separately. The rules below
 * are the security semantics of a handoff, and security semantics that live
 * inside a function which also does `child_process.spawn` cannot be tested
 * without starting an agent — so in practice they stop being tested.
 *
 * ── The one property everything here serves ──
 * A model may influence content, which path it reaches for, and therefore the
 * *demand* for work. It may not determine authority, routing identity,
 * admission or policy. Every input below is either derived from the boundary
 * or supplied by the caller; none of them is a role name a model chose.
 *
 * ── Where the decision is made ──
 * Where the request is read, not where it is written. Every reader of the
 * queue — `seisin requests`, the end of `seisin run`, the notification, the
 * console, the MCP — gets it from requests.js (withHandoffs), against the
 * policy in front of it, so a grant made since changes it at once. What is
 * written down is only history: the chain a request was asked in, set by the
 * parent of a run started with `--handoff`, and what the execution plane did
 * about it (recordHandoff). Reads go to a person: a key is shared by a grant,
 * never handed over.
 */
import { ownersOf, keyHolders, inKeyDir } from "./owners.js";

/** Small on purpose: a fuse for a topology nobody predicted, not a budget. */
export const MAX_DEPTH = 4;

/**
 * Ownership is recomputed here, and the stored `owners` on the request is not
 * consulted at all.
 *
 * A request carries the owners as they were when the denial happened. Between
 * then and now a person may have changed the policy — that is the entire point
 * of the queue. The stored value is historical evidence; the authority is the
 * policy in front of us.
 */
export function decideHandoff({
  request,
  config,
  chain = null,
  limits = {},
  load = {},
  revision = null,
}) {
  if (!request || !request.role || !request.target)
    throw new Error("decideHandoff: request needs at least { role, target }");
  if (!config || !config.roles) throw new Error("decideHandoff: config needs roles");

  const depthMax = limits.depth ?? MAX_DEPTH;
  // A caller may provide incomplete history. The requester is always visited.
  const visited = [...new Set([...(chain?.visited ?? []), request.role])];
  const depth = chain?.depth ?? 0;
  const at = (type, extra = {}) => ({ type, revision, chainId: chain?.id ?? null, ...extra });

  /**
   * A read is not handed to anybody. A key is declared, not owned, and the
   * only thing that changes who reads it is a person sharing it; another
   * role's private folder is the policy working. Who declares or owns it is
   * still worked out here — the queue shows it — but the decision is a
   * person's, unless the policy already moved and the asker has it now.
   */
  if (request.action === "read") {
    const key = isKeyRequest(config, request);
    const holders = key ? keyHolders(config, request.target) : ownersOf(config, request.target);
    if (holders.includes(request.role))
      return at("resolved", { resolution: "policy_changed", role: request.role, owners: holders });
    return at("human", { reason: key ? "key" : "read", owners: holders });
  }

  const owners = ownersOf(config, request.target);

  /**
   * Authority first, admission second, and the order is not cosmetic.
   *
   * The two outcomes below start no worker at all, so they must not be able to
   * be turned into a throttle or a cycle report by load or by chain shape. A
   * request whose target nobody owns is a hole in the policy whichever way the
   * budget happens to be sitting, and one that the asker now owns is finished.
   * Reporting either as CYCLE or THROTTLED would send a person to look at the
   * wrong thing.
   */
  if (owners.length === 0) return at("human", { reason: "unowned", owners });

  /**
   * The policy moved and the asker owns it now. Nobody granted anything, so
   * this is not `granted` — it is a request that stopped existing, and saying
   * so is what keeps the human queue readable. Sending this to a person would
   * be asking them to decide something already decided.
   */
  if (owners.length === 1 && owners[0] === request.role)
    return at("resolved", { resolution: "policy_changed", role: request.role, owners });

  /**
   * Only an owner that takes handed work can be handed it.
   *
   * A role marked `handoff = false` is a pipeline phase, not a worker: it owns
   * its territory — often all of it, `**` — and starting it because some other
   * role reached for a file there would run a phase for a reason that has
   * nothing to do with it. So it is left out of the choice, and the existing
   * rule runs over who is left: one receiver is a route, several are for a
   * person, and none is a person's too, with a reason that says the owner is
   * there and does not take the work. Ownership itself is untouched — the
   * queue and the agent still hear whose it is.
   */
  const receivers = owners.filter((o) => config.roles[o]?.handoff !== false);
  const narrowed = receivers.length < owners.length ? { receivers } : {};
  if (receivers.length === 0) return at("human", { reason: "no-receiver", owners, receivers });
  if (receivers.length > 1) return at("human", { reason: "ambiguous", owners, ...narrowed });

  const [owner] = receivers;
  // The asker is that one receiver: it owns the path now, whoever else does.
  if (owner === request.role)
    return at("resolved", { resolution: "policy_changed", role: owner, owners });

  /**
   * A role already in this chain does not get re-entered, even for a different
   * file. Work that crosses a boundary and needs to come back has stopped being
   * a handoff and become multi-role coordination; that is a decomposition a
   * person should make on purpose.
   */
  if (visited.includes(owner))
    return at("cycle", { role: owner, owners, visited: [...visited] });

  if (depth + 1 > depthMax)
    return at("depth", { role: owner, owners, depth: depth + 1, max: depthMax });

  /**
   * Bounded invocation. A role cannot write another role's territory, but it
   * can *reach for* it as often as it likes, and each refusal is a way to make
   * another role run. Filesystem authority was already closed; this closes
   * cross-role invocation, which is a separate resource.
   *
   * Throttling is never silent: the decision says which limit stopped it, so a
   * queue can show work that is waiting rather than let it evaporate.
   */
  const senderMax = limits.senderChains ?? Infinity;
  if ((load.senderOpenChains ?? 0) >= senderMax)
    return at("throttled", { role: owner, owners, limit: "senderChains", max: senderMax });

  const receiverMax = limits.receiverConcurrent ?? Infinity;
  if ((load.receiverRunning ?? 0) >= receiverMax)
    return at("throttled", { role: owner, owners, limit: "receiverConcurrent", max: receiverMax });

  return at("route", {
    role: owner,
    owners,
    ...narrowed,
    depth: depth + 1,
    visited: [...visited, owner],
  });
}

/**
 * Whether a read request is for a key: inside a key directory, or a bare name,
 * which is how a key in the first key directory is written.
 */
export function isKeyRequest(config, request) {
  const t = request?.target;
  return request?.action === "read" && typeof t === "string" && (inKeyDir(config, t) || !t.includes("/"));
}

/**
 * The chain a request belongs to, as decideHandoff takes it.
 *
 * A request filed by a run that was itself handed work carries the chain that
 * run was started with (see chainFrom); one filed by any other run starts a
 * chain of its own, named by its own id. Never read from inside the sandbox:
 * the parent writes it, from the decision it checked before starting the run.
 */
export function chainOf(request) {
  const c = request?.chain;
  const ok = c && typeof c.id === "string" && Number.isInteger(c.depth) && c.depth >= 0 &&
    Array.isArray(c.visited) && c.visited.every((r) => typeof r === "string");
  return ok ? { id: c.id, depth: c.depth, visited: [...c.visited] } : { id: request?.key ?? null, depth: 0, visited: [] };
}

/**
 * What a run started for a routed decision carries into the requests it files.
 * Null for anything but a route: only a route starts work.
 */
export function chainFrom(decision) {
  if (decision?.type !== "route") return null;
  return { id: decision.chainId, depth: decision.depth, visited: [...decision.visited] };
}

/**
 * The variable `seisin run --handoff` sets in the receiver's environment, so
 * the hook inside can word a denial with the chain the run belongs to.
 *
 * Words only. The chain a request is recorded in is the parent's, written by
 * intake from the run it started (requests.js, record), and nothing read from
 * here reaches the queue. A process inside that rewrote it would change the
 * sentence it is told about its own denial, and nothing else. Reserved, so a
 * policy cannot deliver a key under this name (keys.js, RESERVED_ENV).
 */
export const CHAIN_ENV = "SEISIN_HANDOFF_CHAIN";

/** The run's chain from its environment, or null: absent and malformed are the same. */
export function chainFromEnv(env = process.env) {
  const raw = env?.[CHAIN_ENV];
  if (!raw) return null;
  let c;
  try { c = JSON.parse(raw); } catch { return null; }
  const ok = c && typeof c === "object" && typeof c.id === "string" && Number.isInteger(c.depth) && c.depth >= 0 &&
    Array.isArray(c.visited) && c.visited.every((r) => typeof r === "string");
  return ok ? { id: c.id, depth: c.depth, visited: [...c.visited] } : null;
}

/**
 * The decision as the denied agent is told it: whose the path is, where the
 * work goes, and what to do instead of retrying. One sentence, the same from
 * the PreToolUse hook, after a failed tool call and from `seisin whose`.
 *
 * It informs and offers nothing to act with. Every role it names is one the
 * policy named; it never asks the agent to pick one, and there is no answer
 * the agent can give back that would change who takes the work — the queue
 * decides that again, from the policy, whenever it is read.
 */
export function toAgent(decision, { target, role, key = null, again = "" }) {
  const d = decision ?? {};
  // Where a chain stops, the agent is not told whose the file is, or the chain
  // it came along. Measured: with the owner in the message, two runs of three
  // added whose file it was after the sentence they were told to say alone.
  if (isStopped(d))
    return `${target} is not ${role}'s to change, and its handoff chain stops here: ` +
      (d.type === "cycle" ? "handing it on would send it back the way it came." : `${d.depth} of ${d.max} deep.`) +
      ` A person decides. Do not work around it. ${ELSEWHERE}${again}` + stopped(d, target, key);
  const owners = d.owners ?? [];
  const whose = d.reason === "key"
    ? (owners.length ? `${target} is declared for ${owners.join(", ")}, not ${role}.` : `No role declares ${target}.`)
    : owners.length
      ? `${target} belongs to ${owners.join(", ")}. It is not ${role}'s to change.`
      : `${target} has no owner.`;
  // A key or a read is not a change to put somewhere else.
  const write = d.reason !== "key" && d.reason !== "read" && d.type !== "resolved";
  return `${whose} ${nextStep(d, role)}` + (write ? ` ${ELSEWHERE}` : "") + again;
}

/** A chain that stops: a cycle, or one too deep. Its denial ends on the sentence to pass on. */
export function isStopped(decision) {
  return decision?.type === "cycle" || decision?.type === "depth";
}

/**
 * Where a handoff chain stops, the words to pass on, given literally.
 *
 * Measured with real runs: told "not that frontend will make the change", an
 * agent stopped saying frontend would make it and, in one run of two, told
 * its user to go and coordinate with frontend instead. A negative instruction
 * leaves the agent to compose the sentence; this one hands it over.
 */
function stopped(d, target, key) {
  const waiting = key ? `the request ${key} is waiting in seisin requests` : "the request is waiting in seisin requests";
  // Measured again with the literal words: passed on in three runs of three,
  // and then contradicted in two, by an agent adding who should do it or where
  // else it could go. So the sentence ends on that, too. Measured a third time:
  // no run added either, but one added whose file it was, and one dropped the
  // path from the front ("Not written. …"). So both are said as well. And
  // nothing comes after the sentence: what not to add is said first, so the
  // quote is the last thing the agent reads (hook.js ends the denial on it).
  return " About this file, tell whoever sent you one sentence and add nothing to it: not whose file it is, " +
    "who should do it or where else it could go. The sentence, word for word and starting with the path: " +
    `"${target} was not written. A person has to decide who does it; ${waiting}."`;
}

/**
 * What "working around it" means, said once. Measured: an agent that would
 * never retry the write still offered, twice, to leave the file in a folder of
 * its own — the same change, under a path nobody reviews.
 */
export const ELSEWHERE = "Do not put the change somewhere else instead (another path, a copy, /tmp).";

/**
 * How the denial ends: that it is already queued, and for whom. Said apart
 * from toAgent because only a denial that files a request may say it — the
 * note after a failed call and `seisin whose` file nothing.
 *
 * A route ends on the role it goes to. Ending it on "a person", as every
 * denial once did, told the agent two owners in one sentence, and with a
 * handoff chain in it the agent repeated the wrong one.
 */
export function queuedLine(decision) {
  return decision?.type === "route"
    ? `Already queued as a handoff to ${decision.role}: a run of ${decision.role}, or a person, picks it up — retrying or waiting will not move it.`
    : "Already queued for a person to answer — retrying or waiting will not move it.";
}

/** What to do about it, from the decision alone: the second half of toAgent, and `seisin whose`. */
export function nextStep(decision, role) {
  const d = decision ?? {};
  switch (d.type) {
    case "route":
      return `It is handed to ${d.role}` +
        (d.depth > 1 ? ` (handoff chain ${(d.visited ?? []).join(" → ")}, ${d.depth} of ${MAX_DEPTH} deep)` : "") +
        ": hand it over rather than working around it.";
    case "human":
      if (d.reason === "key") return "Ask for what you need from it rather than reading the key.";
      if (d.reason === "no-receiver")
        return `${(d.owners ?? []).join(", ") || "Its owner"} ${(d.owners ?? []).length > 1 ? "do" : "does"} not take handed work, ` +
          "so a person decides who takes it. Do not work around it.";
      return d.reason === "ambiguous"
        ? "With more than one owner, a person decides who takes it. Do not pick one, and do not work around it."
        : "A person decides who takes it. Do not work around it.";
    // Measured: told only "not handed back", an agent still told its user
    // that the owner would make the change. It has to hear that nothing is
    // asked of the owner, and what to say instead.
    case "cycle":
      return `It is not handed back to ${d.role}: this work already came through ${d.role} ` +
        `(handoff chain ${(d.visited ?? []).join(" → ")}), so nothing is asked of ${d.role}. ` +
        "A person decides how to split it. Do not work around it.";
    case "depth":
      return `The handoff chain stops here, ${d.depth} of ${d.max} deep. A person decides. Do not work around it.`;
    case "resolved":
      return `The policy now gives it to ${role}: the next run has it.`;
    default: {
      const said = describeHandoff(d) || "a person decides";
      return `${said[0].toUpperCase()}${said.slice(1)}. Do not work around it.`;
    }
  }
}

/**
 * The decision in words a person reads, one line, no colour.
 *
 * `attempt` is what the execution plane last recorded about the request
 * (requests.js, recordHandoff). It is shown only where seisin's own decision
 * is a route to the same role: whether that role could be started is
 * admission, which only whatever starts it knows. Every other outcome is the
 * policy's, recomputed now, and a recorded attempt cannot overrule it.
 */
export function describeHandoff(decision, attempt = null, chainStopped = null) {
  const said = describeDecision(decision, attempt);
  // A run took it and its chain then stopped further on: the request is still
  // pending, and without this it read as handed and done.
  return said && chainStopped?.length
    ? `${said}; its handoff chain stopped at ${chainStopped.join(", ")}, which needs a person`
    : said;
}

function describeDecision(decision, attempt) {
  const d = decision;
  if (!d) return "";
  if (d.type === "route" && attempt && attempt.role === d.role) {
    if (attempt.outcome === "throttled")
      return `handoff held: ${limitWords(attempt.limit, attempt.role)} ${attempt.max}/${attempt.max} — still to do`;
    if (attempt.outcome === "route") return `handed to ${d.role} — a run of ${d.role} took it`;
  }
  switch (d.type) {
    case "route":
      return `handed to ${d.role}` + (d.depth > 1 ? ` (handoff chain, ${d.depth} of ${MAX_DEPTH})` : "");
    case "throttled":
      return `handoff held: ${limitWords(d.limit, d.role)} ${d.max}/${d.max} — still to do`;
    case "cycle":
      return `handoff stopped: ${d.role} is already in this handoff chain — needs a person to split the work`;
    case "depth":
      return `handoff stopped: handoff chain reached ${d.depth} of ${d.max} — needs a person`;
    case "human":
      if (d.reason === "ambiguous") return `a person decides: more than one role owns this (${(d.receivers ?? d.owners).join(", ")})`;
      if (d.reason === "no-receiver")
        return `a person decides: ${d.owners.join(", ")} ${d.owners.length > 1 ? "own" : "owns"} this and ${d.owners.length > 1 ? "take" : "takes"} no handed work (handoff = false)`;
      if (d.reason === "key") return "a person decides: a key is shared by a grant, never handed over";
      if (d.reason === "read") return "a person decides: a read is not handed over";
      return "a person decides: no role owns this";
    case "resolved":
      return `no handoff needed — the policy moved and ${d.role} has it now`;
    default:
      return `handoff: ${d.type}`;
  }
}

/** The limit names are internal; what a person reads should not be a field name. */
function limitWords(limit, role) {
  if (limit === "senderChains") return "open handoff chains for this role";
  if (limit === "receiverConcurrent") return `${role ?? "the owner"} already running`;
  return limit ?? "a limit";
}
