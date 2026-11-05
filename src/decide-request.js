/** A person's decision, shared by the CLI and the console, never the MCP. */
import { loadConfig } from "./config.js";
import { explain, keyHolders } from "./owners.js";
import { isKeyRequest } from "./handoff.js";
import { coveredBy } from "./narrow.js";
import { editPolicy, requestsPath, asFileGrant, refuseIfBarred, applyGrant, checkQueue, settle } from "./requests.js";

/**
 * Looked up, applied and settled under one lock — the policy's, the one
 * every grant takes (editPolicy). The lookup used to happen before it and
 * the settle after it, so the console and `seisin grant` could both find the
 * same request pending and both act on it. A decline takes the lock as well,
 * though it writes no policy, for the same reason.
 *
 * The config is edited as text, so comments and order survive, and it is
 * written before the queue is settled: if the write throws, the request is
 * still open rather than marked done against a file that never changed.
 *
 * The queue is checked before that write, so one that cannot take the line
 * refuses the grant with nothing changed. The line can still fail after it (a
 * full disk): then the error says the policy already changed, and running the
 * same grant again closes the request, as "already granted" does.
 *
 * Selection stays with the interface: the CLI accepts positions and decorates
 * the queue; the console accepts only a stable id and has its own errors.
 * `reload: false` preserves CLI decline's use of its already loaded config;
 * the console reloads even for a decline, so malformed policy still refuses it.
 * `includeOnly: false` keeps CLI declines free of file-grant metadata, even
 * when a sibling request reopened after an earlier one-file grant.
 */
export function decideRequest(config, { decision, reason, only = false, select, reload = true, includeOnly = true }) {
  let request;
  let warning = null;
  const file = requestsPath(config.root);
  const result = editPolicy(config, (before) => {
    const current = reload ? loadConfig(config.path, before) : config;
    request = select(current);
    if (decision !== "granted") {
      warning = stillAllowed(policyNow(config, before), request);
      return { toml: before, changed: false };
    }
    if (only) request = asFileGrant(request);
    refuseIfBarred(current, request);
    // Nothing to write when the role's writes already cover it: the line would
    // read as access given and open nothing. The request is answered all the same.
    if (request.action === "write" && (current.roles[request.role]?.writes ?? []).some((w) => coveredBy(request.grant, w)))
      return { toml: before, changed: false };
    const edited = applyGrant(before, request, reason);
    if (edited.changed) unrecorded(file, () => checkQueue(file), "Nothing changed.");
    return edited;
  }, {
    // Keep settlement after the policy write, still under its lock.
    after: ({ changed }) => unrecorded(file,
      () => settle(file, request.key, decision, reason, includeOnly ? { only: request.only } : undefined),
      changed
        ? `${config.path} already gives ${request.role} ${JSON.stringify(request.grant)}: fix that and run this grant again, which closes the request.`
        : "Nothing changed.",
      changed),
  });
  return { request, ...result, ...(warning && { stillAllowed: warning }) };
}

/**
 * Runs `step`, saying what a failure to write the queue means for this decision.
 * A held lock is another decision in flight, and each interface words that
 * itself, unless the policy has already changed and a retry alone is not the story.
 */
function unrecorded(file, step, then, changed = false) {
  try {
    step();
  } catch (e) {
    if (e.code === "ELOCKED" && !changed) throw e;
    throw Object.assign(new Error(`the decision could not be recorded in ${file} (${e.code ?? e.message}). ${then}`), { status: 500 });
  }
}

/** The policy as it is under the lock, or the caller's if that text cannot load. */
export function policyNow(config, text) {
  try { return loadConfig(config.path, text); } catch { return config; }
}

/**
 * Why the role already has what was just declined, or null when it does not.
 *
 * Declining answers the request; it does not edit the policy. A role the policy
 * already gives this to keeps it, and a person who has just read "declined" has
 * every reason to think otherwise.
 *
 * A key is asked by who declares it, not through `explain`, which reads a bare
 * name as a question typed at a terminal: with a file of that name in the repo
 * it answers about the file, and says a closed key is open.
 */
export function stillAllowed(config, request) {
  try {
    if (isKeyRequest(config, request))
      return keyHolders(config, request.target).includes(request.role) ? `${request.role} declares ${request.target}` : null;
    const answer = explain(config, request.role, request.action, request.target);
    return answer.allowed ? answer.reason : null;
  } catch {
    // A warning has no business failing a decision.
    return null;
  }
}
