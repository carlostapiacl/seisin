/**
 * The refusal the agent never heard, said after the fact.
 *
 * PreToolUse sees the path a tool call names, and that is all it sees. What the
 * kernel refuses on its own — a child process, `/bin/rm` inside a script, a
 * path the regex did not catch — reaches the agent as `Operation not permitted`
 * with no path and no reason, and it retries. Measured on a real portfolio from
 * 2026-09-14 to 2026-09-22: 5,617 refusals, all of them from the kernel, 72%
 * the same role hitting the same path again.
 *
 * Two hooks close that, the shape nono uses for its sandbox diagnostics:
 *
 *   - after a tool call fails (PostToolUseFailure, and PostToolUse for Bash,
 *     which reports a failed command as a result): read this role's kernel
 *     refusals from the last moments and hand the agent the same sentence the
 *     PreToolUse hook would have — whose it is, how many times, and that it
 *     should hand it over rather than retry. The kernel's line reaches the log
 *     about 30 ms after the refusal (measured inside the box), so this reads it.
 *   - when a session starts, resumes or is compacted (SessionStart): the role's
 *     territory and what it keeps being refused, before the first refusal —
 *     and right after compaction, which is when an agent forgets what it was
 *     already told.
 *
 * What it does not do, on purpose: suggest widening. nono's message offers
 * `--allow /path`; that assumes the profile was too narrow. seisin assumes the
 * file is somebody else's, and the way out is handing it to them.
 *
 * On Linux the runtime's refusals cannot be read from outside (violations.js),
 * so the after-the-fact half finds nothing there and stays quiet.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { explain } from "./owners.js";
import { timesHit, walls } from "./walls.js";
import { collapseSidecars } from "./render.js";

/** What a refused write or read looks like in a tool's output. A trigger to look, not a verdict. */
export const DENIAL_SIGNS = /Operation not permitted|EPERM|EACCES|Permission denied|Read-only file system/i;

/** How far back a refusal still belongs to the call that just failed. */
const WINDOW_MS = 120_000;
/** Read only the end of the log: this runs on every failed command. */
const TAIL_BYTES = 512 * 1024;
/** How many paths to name. More than this is a wall of text nobody acts on. */
const MAX_NAMED = 3;

function tail(file) {
  if (!existsSync(file)) return [];
  const { size } = statSync(file);
  const from = Math.max(0, size - TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString("utf8").split("\n");
    if (from > 0) lines.shift();          // the first line is cut in half
    const out = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try { out.push(JSON.parse(l)); } catch { /* a line being written */ }
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** This role's refusals by the kernel since `sinceMs`, one per path, newest first. */
export function recentKernelDenials(file, role, sinceMs) {
  const since = new Date(sinceMs).toISOString();
  const seen = new Map();
  for (const e of tail(file).reverse()) {
    if (e.role !== role || e.verdict !== "denied" || e.source !== "kernel") continue;
    if (!e.at || e.at < since || !e.target) continue;
    const k = `${e.action}\u0000${e.target}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

/** The sentence for one refusal, in the words the PreToolUse hook uses. */
function sentence(config, role, file, e) {
  const action = e.kind === "key" ? "read" : e.action === "read" ? "read" : "write";
  const v = explain(config, role, action, e.target);
  if (v.allowed) return null;             // the policy moved since: nothing to say
  const times = timesHit(file, role, action, e.target);
  const again = times > 1 ? ` Refused ${times} times now; the next try ends the same way.` : "";
  if (v.neverWrites) return `${v.reason}. Do not ask for it.${again}`;
  if (v.owners?.length)
    return `${e.target} belongs to ${v.owners.join(", ")}. It is not ${role}'s to change — ` +
      `hand it over rather than working around it.${again}`;
  return `${e.target}: ${v.reason}.${again}`;
}

const PREFACE =
  "seisin — the sandbox this agent runs in — refused part of that. This is not a Unix permission " +
  "or a macOS privacy prompt: chmod, sudo or a different path to the same file will not change it.";

/**
 * After a tool call failed. Returns the hook output, or null to say nothing.
 *
 * `wait` retries the read a few times: the kernel's line lands ~30 ms after the
 * refusal, and a loaded machine can be slower than the hook.
 */
export async function afterTool(config, role, event, { file, now = Date.now, wait = [0, 100, 300] } = {}) {
  const evidence = JSON.stringify({ r: event.tool_response, e: event.error, o: event.tool_output });
  if (!DENIAL_SIGNS.test(evidence)) return null;
  let found = [];
  for (const ms of wait) {
    if (ms) await new Promise((ok) => setTimeout(ok, ms));
    found = recentKernelDenials(file, role, now() - WINDOW_MS);
    if (found.length) break;
  }
  const lines = found.map((e) => sentence(config, role, file, e)).filter(Boolean).slice(0, MAX_NAMED);
  if (!lines.length) return null;
  const more = found.length > MAX_NAMED ? ` (and ${found.length - MAX_NAMED} more — \`seisin walls ${role}\`)` : "";
  return {
    hookSpecificOutput: {
      hookEventName: event.hook_event_name,
      additionalContext: [PREFACE, ...lines.map((l) => `- ${l}`)].join("\n") + more,
    },
  };
}

/** When a session starts, resumes or is compacted: the map, before the first wall. */
export function atSessionStart(config, role, event, { file } = {}) {
  const r = config.roles[role];
  const writes = collapseSidecars(r.writesDeclared ?? r.writes);
  const lines = [
    `seisin: this session runs as the role "${role}". The kernel enforces it; nothing inside can widen it.`,
    `You may write: ${writes.length ? writes.join(", ") : "nothing"}. Reading the rest of the repo is fine.`,
  ];
  if ((r.neverWritesDeclared ?? r.neverWrites ?? []).length)
    lines.push(`Never, even inside that: ${(r.neverWritesDeclared ?? r.neverWrites).join(", ")}.`);
  if (r.keys.length) lines.push(`Keys you hold: ${r.keys.join(", ")}.`);
  const w = file ? walls(config, role, { file, limit: 5 }) : [];
  if (w.length) {
    lines.push("Already refused more than once, and still refused — do not try again, hand it over:");
    for (const x of w)
      lines.push(`- ${x.action} ${x.target} (${x.times}×) — ${x.owners?.length ? `belongs to ${x.owners.join(", ")}` : x.reason}`);
  }
  lines.push("A file outside that is somebody else's: say whose it is and hand it over, rather than working around it.");
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } };
}
