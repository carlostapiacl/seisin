/**
 * The queue of permissions an agent was refused and would like.
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./layout.js";
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
  const dir = action === "read" ? target : target.split("/").slice(0, -1).join("/") || ".";
  return `${role}:${action}:${dir}`;
}

/** The glob a grant would add, derived from what was asked. */
export function grantFor({ action, target }) {
  if (action === "read") return target.replace(/^.*\//, "");
  const dir = target.split("/").slice(0, -1).join("/");
  return dir ? `${dir}/**` : target;
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

/** Records that a role was refused something. Safe to call on every denial. */
export function record(file, { role, action, target, owners }) {
  return write(file, { kind: "asked", key: keyOf({ role, action, target }), role, action, target, owners: owners ?? [] });
}

/** Records a decision. `by` is always a person; there is no other caller. */
export function settle(file, key, decision, reason = "") {
  return write(file, { kind: decision, key, reason });
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
    if (seen) { seen.state = e.kind; seen.reason = e.reason ?? ""; seen.decided = e.at; }
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
export function applyGrant(toml, request, note = "") {
  const field = request.action === "read" ? "keys" : "writes";
  const section = new RegExp(`(^\\[roles\\.${escapeRe(request.role)}\\]$)`, "m");
  if (!section.test(toml)) throw new Error(`no [roles.${request.role}] section to grant into`);

  const stamp = `# granted ${new Date().toISOString().slice(0, 10)} · asked ${request.times}×${note ? ` · "${note}"` : ""}`;
  const line = new RegExp(`(^\\[roles\\.${escapeRe(request.role)}\\][\\s\\S]*?^${field}\\s*=\\s*)\\[([^\\]]*)\\]`, "m");
  const m = line.exec(toml);
  if (!m) throw new Error(`[roles.${request.role}] has no ${field} list to grant into`);

  const items = (m[2].match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
  if (items.includes(request.grant)) return { toml, changed: false };

  const body = [...items, request.grant]
    .map((v) => `  "${v}"${v === request.grant ? `,   ${stamp}` : ","}`)
    .join("\n")
    .replace(/,(\s*#[^\n]*)?$/, "$1");   // the last entry takes no trailing comma

  return { toml: toml.replace(line, `$1[\n${body}\n]`), changed: true };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
