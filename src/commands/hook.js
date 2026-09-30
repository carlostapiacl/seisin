/**
 * `seisin hook` — the PreToolUse entry point.
 *
 * Claude Code runs this once per tool call, so every path through it is short
 * and every failure is silent-and-permissive. That asymmetry is deliberate: the
 * hook explains, the kernel enforces. A hook that crashes should cost you an
 * explanation, never a stopped tool call — and it cannot cost you a boundary,
 * because it was never the boundary.
 */
import { findConfig, loadConfig } from "../config.js";
import { decide } from "../hook.js";
import { afterTool, atSessionStart } from "../diagnose.js";
import { logPath } from "../log.js";
import { flush } from "../spool.js";

export async function hook(stdin = process.stdin, env = process.env) {
  const role = env.SEISIN_ROLE;
  if (!role) return null;            // not launched by seisin: say nothing, stop nothing

  let raw = "";
  for await (const chunk of stdin) raw += chunk;

  let event;
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    return null;                     // an unreadable event is not grounds to stop work
  }

  let config;
  try {
    config = loadConfig(env.SEISIN_CONFIG ?? findConfig());
  } catch {
    return null;
  }
  if (!config.roles[role]) return null;

  // One command for every event it is wired to, so `seisin wire` adds one name.
  // The after-the-fact and session-start halves only explain; neither decides.
  const event_ = event.hook_event_name;
  if (event_ === "PostToolUse" || event_ === "PostToolUseFailure") {
    try { return await afterTool(config, role, event, { file: logPath(config.root) }); } catch { return null; }
  }
  if (event_ === "SessionStart") {
    try { return atSessionStart(config, role, event, { file: logPath(config.root) }); } catch { return null; }
  }
  // Caught like the two halves above, and for a sharper reason: PreToolUse is
  // the one event where a crash is not silent. cli.js turns a throw into exit
  // 2, and Claude Code reads exit 2 from this hook as "block the tool". A bug
  // here would stop the agent's work — the one thing this command promises
  // never to do. Said on stderr so the bug is still findable.
  let decision = null;
  try {
    decision = decide(config, role, event, { observe: env.SEISIN_OBSERVE === "1" });
  } catch (e) {
    process.stderr.write(`seisin hook: ${e?.message ?? e} — no decision, the tool call goes ahead\n`);
  }
  // The entries went to a socket, and cli.js exits as soon as we return. An
  // exit does not drain a socket, so the record would be lost precisely on the
  // turns that produced one.
  await flush();
  return decision;
}
