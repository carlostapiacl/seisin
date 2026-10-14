/**
 * The parent's intake: what arrives during a run, checked, and written down.
 *
 * Two sources, and they are not equally trustworthy. The hook runs inside the
 * sandbox, so everything it sends is a claim by the process being recorded. The
 * kernel is the thing that actually denied. Both end up as log lines and,
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
import { join } from "node:path";
import { browserFor } from "./browsers.js";
import { toRepoRelative, samePath } from "./paths.js";
import { explain, ownersOf, keyHolders, inKeyDir, privateOwner } from "./owners.js";
import { append, logPath } from "./log.js";
import { record, requestsPath } from "./requests.js";
import { inScope, scopeOf, reachedForContent } from "./violations.js";
import { mcpServer } from "./hook.js";
import { policyId } from "./config.js";
import { expectedOf, kindOf } from "./kinds.js";

/** Moved to config.js, where the handoff decisions read it too; kept here for callers. */
export { policyId };

/**
 * The handlers for one run.
 *
 * `fromHook(to, entry)` is the spool's sink; `fromKernel(denial)` is
 * watchDenials' callback; `stats` counts what the kernel said that was left
 * out on purpose, for the line at the end of the run.
 *
 * `expectDenied` is the paths the caller said it expects to be denied
 * (`seisin run --expect-denied`): taken from the parent's own argv, never from
 * anything the sandbox can reach. See expectedByCaller below.
 */
