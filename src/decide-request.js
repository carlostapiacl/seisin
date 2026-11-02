/** A person's decision, shared by the CLI and the console, never the MCP. */
import { loadConfig } from "./config.js";
import { editPolicy, requestsPath, asFileGrant, refuseIfBarred, applyGrant, settle } from "./requests.js";

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
 * Selection stays with the interface: the CLI accepts positions and decorates
 * the queue; the console accepts only a stable id and has its own errors.
 * `reload: false` preserves CLI decline's use of its already loaded config;
 * the console reloads even for a decline, so malformed policy still refuses it.
 * `includeOnly: false` keeps CLI declines free of file-grant metadata, even
 * when a sibling request reopened after an earlier one-file grant.
 */
export function decideRequest(config, { decision, reason, only = false, select, reload = true, includeOnly = true }) {
  let request;
  const result = editPolicy(config, (before) => {
    const current = reload ? loadConfig(config.path, before) : config;
    request = select(current);
    if (decision !== "granted") return { toml: before, changed: false };
    if (only) request = asFileGrant(request);
    refuseIfBarred(current, request);
    return applyGrant(before, request, reason);
  }, {
    // Keep settlement after the policy write, still under its lock.
    after: () => settle(requestsPath(config.root), request.key, decision, reason, includeOnly ? { only: request.only } : undefined),
  });
  return { request, ...result };
}
