/**
 * `seisin wire` — put the hook where the agent will find it.
 *
 * Nothing wrote the log before this existed. The hook is what records a
 * decision, and the hook only runs if the agent has been told to run it — which
 * the README described as a thing that happens and never once said to set up.
 * So `seisin log` came back empty after a dozen real runs, and with it went
 * `watch`, `requests`, `grant`, `review` and the denial-becomes-a-handoff story
 * the README opens with. Enforcement was solid; everything that remembers was
 * unwired.
 *
 * It writes the project's own `.claude/settings.json`, not the user's global
 * config: a permission tool that edits your machine's settings to install
 * itself has misread the room.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { C, out } from "../render.js";
import { TOOL_MATCHER } from "../hook.js";

const SETTINGS = join(".claude", "settings.json");
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

/** A hook command that is seisin's, however it was spelled when it was wired. */
const isOurs = (c) => typeof c === "string" && c.includes("seisin") && /\bhook"?\s*$/.test(c);

/**
 * The command that reaches THIS seisin from a hook, and how it was found.
 *
 * `seisin hook` was written for everyone. With seisin installed in a project
 * rather than globally there is no `seisin` on PATH, the hook exits 127, and
 * Claude Code carries on without it — nothing on screen, nothing in the log.
 * So: the one on PATH when it is this version; the project's own
 * node_modules/.bin when there is one; otherwise this file, by absolute path.
 */
