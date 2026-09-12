/**
 * The PreToolUse hook: the only place that can see an attempt.
 *
 * The kernel is silent by design. When the sandbox refuses a write, all that
 * reaches anyone is the operating system's `Operation not permitted` on the
 * child's stderr — no path, no reason, and nothing to read afterwards. That is
 * correct behaviour for an enforcer and useless as an instrument.
 *
 * A hook runs one layer up. It sees the path *before* the attempt, which means
 * it can do the two things the kernel cannot: write down what was tried, and
 * say whose file it was.
 *
 * ── Why this file is allowed to be imperfect ──
 * It reads a Bash command with regular expressions, and a determined command
 * can hide its target from that. That would be a fatal flaw in an enforcer and
 * is a minor one here, because the enforcer is the kernel and it is not fooled.
 * What escapes this file goes unexplained, not unblocked.
 */
import { explain } from "./owners.js";
import { append, logPath } from "./log.js";
import { record, requestsPath } from "./requests.js";

/** Tools whose input names a file directly. */
const FILE_TOOLS = {
  Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  Read: "read", NotebookRead: "read",
};

/**
 * Paths a shell command is going to write.
 *
 * Redirections and the handful of commands whose job is to put bytes
 * somewhere. Deliberately not exhaustive — see the note at the top about what
 * this file is for.
 */
const REDIRECT = /(?:^|\s|;|&&|\|\|)>{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g;
const WRITERS = /(?:^|\s|;|&&|\|\|)(?:cp|mv|install|tee|touch|mkdir|rm|rmdir|truncate|dd)\s+([^\n;|&]+)/g;

export function targetsOf(tool, input = {}) {
  const kind = FILE_TOOLS[tool];
  if (kind) {
    const p = input.file_path ?? input.path ?? input.notebook_path;
    return p ? [{ action: kind, path: p }] : [];
  }
  if (tool !== "Bash" || typeof input.command !== "string") return [];

  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const p = String(raw).replace(/^["']|["']$/g, "");
    if (!p || p.startsWith("-") || seen.has(p)) return;
    if (!looksLikeAPath(p)) return;
    seen.add(p);
    out.push({ action: "write", path: p });
  };

  for (const m of input.command.matchAll(REDIRECT)) add(m[1]);
  for (const m of input.command.matchAll(WRITERS)) {
    for (const arg of m[1].split(/\s+/)) if (!arg.startsWith("-")) add(arg);
  }
  return out;
}

/**
 * Is this a filename, or shell debris?
 *
 * Reading a command with regular expressions picks up things that are not
 * paths: a stray `2>`, the word `test` out of `[ -w x ] && test ...`, a device
 * node. Each one becomes a line in the log that says a role was denied
 * something it never asked for, and a log with fabricated entries in it stops
 * being read. Better to explain less and be believed.
 */
const SHELL_NOISE = new Set(["test", "true", "false", "then", "else", "fi", "do", "done", "&&", "||", ";"]);

function looksLikeAPath(p) {
  if (SHELL_NOISE.has(p)) return false;
  if (/^\d*[<>&|]/.test(p)) return false;              // 2>, >&1, |
  if (p.startsWith("/dev/")) return false;              // /dev/null and friends
  if (!/[/.]/.test(p) && !/^[.\w-]+$/.test(p)) return false;
  return /[/.]/.test(p) || p.length > 2;
}

/** A path inside a declared key directory is a key, and reads of it are policy. */
function kindOf(config, path) {
  return (config.keyDirs ?? []).some((d) => path === d || path.includes(d + "/")) ? "key" : "file";
}

/**
 * Decides and records one tool call.
 *
 * `observe` is the mode that makes the whole thing usable: it records exactly
 * the same decisions and returns none of them, so a policy can be written from
 * what a real run did instead of from what someone imagined it would do.
 */
export function decide(config, role, event, { observe = false, now = append, ask = record } = {}) {
  const targets = targetsOf(event.tool_name, event.tool_input);
  const file = logPath(config.root);
  const queue = requestsPath(config.root);
  const verdicts = [];

  for (const t of targets) {
    const rel = t.path.startsWith(config.root + "/") ? t.path.slice(config.root.length + 1) : t.path;
    const kind = kindOf(config, rel);

    // Reading an ordinary file is never a policy question. Territory divides
    // who may CHANGE something; an agent that cannot read the rest of the repo
    // cannot do the work at all. Only keys are scoped on read.
    //
    // This was wrong once and it was not subtle: the hook denied a plain Read
    // of a markdown file, the agent burned its turns unable to look at what it
    // had been asked to edit, and the log showed a tidy `denied` that looked
    // like the system working.
    if (t.action === "read" && kind !== "key") continue;

    const v = explain(config, role, kind === "key" ? "read" : "write", rel);

    now(file, {
      role,
      tool: event.tool_name,
      action: t.action,
      kind,
      target: rel,
      verdict: observe ? "observed" : v.allowed ? "allowed" : "denied",
      owners: v.owners ?? [],
      reason: v.reason,
    });
    // A denial already carries everything a request needs, so leave one behind:
    // the refusal stops being a dead end and becomes something a person can act
    // on in one command. Observing records nothing to approve — there was no
    // denial to answer. See docs/permission-requests.md.
    if (!observe && !v.allowed)
      ask(queue, { role, action: kind === "key" ? "read" : t.action, target: rel, owners: v.owners ?? [] });

    verdicts.push({ ...v, target: rel, kind });
  }

  if (observe) return { decision: null, logged: verdicts.length };

  const denied = verdicts.find((v) => !v.allowed);
  if (!denied) return { decision: null, logged: verdicts.length };
  const wasRead = denied.kind === "key";

  // The hook advises; it does not enforce. Returning `deny` here stops the call
  // early and — the part that matters — hands the agent a sentence it can act
  // on, instead of an errno it can only retry.
  return {
    decision: "deny",
    logged: verdicts.length,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        // The sentence has to name a next step, not just a refusal. An agent
        // told "no" retries; an agent told whose it is asks, or moves on.
        denied.owners?.length
          ? wasRead
            ? `${denied.target} is declared for ${denied.owners.join(", ")}, not ${role}. Ask for what you need from it rather than reading the key.`
            : `${denied.target} belongs to ${denied.owners.join(", ")}. It is not ${role}'s to change — hand it over rather than working around it.`
          : `${denied.reason} (seisin)`,
    },
  };
}
