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

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , command, ...argv] = process.argv;

const USAGE = `
${C.b}seisin${C.off} — give each agent its own folders and its own keys

  seisin run <role> -- <command...>     run a command as that role
  seisin run <role> --observe -- <cmd>  record, deny nothing
  seisin check [role]                   print the map, run nothing
  seisin explain <role> read|write <path>
  seisin scan                           find secrets outside the declared key dirs
  seisin log [--role r] [--verdict denied]
  seisin watch                          follow the log live
  seisin init [--from-observations]     propose a ${CONFIG_NAME} for this repo
  seisin ui [--port n]                  open the console, live

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
  run: () => run(config(), argv),
  check: () => void check(config(), argv),
  explain: () => (explainCommand(config(), argv).allowed ? 0 : 1),
  scan: () => (scanCommand(config()).certain.length ? 1 : 0),
  log: () => void log(config(), argv),
  watch: () => void watch(config()),
  init: () => void (argv.includes("--from-observations") ? initFromObservations(config()) : init()),
  ui: () => ui(config(), argv),
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
