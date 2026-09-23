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
import { neverWrites } from "./owners.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR, tomlString } from "./layout.js";
import { send } from "./spool.js";

export const REQUESTS_NAME = "requests.jsonl";

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
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
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
 * only thing that has to be correct.
 */
export function pending(file, { includeSettled = false } = {}) {
  if (!existsSync(file)) return [];
  const byKey = new Map();

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a half-written line from a killed process is not an error
    }
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
     * disappearance the attempt is recorded to prevent.
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

  const all = [...byKey.values()];
  return includeSettled ? all : all.filter((r) => r.state === "pending");
}

/**
 * Adds a granted glob to a role in the config text, with its provenance.
 *
 * Edits the text rather than re-emitting the file, because a config someone
 * wrote has comments and an order that mean something, and a tool that
 * reformats it on every grant is a tool people stop letting near it.
 */
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
}

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

  const line = new RegExp(`^(${field}\\s*=\\s*)\\[([^\\]]*)\\]`, "m");
  const m = line.exec(section);
  if (!m)
    throw new Error(
      `[roles.${request.role}] has no ${field} list to grant into. ` +
      `Add \`${field} = []\` to that section first — seisin will not write it into another role's block.`
    );

  // The subset has no escapes, so a value carrying a quote or a newline cannot
  // be written down at all. The strict parser would reject the result rather
  // than widen anything — but leaving someone with a config that no longer
  // loads, after they approved something, is its own kind of broken.
  tomlString(request.grant);   // refuses what the format cannot hold

  const items = (m[2].match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
  if (items.includes(request.grant)) return { toml, changed: false };

  const stamp = `# granted ${new Date().toISOString().slice(0, 10)} · asked ${request.times}×` +
                `${note ? ` · "${cleanReason(note)}"` : ""}`;
  const body = [...items, request.grant]
    .map((v) => `  "${v}"${v === request.grant ? `,   ${stamp}` : ","}`)
    .join("\n")
    .replace(/,(\s*#[^\n]*)?$/, "$1");

  const edited = section.replace(line, `$1[\n${body}\n]`);
  return { toml: toml.slice(0, from) + edited + toml.slice(to), changed: true };
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
