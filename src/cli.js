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

import { run } from "./commands/run.js";
import { check } from "./commands/check.js";
import { explainCommand } from "./commands/explain.js";
import { scanCommand } from "./commands/scan.js";
import { init, initFromObservations } from "./commands/init.js";
import { log, watch } from "./commands/log.js";
import { hook } from "./commands/hook.js";
import { ui } from "./commands/ui.js";
import { requests, grant, deny } from "./commands/requests.js";
import { whose } from "./commands/whose.js";
import { wallsCommand } from "./commands/walls.js";
import { reviewCommand } from "./commands/review.js";
import { wire } from "./commands/wire.js";
import { serveMcp } from "./mcp.js";

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
  seisin review                         what the log says about the policy
  seisin walls <role>                   what that role keeps being refused, and what it cost
  seisin wire                           let the agent record what it does
  seisin requests                       what the agents asked for and could not do
  seisin grant <n> [--reason "…"]       approve one, with its provenance
  seisin deny <n> [--reason "…"]        refuse one, and record why
  seisin log [--role r] [--verdict denied]
  seisin watch                          follow the log live
  seisin init [--from-observations]     propose a ${CONFIG_NAME} for this repo
  seisin ui [--port n]                  open the console, live
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
  run: async () => await run(config(), argv),
  // Non-zero when the policy cannot be enforced as written, so `seisin check`
  // composes in a pre-commit hook or CI the way `explain` and `scan` already do.
  // Warnings about a config that WILL work still exit 0 — failing on those
  // would make the command unusable within a week.
  check: () => (check(config(), argv).warnings.some((w) => w.kind === "cannot-be-enforced") ? 1 : 0),
  explain: () => (explainCommand(config(), argv).allowed ? 0 : 1),
  scan: () => (scanCommand(config()).certain.length ? 1 : 0),
  log: () => void log(config(), argv),
  watch: () => void watch(config()),
  init: () => void (argv.includes("--from-observations") ? initFromObservations(config()) : init()),
  ui: () => ui(config(), argv),
  whose: () => void whose(config(), argv),
  wire: () => void wire(config()),
  review: () => (reviewCommand(config(), argv).friction.length ? 1 : 0),
  walls: () => (wallsCommand(config(), argv).length ? 1 : 0),
  requests: () => (requests(config()).length ? 1 : 0),
  grant: () => void grant(config(), argv),
  deny: () => void deny(config(), argv),
  mcp: async () => {
    await serveMcp(version());
    return 0;
  },
  hook: async () => {
    const decision = await hook();
    if (decision?.hookSpecificOutput) out(JSON.stringify(decision) + "\n");
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
