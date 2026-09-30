/**
 * The refusal the agent never heard, said after the fact.
 *
 * PreToolUse sees the path a tool call names, and that is all it sees. What the
 * kernel denies on its own — a child process, `/bin/rm` inside a script, a
 * path the regex did not catch — reaches the agent as `Operation not permitted`
 * with no path and no reason, and it retries. Measured on a multi-repo workspace from
 * 2026-09-14 to 2026-09-22: 5,617 denials, all of them from the kernel, 72%
 * the same role hitting the same path again.
 *
 * Two hooks close that, the shape nono uses for its sandbox diagnostics:
 *
 *   - after a tool call fails (PostToolUseFailure, and PostToolUse for Bash,
 *     which reports a failed command as a result): read this role's kernel
 *     refusals from the last moments and hand the agent the same sentence the
 *     PreToolUse hook would have — whose it is, how many times, and that it
 *     should hand it over rather than retry. The kernel's line reaches the log
 *     about 30 ms after the refusal (measured inside the sandbox), so this reads it.
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
import { readEntries } from "./log.js";
import { explain } from "./owners.js";
import { timesHit, walls } from "./walls.js";
import { collapseSidecars } from "./render.js";

/** What a refused write or read looks like in a tool's output. A trigger to look, not a verdict. */
export const DENIAL_SIGNS = /Operation not permitted|EPERM|EACCES|Permission denied|Read-only file system/i;

/**
 * Refusals the runtime's profile makes that never reach the log, recognised by
 * what the failing program printed.
 *
 * The log holds what the kernel refused on a path or a port. A Mach service
 * registration is neither: the profile refuses it, the program dies with its
 * own words, and nothing in `.seisin/` says why. Each entry here is one of those
 * signatures, measured, with the sentence that sends the agent to the fix
 * instead of to a retry. Kept to exact signatures — a guess here would be an
 * explanation for a failure seisin did not cause.
 */
export const KNOWN_REFUSALS = [
  {
    // Measured 2026-09-23 with Playwright's Chromium under seisin on macOS. It
    // cost a team an afternoon: the error names a Mach port, not a file.
    sign: /bootstrap_check_in\s+org\.chromium\.Chromium\.MachPortRendezvousServer\S*:\s*Permission denied \(1100\)/,
    say: "Chromium could not register its Mach port: the sandbox does not allow it, and no grant " +
      "changes that. Launch it with --single-process (Playwright: launchOptions.args) and one worker.",
  },
];

/** The known refusals whose signature is in this output. */
export function knownRefusals(evidence) {
  return KNOWN_REFUSALS.filter((k) => k.sign.test(evidence)).map((k) => k.say);
}

/** How far back a refusal still belongs to the call that just failed. */
const WINDOW_MS = 120_000;
/** Read only the end of the log: this runs on every failed command. The line the cut lands in is dropped (readLines). */
const TAIL_BYTES = 512 * 1024;
/** How many paths to name. More than this is a wall of text nobody acts on. */
const MAX_NAMED = 3;

/** This role's refusals by the kernel since `sinceMs`, one per path, newest first. */
export function recentKernelDenials(file, role, sinceMs) {
  const since = new Date(sinceMs).toISOString();
  const seen = new Map();
  for (const e of readEntries(file, { tail: TAIL_BYTES }).reverse()) {
    if (e.role !== role || e.verdict !== "denied" || e.source !== "kernel") continue;
    if (!e.at || e.at < since || !e.target) continue;
    const k = `${e.action}\u0000${e.target}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  return [...seen.values()];
}

/** The sentence for one refusal, in the words the PreToolUse hook uses. */
function sentence(config, role, file, e) {
  const action = e.kind === "key" ? "read" : e.action === "read" || e.action === "connect" ? e.action : "write";
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
  "The sandbox this agent runs in, set up by seisin, denied part of that. This is not a Unix permission " +
  "or a macOS privacy prompt: chmod, sudo or a different path to the same file will not change it.";

/**
 * What the tool said, and whether it said it failed.
 *
 * PostToolUseFailure is a failure by definition, and its evidence is all of it.
 * PostToolUse is a Bash result, and most of those are successes: a command that
 * prints "Permission denied" to stdout — a grep through logs, a test that
 * checks for it — used to pay the full retry schedule (413 ms measured) to
 * find nothing. So there, only stderr counts, and only an explicit failure
 * (a non-zero exit code, or `is_error`) is a reason to wait for the kernel.
 * A success with the words on stderr — `cmd; true` swallowed the status —
 * still gets one look at the log, just not the waits.
 */
function evidenceOf(event) {
  if (event.hook_event_name !== "PostToolUse")
    return { text: JSON.stringify({ r: event.tool_response, e: event.error, o: event.tool_output }), failed: true };
  const r = event.tool_response;
  if (typeof r === "string") return { text: JSON.stringify(r), failed: false };
  const code = r?.exit_code ?? r?.exitCode ?? r?.code;
  const failed = r?.is_error === true || (typeof code === "number" && code !== 0);
  return { text: JSON.stringify(typeof r?.stderr === "string" ? r.stderr : ""), failed };
}

/**
 * After a tool call failed. Returns the hook output, or null to say nothing.
 *
 * `wait` retries the read a few times: the kernel's line lands ~30 ms after the
 * refusal, and a loaded machine can be slower than the hook. Only when the tool
 * reported a failure — see {@link evidenceOf}.
 */
export async function afterTool(config, role, event, { file, now = Date.now, wait = [0, 100, 300] } = {}) {
  const { text: evidence, failed } = evidenceOf(event);
  if (!DENIAL_SIGNS.test(evidence)) return null;
  // JSON escapes what the program printed; the signatures are written against the text.
  const known = knownRefusals(evidence.replace(/\\n/g, "\n").replace(/\\"/g, '"'));
  let found = [];
  for (const ms of failed ? wait : [0]) {
    if (ms) await new Promise((ok) => setTimeout(ok, ms));
    found = recentKernelDenials(file, role, now() - WINDOW_MS);
    if (found.length) break;
  }
  const lines = [...known, ...found.map((e) => sentence(config, role, file, e)).filter(Boolean)].slice(0, MAX_NAMED);
  if (!lines.length) return null;
  const total = known.length + found.length;
  const more = total > MAX_NAMED ? ` (and ${total - MAX_NAMED} more — \`seisin walls ${role}\`)` : "";
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
  const w = file ? walls(config, role, { file, limit: 5, fresh: true }) : [];
  if (w.length) {
    lines.push("Already denied more than once, and still denied — do not try again, hand it over:");
    for (const x of w)
      lines.push(`- ${x.action} ${x.target} (${x.times}×) — ${x.owners?.length ? `belongs to ${x.owners.join(", ")}` : x.reason}`);
  }
  lines.push("A file outside that is somebody else's: say whose it is and hand it over, rather than working around it.");
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } };
}
