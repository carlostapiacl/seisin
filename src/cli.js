#!/usr/bin/env node
/**
 * seisin — give each agent its own folders and its own keys.
 *
 * This file is dispatch and nothing else: parse argv, load the config, call one
 * command, turn a thrown error into an exit code. Every command lives in
 * `commands/` and every decision lives in a module beside it, so that a change
 * to how something is printed cannot change what is allowed.
 *
 * Enforcement is not ours. @anthropic-ai/sandbox-runtime asks the operating
 * system — Seatbelt on macOS, bubblewrap on Linux — and the kernel does not
 * care how a command was spelled. What seisin adds is the part a kernel can
 * never know: which role a path belongs to, and therefore who to ask next.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { findConfig, loadConfig } from "./config.js";
import { CONFIG_NAME } from "./layout.js";
import { C, out, err } from "./render.js";

/**
 * Each command is imported when it is the one being run, not before.
 *
 * All fifteen used to load up front — 42 of 47 modules, the MCP server and the
 * HTTP console among them — and `seisin hook` paid for every one on every tool
 * call of every agent: 218 ms measured, where the hook itself needs a fraction
 * of that. A dispatcher that loads everything to run one thing charges the
 * most frequent command for the rarest ones. So each entry in COMMANDS below
 * does its own `import()`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , command, ...argv] = process.argv;

const USAGE = `
${C.b}seisin${C.off} — give each agent its own folders and its own keys

  seisin run <role> -- <command...>     run a command as that role
  seisin run <role> --observe -- <cmd>  open the repo and watch — the network stays shut
  seisin check [role]                   print the map, run nothing
  seisin explain <role> read|write <path>
  seisin whose <path>                   who owns it — safe to call from inside the box
  seisin scan                           find secrets outside the declared key dirs
  seisin review [--all]                 what the log says about the policy
  seisin walls <role> [--all]           what that role keeps being denied, and what it cost
  seisin wire                           let the agent record what it does
  seisin requests                       what the agents asked for and cannot have
  seisin grant <n> [--reason "…"]       approve one, with its provenance
  seisin decline <n> [--reason "…"]     turn one down, and record why
  seisin log [--role r] [--verdict denied]
  seisin log verify                     does the log's hash chain hold
  seisin watch                          follow the log live
  seisin init [--from-observations]     propose a ${CONFIG_NAME} for this repo
  seisin ui [--port n] [--link]         open the console, live (--link reopens a running one)
  seisin mcp                            an MCP server on stdio — read-only

Enforcement comes from @anthropic-ai/sandbox-runtime, which asks the OS.
seisin decides what to ask for, and says whose file it was when the answer is no.
`;

/** Loads the policy, or explains where to get one. */
function config() {
  const path = findConfig();
  if (!path) throw new Error(`no ${CONFIG_NAME} found here or above. Run "seisin init" to write one.`);
  return loadConfig(path);
}

/**
 * Commands that need a config get it; commands that make one do not.
 *
 * Each returns the exit code it wants, or nothing for zero. `run` and `ui` are
 * the exceptions — they hand the process over and never come back here.
 */
const COMMANDS = {
  run: async () => await (await import("./commands/run.js")).run(config(), argv),
  // Non-zero when the policy cannot be enforced as written, so `seisin check`
  // composes in a pre-commit hook or CI the way `explain` and `scan` already do.
  // Warnings about a config that WILL work still exit 0 — failing on those
  // would make the command unusable within a week.
  check: async () => ((await import("./commands/check.js")).check(config(), argv).warnings.some((w) => w.kind === "cannot-be-enforced") ? 1 : 0),
  explain: async () => ((await import("./commands/explain.js")).explainCommand(config(), argv).allowed ? 0 : 1),
  scan: async () => ((await import("./commands/scan.js")).scanCommand(config()).certain.length ? 1 : 0),
  log: async () => void (await import("./commands/log.js")).log(config(), argv),
  watch: async () => void (await import("./commands/log.js")).watch(config()),
  init: async () => {
    const { init, initFromObservations } = await import("./commands/init.js");
    void (argv.includes("--from-observations") ? initFromObservations(config()) : init());
  },
  ui: async () => (await import("./commands/ui.js")).ui(config(), argv),
  whose: async () => void (await import("./commands/whose.js")).whose(config(), argv),
  wire: async () => void (await import("./commands/wire.js")).wire(config()),
  review: async () => ((await import("./commands/review.js")).reviewCommand(config(), argv).friction.length ? 1 : 0),
  walls: async () => ((await import("./commands/walls.js")).wallsCommand(config(), argv).length ? 1 : 0),
  requests: async () => ((await import("./commands/requests.js")).requests(config()).length ? 1 : 0),
  grant: async () => void (await import("./commands/requests.js")).grant(config(), argv),
  /**
   * A person DECLINES a request; the boundary DENIES a write. One word each,
   * because they are opposite events and `deny` used to name both — a queue
   * entry said `first refused on …` (the kernel) and the answer said
   * `refused frontend ✕ …` (you).
   *
   * `deny` stays and is not documented. Renaming a published command over a
   * word is not worth breaking somebody's script; teaching the new one is.
   */
  decline: async () => void (await import("./commands/requests.js")).deny(config(), argv),
  deny: async () => void (await import("./commands/requests.js")).deny(config(), argv),
  mcp: async () => {
    await (await import("./mcp.js")).serveMcp(version());
    return 0;
  },
  // Always 0. Claude Code reads a non-zero exit from a PreToolUse hook as
  // "block", so an internal error here would stop the agent's tool call — and
  // the hook explains, it never enforces. The error goes to stderr instead.
  hook: async () => {
    try {
      const decision = await (await import("./commands/hook.js")).hook();
      if (decision?.hookSpecificOutput) out(JSON.stringify(decision) + "\n");
    } catch (e) {
      err(`seisin hook: ${e?.message ?? e} — no decision, the tool call goes ahead\n`);
    }
    return 0;
  },
  "--version": () => void out(version() + "\n"),
  "-v": () => void out(version() + "\n"),
};

function version() {
  return JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
}

const chosen = COMMANDS[command];
if (!chosen) {
  out(USAGE);
  process.exit(command ? 2 : 0);
}

try {
  const code = await chosen();
  if (typeof code === "number") process.exit(code);
} catch (e) {
  err(`${C.red}seisin:${C.off} ${e.message}\n`);
  process.exit(2);
}
