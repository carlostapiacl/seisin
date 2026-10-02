#!/usr/bin/env node
/**
 * seisin — give each agent its own folders and its own keys.
 *
 * This file is dispatch and nothing else: parse argv, load the config, call one
 * command, make a thrown error an exit code. Every command lives in
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
import { COMMAND_HELP, flagsOf, renderHelp } from "./help.js";
import { nearest, checkFlags } from "./suggest.js";

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
  seisin check [role] [--verbose]       print the map, run nothing
  seisin explain <role> read|write|mcp <path, key or server>
  seisin whose <path>                   who owns it — safe to call from inside the sandbox
  seisin scan [--all]                   find secrets outside the declared key dirs
  seisin review [--all]                 what the log says about the policy
  seisin walls <role> [--all]           what that role keeps being denied, and what it cost
  seisin wire                           let the agent record what it does
  seisin requests                       what the agents asked for and cannot have
  seisin grant <n> [--reason "…"]       grant one: add it to ${CONFIG_NAME}, with its provenance
  seisin decline <n> [--reason "…"]     decline one, and record why
  seisin log [--role r] [--verdict denied] [--limit n]
  seisin log verify                     does the log's hash chain hold
  seisin watch                          follow the log live
  seisin init [--force]                 propose a ${CONFIG_NAME} for this repo
  seisin init --from-observations       write ${CONFIG_NAME}.observed from observed runs
  seisin ui [--port n] [--link]         open the console, live (--link reopens a running one)
  seisin mcp                            an MCP server on stdio — read-only

seisin <command> --help lists a command's flags, examples and exit codes.

Enforcement comes from @anthropic-ai/sandbox-runtime, which asks the OS.
seisin decides what to ask for, and says whose file it was when the answer is no.
`;

/** Loads the policy, or explains where to get one. */
function config() {
  const path = findConfig();
  if (!path) throw new Error(`no ${CONFIG_NAME} found here or above. Run "seisin init" to write one.`);
  return loadConfig(path);
}

/** The policy here, or null — for a command that can answer without one. */
function maybeConfig() {
  const path = findConfig();
  return path ? loadConfig(path) : null;
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
  scan: async () => ((await import("./commands/scan.js")).scanCommand(config(), argv).certain.length ? 1 : 0),
  log: async () => void (await import("./commands/log.js")).log(config(), argv),
  watch: async () => void (await import("./commands/log.js")).watch(config()),
  init: async () => {
    const { init, initFromObservations } = await import("./commands/init.js");
    void (argv.includes("--from-observations") ? initFromObservations(config()) : init(process.cwd(), { force: argv.includes("--force") }));
  },
  // --link only reads a record; it answers without a policy here too, and
  // says so when the console it finds serves another one.
  ui: async () => (await import("./commands/ui.js")).ui(argv.includes("--link") ? maybeConfig() : config(), argv),
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
      // Only what the hook protocol defines. `decision` and `logged` are for the
      // callers inside seisin; Codex validates a hook's output against a schema
      // that admits no other field (and `decision` only as approve|block), and
      // drops the whole answer when it does not fit — measured 2026-09-30 with
      // codex 0.150.1: the deny was ignored and the command ran into the kernel.
      if (decision?.hookSpecificOutput) out(JSON.stringify({ hookSpecificOutput: decision.hookSpecificOutput }) + "\n");
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

/**
 * `--help` is a question, never an instruction to do the thing.
 *
 * No command looked for it, so each one took it as an argument: `ui --help`
 * started a server on 4178, `wire --help` wrote .claude/settings.json, `watch
 * --help` followed the log until ctrl-c, `mcp --help` sat waiting on stdin, and
 * `seisin --help` printed the usage and exited 2. Answered here, before any
 * command is loaded or any policy read, so it works in a directory with none.
 *
 * Only seisin's own part of the line is searched: after `--` the words are the
 * agent's, and so is everything after `run <role> <command>` without one —
 * `seisin run dev -- ls --help` asks `ls`. The value of a flag that takes one
 * (`--reason -h`) is a value.
 */
const HELP = new Set(["--help", "-h"]);
function asksHelp(name, args) {
  const takesValue = new Set(flagsOf(name)?.values ?? []);
  const split = args.indexOf("--");
  let ours = split === -1 ? args : args.slice(0, split);
  if (name === "run" && split === -1) {
    let i = 1;
    while (i < args.length && args[i].startsWith("-")) i += takesValue.has(args[i]) ? 2 : 1;
    ours = args.slice(0, i);
  }
  for (let i = 0; i < ours.length; i++) {
    if (takesValue.has(ours[i])) i++;
    else if (HELP.has(ours[i])) return true;
  }
  return false;
}

/** One command's help: its flags, examples and exit codes, or the whole usage. */
function helpFor(name) {
  if (COMMAND_HELP[name]) return renderHelp(name, C);
  const alias = name === "deny" ? "decline" : name;
  const lines = USAGE.split("\n").filter((l) => l.startsWith(`  seisin ${alias} `) || l === `  seisin ${alias}`);
  if (!lines.length) return USAGE;
  return `\nusage:\n${lines.join("\n")}\n\n  ${C.dim}seisin --help for every command${C.off}\n\n`;
}

if (command === undefined || command === "help" || HELP.has(command)) {
  const about = command === "help" && COMMANDS[argv[0]] && !argv[0].startsWith("-") ? argv[0] : null;
  out(about ? helpFor(about) : USAGE);
  process.exit(0);
}

const chosen = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
if (!chosen) {
  // One line, and the nearest command. The whole usage, printed for a typo,
  // pushed the one line that mattered off the screen.
  const near = command.startsWith("-") ? nearest(command, ["--help", "--version"])
    : nearest(command, Object.keys(COMMANDS).filter((c) => !c.startsWith("-") && c !== "deny"));
  err(`${C.red}seisin:${C.off} unknown ${command.startsWith("-") ? "option" : "command"} "${command}"` +
    `${near ? ` — did you mean "${near}"?` : ""}\n  seisin --help lists every command\n`);
  process.exit(2);
}
if (!command.startsWith("-") && asksHelp(command, argv)) {
  out(helpFor(command));
  process.exit(0);
}

try {
  refuseUnknownFlags(command, argv);
  const code = await chosen();
  if (typeof code === "number") process.exit(code);
} catch (e) {
  err(`${C.red}seisin:${C.off} ${e.message}\n`);
  // A command that was not found is 127 wherever a shell runs it; everything
  // else seisin refuses is a usage or policy error.
  process.exit(e.exitCode ?? 2);
}

/**
 * A flag a command does not take is an error, never ignored: `check --verbsoe`
 * printed the short map as if nothing had been asked. For `run`, only seisin's
 * own part of the line — before `--`, or the leading options — is checked.
 */
function refuseUnknownFlags(name, args) {
  const f = flagsOf(name);
  if (!f || name === "hook" || name === "mcp") return;
  let ours = args;
  if (name === "run") {
    const split = args.indexOf("--");
    if (split !== -1) ours = args.slice(1, split);
    else {
      let i = 1;
      while (i < args.length && args[i].startsWith("-")) i += args[i] === "--agent" ? 2 : 1;
      ours = args.slice(1, i);
    }
  }
  checkFlags(name === "deny" ? "decline" : name, ours, f.known, f.values);
}
