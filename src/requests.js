/**
 * The queue of permissions an agent asked for and cannot have yet.
 *
 * ── Two words, kept apart on purpose ──
 * **Refused** is what the boundary does. **Declined** is what a person does to
 * a request. They used to be one word in one command: an entry read `first
 * refused on src/api/x.ts` and `seisin deny` answered `refused frontend ✕
 * src/api/**`. One means the kernel said no, the other means you did, and a
 * reader had nothing to tell them apart by.
 *
 * The entry says **asked** now, because refused was not always true. Asking for
 * a permission before reaching for it is reasonable, and nothing required a
 * denial to have happened first — so the queue could print a sentence about an
 * event that never occurred, in front of a person about to approve something.
 * `seisin run` drops any request the policy does not actually refuse; what is
 * left is "you cannot have this, and you asked", which holds whether the agent
 * tried or simply asked.
 *
 * A denial already contains everything a request needs — the hook knows the
 * role, the path and the owner — so the refusal leaves something behind that a
 * person can act on in one command instead of in an editor. See
 * `docs/permission-requests.md` for why approving is deliberately not something
 * an agent can do.
 *
 * Append-only, beside the log, for the same reason: a decision that can be
 * rewritten is not evidence. A request that is granted or refused is not
 * deleted — it is followed by a line saying what happened to it.
 */
import { neverWrites, isGitMetadata, covers } from "./owners.js";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR, tomlString } from "./layout.js";
import { send } from "./spool.js";
import { withLock, readEntries } from "./log.js";

const REQUESTS_NAME = "requests.jsonl";

export function requestsPath(root) {
  return join(root, STATE_DIR, REQUESTS_NAME);
}

/**
 * Identity of a request: the same role wanting the same kind of access to the
 * same place is one request asked twice, not two requests.
 *
 * The path is generalised to its directory on purpose. An agent denied on
 * `src/api/a.ts` and then on `src/api/b.ts` is not asking two questions, and a
 * queue that says it is becomes a queue nobody reads.
 */
export function keyOf({ role, action, target }) {
  // A line can arrive malformed — a killed process, or something inside the
  // sandbox writing to the queue on purpose. Reading the queue must not be the
  // thing that fails: `seisin run` prints it on the way out and the console
  // polls it, so a crash here takes down the half of the tool a person uses.
  const t = typeof target === "string" ? target : "";
  const dir = action === "read" ? t : t.split("/").slice(0, -1).join("/") || ".";
  return `${role}:${action}:${dir}`;
}

/**
 * A request's id as one shell word, for the commands seisin suggests.
 *
 * The id carries a path an agent chose, so it is single-quoted whole and any
 * quote inside it is closed and escaped: pasting the suggestion runs `seisin
 * grant` on that request and nothing else.
 */
