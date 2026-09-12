/**
 * `seisin hook` — the PreToolUse entry point.
 *
 * Claude Code runs this once per tool call, so every path through it is short
 * and every failure is silent-and-permissive. That asymmetry is deliberate: the
 * hook explains, the kernel enforces. A hook that crashes should cost you an
 * explanation, never a blocked turn — and it cannot cost you a boundary,
 * because it was never the boundary.
 */
import { findConfig, loadConfig } from "../config.js";
import { decide } from "../hook.js";

export async function hook(stdin = process.stdin, env = process.env) {
  const role = env.SEISIN_ROLE;
  if (!role) return null;            // not launched by seisin: say nothing, block nothing

  let raw = "";
  for await (const chunk of stdin) raw += chunk;

  let event;
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    return null;                     // an unreadable event is not grounds to block work
  }

  let config;
  try {
    config = loadConfig(env.SEISIN_CONFIG ?? findConfig());
  } catch {
    return null;
  }
  if (!config.roles[role]) return null;

  return decide(config, role, event, { observe: env.SEISIN_OBSERVE === "1" });
}
