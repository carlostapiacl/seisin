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
  if (owners.length > 1) return at("human", { reason: "ambiguous", owners });

  const [owner] = owners;

  /**
   * The policy moved and the asker owns it now. Nobody granted anything, so
   * this is not `granted` — it is a request that stopped existing, and saying
   * so is what keeps the human queue readable. Sending this to a person would
   * be asking them to decide something already decided.
   */
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
 * The decision in words a person reads, one line, no colour.
 *
 * `attempt` is what the execution plane last recorded about the request
 * (requests.js, recordHandoff). It is shown only where seisin's own decision
 * is a route to the same role: whether that role could be started is
 * admission, which only whatever starts it knows. Every other outcome is the
 * policy's, recomputed now, and a recorded attempt cannot overrule it.
 */
export function describeHandoff(decision, attempt = null) {
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
      if (d.reason === "ambiguous") return `a person decides: more than one role owns this (${d.owners.join(", ")})`;
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
