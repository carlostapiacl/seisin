/**
 * The parent's intake: what arrives during a run, checked, and written down.
 *
 * Two sources, and they are not equally trustworthy. The hook runs inside the
 * box, so everything it sends is a claim by the process being recorded. The
 * kernel is the thing that actually refused. Both end up as log lines and,
 * sometimes, as requests in front of a person; this module is where each is
 * recomputed from the policy rather than believed.
 *
 * Every line written here carries two fields that make it evidence rather
 * than a sentence:
 *
 *   - `run`, the id of the run that produced it — the same id as the nonce in
 *     the kernel's command tag and the run's private directory (rundir.js).
 *     Before, the log had no run marker and "how many runs since" was guessed
 *     from 10-minute gaps.
 *   - `policy`, a hash of the policy file the run STARTED with. The kernel
 *     enforces that one for the whole run, whatever happens to the file
 *     afterwards, and `review` reading today's policy over last week's lines
 *     could not tell a grant made since from one that was always there.
 *
 * Pulled out of run.js, which held both handlers inline between the spawn and
 * the signal handling — 180 lines of policy arithmetic inside the launcher.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toRepoRelative } from "./paths.js";
import { explain, ownersOf } from "./owners.js";
import { append, logPath } from "./log.js";
import { record, requestsPath } from "./requests.js";
import { inScope, scopeOf, reachedForContent } from "./violations.js";
import { mcpServer } from "./hook.js";

/** A hash of the policy file as it is now, short: it names a version, it proves nothing. */
export function policyId(config) {
  try {
    return createHash("sha256").update(readFileSync(config.path)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * The handlers for one run.
 *
 * `fromHook(to, entry)` is the spool's sink; `fromKernel(denial)` is
 * watchDenials' callback; `stats` counts what the kernel said that was left
 * out on purpose, for the line at the end of the run.
 */
export function intake({ config, role, runId, observe = false, settings, notify }) {
  const stamp = { run: runId.slice(0, 8), policy: policyId(config) };
  const log = (entry) => append(logPath(config.root), { ...entry, ...stamp });
  const ask = (asked) => { record(requestsPath(config.root), asked); notify?.maybe(asked); };

  const scope = scopeOf(settings, config.root);
  const keyDirs = (config.keyDirs ?? []).map((d) => (d.startsWith("/") ? d : join(config.root, d)));
  const connects = new Set();         // one line per refused target per run
  const stats = { offPolicy: 0, walks: 0 };

  /**
   * Nothing from inside the box is taken at its word.
   *
   * The sender is the process being recorded, so every field it supplies is
   * a claim. Two of them matter. `role` decides whose request this is — left
   * alone, a frontend agent could file one as backend and wait for a human to
   * approve it. `owners` decides who the queue says it belongs to, and the
   * parent can work that out itself from the policy.
   *
   * So the role is overwritten with the role of this run, the owners are
   * recomputed, and anything shaped wrong is dropped. Forging a *log* line is
   * noise. Forging a *request* is a sentence placed in front of a person for
   * approval, and that is a different thing entirely.
   */
  function fromHook(to, entry) {
    if (!entry || typeof entry !== "object") return;

    /**
     * An MCP tool call. It names a resource, not a path, so it is recorded and
     * never queued — which servers a role may load is a change to its `mcp`
     * list, not a grant a person approves, the same shape as never_writes. The
     * verdict is recomputed here from the same list rather than believed from
     * inside the box: the server is parsed from the tool name and asked of the
     * policy, so a line claiming "allowed" for a server the role may not load
     * comes back marked `disputed`.
     */
    if (to === "log" && entry.action === "use") {
      if (typeof entry.target !== "string" || !entry.target.trim()) return;
      if (!["allowed", "denied", "observed"].includes(entry.verdict)) return;
      const server = mcpServer(entry.target);
      const v = server ? explain(config, role, "mcp", server) : { allowed: false };
      const expected = observe ? "observed" : v.allowed ? "allowed" : "denied";
      return void log({
        at: entry.at, role,
        tool: String(entry.tool ?? "").slice(0, 40),
        action: "use", kind: "tool",
        target: entry.target.slice(0, 1000),
        verdict: entry.verdict, owners: [],
        reason: String(entry.reason ?? "").slice(0, 500),
        ...(expected !== entry.verdict ? { disputed: expected } : {}),
      });
    }

    if (entry.action !== "read" && entry.action !== "write") return;
    if (typeof entry.target !== "string" || !entry.target.trim()) return;

    if (to === "log") {
      // The same treatment the queue already got. The role was overwritten but
      // everything else was passed through, so a process inside the box could
      // write "allowed" lines for paths it never touched — which would not move
      // the boundary, but would move `review`, and `init --from-observations`
      // builds a policy out of exactly this.
      if (!["allowed", "denied", "observed"].includes(entry.verdict)) return;
      /**
       * The verdict is the hook's account of what it did, so it stays — but it
       * is checked. The parent works out what the policy this run started with
       * says, and when the two differ the line carries `disputed` with the
       * parent's answer. Two causes, both worth seeing: the policy file changed
       * since the run started (the hook reads it fresh, the kernel does not), or
       * the line was not written by the hook at all.
       */
      const expected = observe
        ? "observed"
        : explain(config, role, entry.action, entry.target).allowed ? "allowed" : "denied";
      return void log({
        at: entry.at,
        role,
        tool: String(entry.tool ?? "").slice(0, 40),
        action: entry.action,
        kind: entry.kind === "key" ? "key" : "file",
        target: entry.target.slice(0, 1000),
        verdict: entry.verdict,
        owners: ownersOf(config, entry.target),      // recomputed, never taken
        reason: String(entry.reason ?? "").slice(0, 500),
        ...(expected !== entry.verdict ? { disputed: expected } : {}),
      });
    }

    /**
     * The policy has to actually refuse it, or it does not belong in a queue.
     *
     * Nothing checked. A process inside the box could file a request for a path
     * its own role already owns, and the queue would print *first refused on
     * …* about something that was never refused — a sentence placed in front of
     * a person for approval, describing an event that did not happen.
     *
     * Same treatment as `owners` above: the claim is recomputed here rather
     * than believed. It is the policy answering a question about itself, which
     * is arithmetic, and it is the parent asking — the one process the confined
     * side cannot reach.
     *
     * This does not require the agent to have *tried*. Asking for a permission
     * before reaching for it is a reasonable thing to do, and the wording says
     * "asked" rather than "refused" for exactly that case. What it rules out is
     * a request for something that is not refused at all — nor for a
     * `never_writes` path, git's metadata, or a protected one, none of which a
     * grant can open.
     */
    const v = explain(config, role, entry.action, entry.target);
    if (v.allowed || v.neverWrites || v.gitMetadata || v.protected) return;
    // The owners explain found: for a key that is who declares it, not who
    // writes the directory it sits in — the queue said "owned by dev" about
    // backend's key because dev writes `**`.
    ask({ role, action: entry.action, target: entry.target, owners: v.owners });
  }

  function fromKernel(d) {
    /**
     * A refused connection: logged, never queued.
     *
     * Once per target per run, because the thing that dials a closed port is
     * usually a readiness loop, and a loop polling a database every half second
     * would otherwise write the log the size of the wait. And no request: a port
     * is not a territory anyone owns, so there is nobody to hand it to — the
     * sentence says what the policy would have to change instead.
     */
    if (d.action === "connect") {
      if (connects.has(d.path)) return;
      connects.add(d.path);
      const v = explain(config, role, "connect", d.path);
      log({
        at: new Date().toISOString(), role, tool: "kernel", source: "kernel",
        action: "connect", kind: "network", target: d.path, verdict: "denied",
        owners: [], reason: d.operation, ...(v.listed ? { listed: true } : {}),
      });
      return;
    }
    if (!inScope(d.path, scope)) { stats.offPolicy++; return; }
    if (!reachedForContent(d)) { stats.walks++; return; }
    // Relative inside the repo, absolute outside it. A role can be refused at
    // ~/.ssh under `isolate`, and "../../../.ssh/id_rsa" would be a worse
    // answer to "what was refused" than the path itself.
    const rel = toRepoRelative(config, d.path);

    /**
     * A refusal the hook never saw still leaves a request behind.
     *
     * Without this the two halves of the record disagree in the worst
     * direction: `review` would show a role stopped repeatedly on a directory
     * while the queue held nothing to approve, so the one refusal a person most
     * needed to see — the one that escaped the hook — would be the one with no
     * way to act on it.
     *
     * There is no double counting to avoid. When the hook catches something it
     * denies the tool call outright and the command never runs, so the kernel
     * never sees it. These are the ones that got past it, which is the whole
     * reason this exists. Inside the repo only: `~/.ssh` is refused on purpose
     * under `isolate` and is not a territory anyone is meant to ask for.
     */
    const verdict = rel !== d.path && d.action === "write"
      ? explain(config, role, "write", rel)
      : null;
    const barred = verdict?.neverWrites ?? null;
    const unaskable = verdict?.gitMetadata === true || verdict?.protected != null;
    // A request for something the policy already grants cannot be approved into
    // anything: it is misattribution or a kernel/policy mismatch, and either way
    // the line in the log is the evidence, not a question for a person. The hook
    // path has always had this check; the kernel path did not, which is how a
    // role ended up asking for its own territory.
    const granted = verdict?.allowed === true;
    if (rel !== d.path && !barred && !unaskable && !granted)
      ask({ role, action: d.action, target: rel, owners: ownersOf(config, rel) });

    log({
      at: new Date().toISOString(),
      role,
      tool: "kernel",
      source: "kernel",
      action: d.action,
      kind: keyDirs.some((k) => d.path === k || d.path.startsWith(k + "/")) ? "key" : "file",
      target: rel,
      verdict: "denied",
      owners: ownersOf(config, rel),
      reason: d.operation,
      // So the log can tell a subtraction doing its job from a missing permission,
      // and a protected file from a territory somebody could be asked for.
      ...(barred ? { neverWrites: barred } : {}),
      ...(verdict?.protected ? { protected: verdict.protected } : {}),
    });
  }

  return { fromHook, fromKernel, stats };
}