export function intake({ config, role, runId, observe = false, settings, notify, chain = null, expectDenied = [] }) {
  const stamp = { run: runId.slice(0, 8), policy: policyId(config) };
  // No `at` from here or from the sandbox: append() stamps the parent's clock and
  // ignores any other. The confined process chose the time of its own lines —
  // it could date them into or out of every `since` window, or make its
  // requests look old enough to be passed over.
  const log = (entry) => append(logPath(config.root), { ...entry, ...stamp });
  // The chain is this run's (run.js, --handoff), the same for every request it
  // files; nothing the sandbox sends can set or change it.
  const ask = (asked) => { record(requestsPath(config.root), { ...asked, chain }); notify?.maybe(asked); };

  const scope = scopeOf(settings, config.root);
  const keyDirs = (config.keyDirs ?? []).map((d) => (d.startsWith("/") ? d : join(config.root, d)));
  const connects = new Set();         // one line per refused target per run
  const systems = new Set();          // one line per operation and service per run
  const stats = { offPolicy: 0, walks: 0, expected: 0, probes: 0, atomic: [], browsers: [] };

  /**
   * A denial the caller asked for is recorded, and asked about by nobody.
   *
   * An orchestrator that probes the sandbox with a write it expects to be
   * denied — its own canary, beside seisin's — got a request for it: a line in
   * the queue, a notification, and a handoff decision that routed the probe to
   * whichever role owns the repo root, which an orchestrator obeying the
   * decision would then have started. The denial is the answer the caller
   * wanted, so it stays in the log, marked `expected`, and files nothing.
   *
   * Exact paths, compared in one spelling (paths.js, samePath): a denial on any
   * other path, the directory around it included, is still a request. The
   * list is the parent's, from its own argv; the hook inside never suppresses
   * anything, and nothing it sends can add to the list (docs/decisions.md).
   */
  const probes = new Set(expectDenied.map((p) => samePath(config, p)).filter(Boolean));
  const expectedByCaller = (target) => probes.size > 0 && probes.has(samePath(config, target));

  /**
   * Nothing from inside the sandbox is taken at its word.
   *
   * The sender is the process being recorded, so every field it supplies is
   * a claim. Two of them matter. `role` decides whose request this is — left
   * alone, a frontend agent could file one as backend and wait for a person to
   * grant it. `owners` decides who the queue says it belongs to, and the
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
     * inside the sandbox: the server is parsed from the tool name and asked of the
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
        role,
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
      // everything else was passed through, so a process inside the sandbox could
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
      // Marked only when the hook and the parent agree it was a denial: the
      // hook's word alone does not make a line expected.
      const asked = entry.verdict === "denied" && expected === "denied" && expectedByCaller(entry.target);
      return void log({
        role,
        tool: String(entry.tool ?? "").slice(0, 40),
        action: entry.action,
        kind: entry.kind === "key" ? "key" : "file",
        target: entry.target.slice(0, 1000),
        verdict: entry.verdict,
        owners: ownersOf(config, entry.target),      // recomputed, never taken
        reason: String(entry.reason ?? "").slice(0, 500),
        ...(expected !== entry.verdict ? { disputed: expected } : {}),
        ...(asked ? { expected: true } : {}),
      });
    }

    /**
     * The policy has to actually refuse it, or it does not belong in a queue.
     *
     * Nothing checked. A process inside the sandbox could file a request for a path
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
    if (v.allowed || v.neverWrites || v.gitMetadata || v.protected || v.privateTo) return;
    if (temporary(entry.action, entry.target)) return;
    // The caller's probe: its log line above says it was expected.
    if (expectedByCaller(entry.target)) return;
    // The owners explain found: for a key that is who declares it, not who
    // writes the directory it sits in — the queue said "owned by dev" about
    // backend's key because dev writes `**`.
    // Capped like the log line above: a request's target is a path, and an
    // uncapped one (5k+ chars were accepted) is a way to bloat the queue a
    // person reads. 1000 is more than any real path and matches the log.
    ask({ role, action: entry.action, target: entry.target.slice(0, 1000), owners: v.owners });
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
    /**
     * A refused Mach service, sysctl or the like: logged by operation and name,
     * never queued — see SYSTEM in violations.js.
     *
     * Once per operation and name per run, and a trailing pid is folded into
     * the name for that count: a browser whose children cannot find its
     * rendezvous service ask for it a thousand times in forty seconds, each
     * under the parent's pid, and the second line says nothing the first did not.
     */
    if (d.action === "system") {
      const key = `${d.operation} ${d.path.replace(/\.\d+$/, ".<pid>")}`;
      if (systems.has(key)) return;
      systems.add(key);
      // The one that kills a browser at start, and that a preset answers: named
      // at the end of the run, because the agent saw only a crash.
      const preset = d.operation === "mach-register" ? browserFor(d.path) : null;
      if (preset && !stats.browsers.includes(preset)) stats.browsers.push(preset);
      log({
        role, tool: "kernel", source: "kernel",
        action: d.operation, kind: "system", target: d.path.slice(0, 1000), verdict: "denied",
        owners: [], reason: d.operation,
      });
      return;
    }
    if (d.action === "connect") {
      if (connects.has(d.path)) return;
      connects.add(d.path);
      const v = explain(config, role, "connect", d.path);
      log({
        role, tool: "kernel", source: "kernel",
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
    // Recorded like any other, and counted apart, so the end of the run can
    // say it was expected instead of leaving it to read as a failure.
    if (expectedOf(rel)) stats.expected++;
    const asked = expectedByCaller(rel);
    if (asked) stats.probes++;

    /**
     * A refusal the hook never saw still leaves a request behind.
     *
     * Without this the two halves of the record disagree in the worst
     * direction: `review` would show a role stopped repeatedly on a directory
     * while the queue held nothing to grant, so the one refusal a person most
     * needed to see — the one that escaped the hook — would be the one with no
     * way to act on it.
     *
     * There is no double counting to avoid. When the hook catches something it
     * denies the tool call outright and the command never runs, so the kernel
     * never sees it. These are the ones that got past it, which is the whole
     * reason this exists. Inside the repo only: `~/.ssh` is refused on purpose
     * under `isolate` and is not a territory anyone is meant to ask for.
     */
    // Reads are asked too when they land in another role's private folder:
    // that refusal is the policy, not a missing grant, so it is not queued.
    const verdict = rel !== d.path && (d.action === "write" || (d.action === "read" && privateOwner(config, rel)))
      ? explain(config, role, d.action === "write" ? "write" : "read", rel)
      : null;
    const barred = verdict?.neverWrites ?? null;
    const unaskable = verdict?.gitMetadata === true || verdict?.protected != null || verdict?.privateTo != null;
    // A request for something the policy already grants cannot be approved into
    // anything: it is misattribution or a kernel/policy mismatch, and either way
    // the line in the log is the evidence, not a question for a person. The hook
    // path has always had this check; the kernel path did not, which is how a
    // role ended up asking for its own territory.
    const granted = verdict?.allowed === true;
    // A key is declared, not owned: who a write lookup finds for `.secrets/x`
    // is always nobody, and the queue said "(unowned)" over another role's key.
    const whose = d.action === "read" && inKeyDir(config, rel) ? keyHolders(config, rel) : ownersOf(config, rel);
    const scratch = rel !== d.path && temporary(d.action, rel);
    if (rel !== d.path && !barred && !unaskable && !granted && !scratch && !asked)
      ask({ role, action: d.action, target: rel, owners: whose });

    /**
     * An atomic save's temporary file stands for the file it replaces.
     *
     * Not queued as itself (temporary(), below), and until now not at all —
     * measured: Write was refused at `health.ts.tmp.<pid>`, nothing was queued,
     * and the agent concluded the directory was missing. The question a person
     * can answer is the destination: another role's file is asked for like any
     * write; a file this role may write is the runtime refusing the temporary
     * file beside it, which no grant can name, and the end of the run says so.
     */
    const destination = scratch && !asked ? destinationOf(rel) : null;
    if (destination) {
      const v = explain(config, role, "write", destination);
      if (v.allowed) stats.atomic.push(destination);
      else if (!v.neverWrites && !v.gitMetadata && v.protected == null && v.privateTo == null)
        ask({ role, action: "write", target: destination, owners: ownersOf(config, destination) });
    }

    log({
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
      ...(verdict?.privateTo ? { privateTo: verdict.privateTo } : {}),
      // Why no request was queued for it: a temporary file is not territory.
      ...(scratch ? { nature: "temporary" } : {}),
      // The file an atomic save was replacing, which is what was asked for.
      ...(destination ? { destination } : {}),
      // Why no request was queued for it: the caller said it would be denied.
      ...(asked ? { expected: true } : {}),
    });
  }

  return { fromHook, fromKernel, stats };
}

/**
 * A write to a temporary file (kinds.js) is recorded and never queued.
 *
 * Its name changes on every run — `BACKLOG.md.tmp.32029.03c4…`, the atomic
 * write of an editor or of Claude Code — so a grant of it opens nothing the
 * next run will use, and the request's id is its directory: at the root of the
 * repo, `dev:write:.`, which reads as asking for the whole repository. The
 * answer is the folder of the file it replaces, or $TMPDIR, and `check` and
 * `review` say so; a request in front of a person says the wrong thing.
 */
function temporary(action, target) {
  return action === "write" && kindOf(target).kind === "temporary";
}

/**
 * The file a write-then-rename was replacing, from its temporary file's name:
 * `src/health.ts.tmp.48213.3fa9c1d2e0b4` → `src/health.ts`. Claude Code's form,
 * and the general `<file>.tmp.<anything>`; null for any other temporary file.
 */
export function destinationOf(target) {
  const m = /^(.+[^/])\.tmp\.[^/]+$/.exec(target);
  return m ? m[1] : null;
}