export function shellId(key) {
  return `'${String(key).replace(/'/g, `'\\''`)}'`;
}

/** The glob a grant would add, derived from what was asked. */
export function grantFor({ action, target }) {
  const t = typeof target === "string" ? target : "";
  // A key keeps its directory when it has one. Stripping it turned a request
  // for `shared/api.txt` into a grant of `api.txt`, which settingsFor then
  // resolves against the FIRST key directory — so the person approves one file
  // and another one of the same name is what gets read.
  if (action === "read") return t.includes("/") ? t : t.replace(/^.*\//, "");
  const dir = t.split("/").slice(0, -1).join("/");
  return dir ? `${dir}/**` : t;
}

function write(file, entry) {
  if (send("requests", entry)) return true;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // The time is this process's, named after the spread so no entry sets it.
    const now = new Date().toISOString();
    appendFileSync(file, JSON.stringify({ at: now, ...entry, at: now }) + "\n");
    return true;
  } catch {
    // Same rule as the log: never take the agent down over bookkeeping.
    return false;
  }
}

/** Records that a role asked for something the policy denies it. Safe to call
 *  on every denial; `seisin run` drops anything the policy does not refuse. */
export function record(file, { role, action, target, owners }) {
  return write(file, { kind: "asked", key: keyOf({ role, action, target }), role, action, target, owners: owners ?? [] });
}

/** Records a decision. `by` is always a person; there is no other caller. */
export function settle(file, key, decision, reason = "") {
  return write(file, { kind: decision, key, reason });
}

/**
 * Records what the execution plane last tried to do about a request, which is a
 * different question from what a person decided about it.
 *
 * `settle` answers "did the authority change?". This answers "what happened to
 * the work?" — handed to the owner, stopped by a cycle, held back by a budget.
 * They are kept apart deliberately: a request whose handoff was throttled is
 * still `pending`, because nobody has decided anything about it. Writing the
 * outcome into `state` would make admission look like a verdict.
 *
 * It exists so that a refusal to run cannot be invisible. Admission may
 * postpone work; it may not make work disappear from the queue a person reads.
 *
 * Nothing in src/ calls it today — handoff.js decides but nothing records the
 * outcome; the tests do, and pending() keeps reading what it writes.
 */
export function recordHandoff(file, key, decision = {}) {
  const { type, role, limit, max, reason, depth, chainId, revision } = decision;
  return write(file, {
    kind: "handoff", key, outcome: type ?? "unknown",
    ...(role !== undefined && { role }),
    ...(limit !== undefined && { limit }),
    ...(max !== undefined && { max }),
    ...(reason !== undefined && { reason }),
    ...(depth !== undefined && { depth }),
    ...(chainId != null && { chainId }),
    ...(revision != null && { revision }),
  });
}

/**
 * The queue as it stands: one entry per distinct request, with how many times
 * it was asked and what was decided.
 *
 * Reduced from the whole file rather than kept as state, so the file stays the
 * only thing that has to be correct. The reduction is remembered for as long as
 * the file is unchanged (same inode, size and mtime): the console asks every
 * two seconds, and re-parsing a 2 MB queue each time to find it had not moved
 * was most of the cost of asking. Each call gets its own copies, so a caller
 * marking entries (markStale) cannot mark the next caller's.
 */
let reduced = null;   // { file, ino, size, mtimeMs, all }

export function pending(file, { includeSettled = false } = {}) {
  let st;
  try { st = statSync(file); } catch { return []; }
  let all;
  if (reduced && reduced.file === file && reduced.ino === st.ino && reduced.size === st.size && reduced.mtimeMs === st.mtimeMs) {
    all = reduced.all;
  } else {
    all = reduce(file);
    reduced = { file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, all };
  }
  const copies = all.map((r) => ({ ...r }));
  return includeSettled ? copies : copies.filter((r) => r.state === "pending");
}

function reduce(file) {
  const byKey = new Map();

  for (const e of readEntries(file)) {
    if (!e.key) continue;

    if (e.kind === "asked") {
      const seen = byKey.get(e.key);
      if (seen) { seen.times++; seen.last = e.at; continue; }
      byKey.set(e.key, {
        key: e.key, role: e.role, action: e.action, target: e.target,
        owners: e.owners ?? [], grant: grantFor(e),
        times: 1, first: e.at, last: e.at, state: "pending", reason: "",
      });
      continue;
    }
    const seen = byKey.get(e.key);
    if (!seen) continue;

    /**
     * Two lifecycles in one file, and only one of them is `state`.
     *
     * Without this branch the catch-all below would set state = "handoff" and a
     * throttled attempt would drop out of the pending queue — the exact silent
     * disappearance the attempt is recorded to prevent. (Only the tests write
     * handoff lines today — see recordHandoff.)
     */
    if (e.kind === "handoff") {
      seen.handoff = {
        outcome: e.outcome, role: e.role, limit: e.limit, max: e.max,
        reason: e.reason, depth: e.depth, chainId: e.chainId, at: e.at,
      };
      continue;
    }

    seen.state = e.kind; seen.reason = e.reason ?? ""; seen.decided = e.at;
  }

  return [...byKey.values()];
}

/**
 * How many runs of the role, after the last time it asked, make a request old.
 *
 * A request is recorded again on every refusal, so one the role still needs
 * keeps a fresh `last`. One whose need went away — the work moved somewhere the
 * role may write, or the task ended — stops being asked while the role keeps
 * running. Three runs is enough to say "not since" and few enough that a queue
 * does not carry a dead request for a week.
 */
export const STALE_RUNS = 3;

/**
 * Two log lines of a role this far apart belong to different runs — for lines
 * written before the log had a run marker. Lines with `run` are counted by it.
 */
export const RUN_GAP_MS = 10 * 60_000;

/**
 * How many runs produced these lines, strictly after `since` (ms).
 *
 * By the `run` id when a line has one (intake.js writes it on every line since
 * 2026-09-23), by the gap otherwise. The gap guessed: three runs started a
 * minute apart by an orchestrator counted as one, and one run idle for eleven
 * minutes counted as two.
 */
export function runsAfter(entries, since, gapMs = RUN_GAP_MS) {
  const ids = new Set();
  const untagged = [];
  for (const e of entries) {
    const t = Date.parse(e.at);
    if (Number.isNaN(t) || t <= since) continue;
    if (e.run) ids.add(e.run);
    else untagged.push(t);
  }
  untagged.sort((a, b) => a - b);
  let n = 0, prev = -Infinity;
  for (const t of untagged) { if (t - prev > gapMs) n++; prev = t; }
  return ids.size + n;
}

/**
 * Marks the requests the role has stopped asking for, read off the log.
 *
 * Marked, never settled and never moved. Declining is a person's decision, and
 * reordering would shift the numbers `grant <n>` is typed against while
 * nobody decided anything. The mark says what is true — the role ran N times
 * since and did not ask again — and leaves the rest to whoever reads it.
 * `entries` are log lines (`read(logPath(root))`).
 */
export function markStale(queue, entries, { runs = STALE_RUNS, gapMs = RUN_GAP_MS } = {}) {
  const byRole = new Map();             // role -> its log lines
  for (const e of entries) {
    if (!e.role) continue;
    (byRole.get(e.role) ?? byRole.set(e.role, []).get(e.role)).push(e);
  }
  for (const r of queue) {
    const n = runsAfter(byRole.get(r.role) ?? [], Date.parse(r.last), gapMs);
    if (n >= runs) r.stale = { runs: n, since: r.last };
  }
  return queue;
}

/**
 * Refuses a grant that `never_writes` would cancel, before anything is written.
 *
 * A request filed before the subtraction existed can still be in the queue.
 * Approving it would add the path to `writes` and change nothing — denyWrite
 * wins — so the person would believe they granted something the kernel still
 * refuses. The two keys contradict each other, and which one should win is the
 * decision; seisin will not make it by writing one of them silently.
 */
export function refuseIfBarred(config, request) {
  if (request.action === "read") return;
  const role = config.roles?.[request.role];
  const hit = role && neverWrites(role, request.target, config);
  if (hit)
    throw new Error(
      `${request.target} is under never_writes of ${request.role} ("${hit}"), which wins over ` +
      `writes. Granting it would change nothing. If the subtraction is wrong, remove that ` +
      `entry from [roles.${request.role}]; otherwise decline this request.`);
  // Only a repository the role does not write: its own `.git` is its own business.
  if (isGitMetadata(request.target) && !(role?.writes ?? []).some((g) => covers(g, request.target)))
    throw new Error(
      `${request.target} is git's own bookkeeping, not a territory: granting it lets ${request.role} ` +
      `rewrite another owner's history. Decline it; a role that needs to commit gets a worktree of its own.`);
}

/**
 * Apply one policy edit under a lock, and write it atomically.
 *
 * `grant` and the console both did read → applyGrant → write with no lock, so
 * two approvals racing (a person at the CLI and one on the console, or two
 * terminals) lost one edit: the queue marked both granted while `seisin.toml`
 * kept only the last writer's change (measured: 39 of 40 concurrent pairs). The
 * lock serialises them — it already survives a writer that died holding it
 * (see log.js) — and the write goes to a temp file then renames over the config,
 * so a crash mid-write cannot leave a half-written, partly-privileged policy.
 *
 * `mutate(toml)` returns `{ toml, changed }`. Nothing is written when unchanged.
 * `after(result)` runs once the file is written, still under the lock — for
 * the queue line that records the decision, so a decision and its edit are
 * one step to anyone else taking this lock.
 */
export function editPolicy(config, mutate, { waitMs = 10000, after = null } = {}) {
  return withLock(config.path, () => {
    const before = readFileSync(config.path, "utf8");
    const result = mutate(before);
    if (result.changed) {
      const tmp = `${config.path}.tmp-${process.pid}`;
      writeFileSync(tmp, result.toml);
      renameSync(tmp, config.path);
    }
    after?.(result);
    return result;
  }, { waitMs });
}

/**
 * Adds a granted glob to a role in the config text, with its provenance.
 *
 * Edits the text rather than re-emitting the file, because a config someone
 * wrote has comments and an order that mean something, and a tool that
 * reformats it on every grant is a tool people stop letting near it.
 *
 * The edit is bounded to the role's own section, and that is not tidiness. The
 * first version searched from the role header to the next `writes =` anywhere
 * in the file, so approving for a role that had no `writes` line wrote the
 * grant into the NEXT role — with a comment saying who it was for. A human
 * approved one thing and the file recorded another. In a permission tool that
 * is the worst possible bug, and it is not exotic: a role with only `keys`
 * declared is an ordinary config.
 */
export function applyGrant(toml, request, note = "") {
  const field = request.action === "read" ? "keys" : "writes";
  const header = new RegExp(`^\\[roles\\.${escapeRe(request.role)}\\]\\s*$`, "m");
  const at = header.exec(toml);
  if (!at) throw new Error(`no [roles.${request.role}] section to grant into`);

  // The section runs from its header to the next table header, or to the end.
  const from = at.index + at[0].length;
  const next = /^\[[^\]]+\]\s*$/m.exec(toml.slice(from));
  const to = next ? from + next.index : toml.length;
  const section = toml.slice(from, to);

  const open = new RegExp(`^${field}\\s*=\\s*\\[`, "m").exec(section);
  if (!open)
    throw new Error(
      `[roles.${request.role}] has no ${field} list to grant into. ` +
      `Add \`${field} = []\` to that section first — seisin will not write it into another role's block.`
    );

  // The subset has no escapes, so a value carrying a quote or a newline cannot
  // be written down at all. The strict parser would reject the result rather
  // than widen anything — but leaving someone with a config that no longer
  // loads, after they approved something, is its own kind of broken.
  tomlString(request.grant);   // refuses what the format cannot hold

  const start = open.index + open[0].length;
  const list = scanList(section, start);
  if (list.items.includes(request.grant)) return { toml, changed: false };

  /**
   * Appended, never rebuilt.
   *
   * The list used to be re-written from every quoted string between its
   * brackets — comments included. `"src/web/**",  # was "src/**"` came back as
   * two grants, so approving anything also granted what a comment mentioned,
   * and the reason an approver typed (quoted in the provenance comment) became
   * a path on the next approval. Every earlier provenance comment was lost on
   * the way. Now the items are the strings outside comments, what is there is
   * left as it is, and the new entry goes last. The reason is set off with
   * «», never a double quote, so no older reader can take it for a value.
   */
  let inner = section.slice(start, list.end).replace(/\s+$/, "");
  if (list.lastItemEnd !== null && !list.commaAfterLast) {
    const at = list.lastItemEnd - start;
    inner = inner.slice(0, at) + "," + inner.slice(at);
  }
  const stamp = `# granted ${new Date().toISOString().slice(0, 10)} · asked ${request.times}×` +
                `${note ? ` · «${cleanReason(note)}»` : ""}`;
  const edited = section.slice(0, start) + `${inner}\n  "${request.grant}"   ${stamp}\n]` + section.slice(list.end + 1);
  return { toml: toml.slice(0, from) + edited + toml.slice(to), changed: true };
}