export function hookCommand(root, { path = process.env.PATH, cli = CLI, version = ownVersion() } = {}) {
  const found = (path ?? "").split(delimiter).map((d) => d && join(d, "seisin")).find((p) => p && existsSync(p));
  let onPath = null;
  if (found) {
    const same = realOrSelf(found) === realOrSelf(cli);
    const v = same ? version : spawnSync(found, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout?.trim();
    onPath = { at: found, version: v };
    if (v === version) return { command: "seisin hook", via: "path", onPath };
  }
  const local = join(root, "node_modules", ".bin", "seisin");
  if (existsSync(local)) return { command: '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/seisin hook', via: "local", onPath };
  return { command: `"${process.execPath}" "${realOrSelf(cli)}" hook`, via: "absolute", onPath };
}

function ownVersion() {
  try { return JSON.parse(readFileSync(join(dirname(CLI), "..", "package.json"), "utf8")).version; } catch { return null; }
}

/** Is `dir` inside a git checkout? Kept here so wire does not load the scanner. */
function insideRepo(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

function realOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** One sentence: which seisin the hook runs, and why that one. */
function saysWhich(h) {
  const other = h.onPath && h.onPath.version !== ownVersion()
    ? ` (the seisin on your PATH is ${h.onPath.version || "another version"}, not ${ownVersion()})` : "";
  if (h.via === "path") return `the hook runs "seisin hook" — seisin ${ownVersion()} is on your PATH`;
  if (h.via === "local") return `the hook runs this project's node_modules/.bin/seisin${other || " — seisin is not on your PATH"}`;
  return `the hook runs this seisin by its full path${other || " — seisin is not on your PATH"}`;
}

/**
 * Every event `seisin hook` answers, and the matcher each one needs.
 *
 * PreToolUse explains before an attempt; the other three explain what only the
 * kernel saw (PostToolUseFailure, and PostToolUse for Bash, whose failed
 * command is a result rather than a failure) and hand the agent its map when a
 * session starts, resumes or is compacted. Exported so a harness that writes
 * its own settings per role — rather than the project's — can install the same.
 */
export function hookEntries(command = "seisin hook") {
  const h = [{ type: "command", command }];
  return {
    PreToolUse: [{ matcher: TOOL_MATCHER, hooks: h }],
    PostToolUse: [{ matcher: "Bash", hooks: h }],
    PostToolUseFailure: [{ matcher: "*", hooks: h }],
    SessionStart: [{ matcher: "startup|resume|compact", hooks: h }],
  };
}

/** Is the hook already wired in this repo? */
export function wired(root) {
  const file = join(root, SETTINGS);
  if (!existsSync(file)) return false;
  try {
    // All four events, not any one: a repo wired before the after-the-fact and
    // session-start hooks existed has only PreToolUse, and "already wired" there
    // would keep it from ever getting the rest.
    const hooks = JSON.parse(readFileSync(file, "utf8")).hooks ?? {};
    return Object.keys(hookEntries()).every((ev) =>
      (hooks[ev] ?? []).some((e) => (e?.hooks ?? []).some((h) => isOurs(h?.command))));
  } catch {
    return false;                       // unreadable settings is not "wired"
  }
}

/**
 * Narrows seisin's own `"*"` PreToolUse entry to {@link TOOL_MATCHER}. True if
 * it changed anything.
 *
 * Only an entry that holds nothing but `seisin hook`: a `"*"` entry that also
 * runs somebody else's command is theirs as much as ours, and narrowing it
 * would silently stop their hook on every other tool.
 */
function narrow(settings) {
  let changed = false;
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    if (broadOurs(entry)) {
      entry.matcher = TOOL_MATCHER;
      changed = true;
    }
  }
  return changed;
}

/** A PreToolUse entry that runs only `seisin hook`, on every tool. */
function broadOurs(entry) {
  const ours = Array.isArray(entry?.hooks) && entry.hooks.length > 0 &&
    entry.hooks.every((h) => isOurs(h?.command));
  return ours && (entry.matcher === "*" || entry.matcher === "" || entry.matcher === undefined);
}

/**
 * Does this repo still run the hook on every tool call — the `"*"` matcher that
 * versions before 0.5.0 installed? Correct, just slow: every Read, Glob and
 * TodoWrite pays for a process start that answers nothing. `seisin wire` narrows
 * it in place; this is how `check` knows to say so.
 */
export function broadlyWired(root) {
  const file = join(root, SETTINGS);
  if (!existsSync(file)) return false;
  try {
    const pre = JSON.parse(readFileSync(file, "utf8")).hooks?.PreToolUse;
    return Array.isArray(pre) && pre.some(broadOurs);
  } catch {
    return false;                       // unreadable settings is reported elsewhere, if at all
  }
}

export function wire(config) {
  const file = join(config.root, SETTINGS);
  const how = hookCommand(config.root);

  // Merged, never replaced. Someone's hooks are their own and a tool that
  // overwrites them to add itself does not get a second chance.
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${SETTINGS} is not valid JSON (${e.message}). Fix it, or move it aside.`);
    }
  }

  if (wired(config.root)) {
    // A bare `seisin hook` where no seisin is on PATH fails on every call
    // without a word. Rewritten in place to the command that works here.
    if (how.via !== "path" && repoint(settings, how.command)) {
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      out(`\n  ${C.green}repointed${C.off}  ${SETTINGS}\n  ${C.dim}"seisin hook" is not on your PATH, so it never ran. ${saysWhich(how)}.${C.off}\n\n`);
      return { changed: true, file, how };
    }
    // Wired before the matcher was narrowed: still correct, just slow, so
    // `wired()` keeps saying yes and nobody is told to redo anything. Running
    // `wire` again is the way to pick up the narrower one, in place.
    if (narrow(settings)) {
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      out(`\n  ${C.green}narrowed${C.off}  ${SETTINGS}\n` +
        `  ${C.dim}PreToolUse now runs "seisin hook" only for the tools it reads, not for every tool${C.off}\n\n`);
      return { changed: true, file };
    }
    out(`\n  ${C.dim}already wired — ${SETTINGS} runs seisin's hook${C.off}\n\n`);
    return { changed: false, file };
  }

  settings.hooks ??= {};
  for (const [ev, entries] of Object.entries(hookEntries(how.command))) {
    settings.hooks[ev] ??= [];
    if (!settings.hooks[ev].some((e) => (e?.hooks ?? []).some((h) => isOurs(h?.command)))) settings.hooks[ev].push(...entries);
  }
  narrow(settings);                     // an older PreToolUse entry that was kept

  mkdirSync(join(config.root, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

  out(
    `\n  ${C.green}wired${C.off}  ${SETTINGS}\n` +
    `  ${C.dim}the agent now runs seisin's hook before each tool call, which is what fills${C.off}\n` +
    `  ${C.dim}the log. Without it the boundary still holds — you just cannot see it work.${C.off}\n` +
    `  ${C.dim}${saysWhich(how)}.${C.off}\n\n` +
    // Only in a repository: outside one there is nothing to commit it to.
    (insideRepo(config.root)
      ? how.via === "absolute"
        ? `  ${C.dim}The command names a path on this machine; teammates should run seisin wire themselves.${C.off}\n\n`
        : `  ${C.dim}Commit this file if the rest of your team should get it too.${C.off}\n\n`
      : "")
  );
  return { changed: true, file, how };
}

/** Replaces a bare `seisin hook` command with `command`. True if it changed anything. */
function repoint(settings, command) {
  let changed = false;
  for (const entries of Object.values(settings.hooks ?? {}))
    for (const e of Array.isArray(entries) ? entries : [])
      for (const h of e?.hooks ?? [])
        if (h?.command === "seisin hook") { h.command = command; changed = true; }
  return changed;
}
