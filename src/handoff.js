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
 */
import { ownersOf } from "./owners.js";

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
  const visited = chain?.visited ?? [request.role];
  const depth = chain?.depth ?? 0;
  const at = (type, extra = {}) => ({ type, revision, chainId: chain?.id ?? null, ...extra });

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
    return at("resolved", { resolution: "policy_changed", role: owner });

  /**
   * A role already in this chain does not get re-entered, even for a different
   * file. Work that crosses a boundary and needs to come back has stopped being
   * a handoff and become multi-role coordination; that is a decomposition a
   * person should make on purpose.
   */
  if (visited.includes(owner))
    return at("cycle", { role: owner, visited: [...visited] });

  if (depth + 1 > depthMax)
    return at("depth", { role: owner, depth: depth + 1, max: depthMax });

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
    return at("throttled", { role: owner, limit: "senderChains", max: senderMax });

  const receiverMax = limits.receiverConcurrent ?? Infinity;
  if ((load.receiverRunning ?? 0) >= receiverMax)
    return at("throttled", { role: owner, limit: "receiverConcurrent", max: receiverMax });

  return at("route", {
    role: owner,
    depth: depth + 1,
    visited: [...visited, owner],
  });
}