/**
 * The strings of a TOML array that starts at `start` (just past its `[`),
 * skipping comments, and where it closes. The subset has no escapes, so a
 * string runs to the next double quote.
 */
function scanList(text, start) {
  const items = [];
  let lastItemEnd = null;
  let commaAfterLast = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "#") { const nl = text.indexOf("\n", i); if (nl === -1) break; i = nl; continue; }
    if (c === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1) break;
      items.push(text.slice(i + 1, close));
      lastItemEnd = close + 1;
      commaAfterLast = false;
      i = close;
      continue;
    }
    if (c === ",") { commaAfterLast = true; continue; }
    if (c === "]") return { items, end: i, lastItemEnd, commaAfterLast };
  }
  throw new Error(`the ${text.slice(0, 40).trim()}… list never closes; fix the config by hand before granting`);
}

/**
 * The approver's own words, made safe to put in a config file.
 *
 * A reason is free text typed by a person, and a person can be talked into
 * typing something — "paste this as the reason" is a plausible thing for an
 * agent to suggest. Newlines in a comment would end the comment, and what
 * follows is parsed as TOML. The strict parser rejects the result rather than
 * widening anything, so the worst case is a config that no longer loads, but a
 * permission file that can be broken by a sentence is still broken.
 */
export function cleanReason(s) {
  return String(s ?? "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/["\\]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
