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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { C, out } from "../render.js";
import { TOOL_MATCHER } from "../hook.js";

const SETTINGS = join(".claude", "settings.json");

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
    return Object.keys(hookEntries()).every((ev) => JSON.stringify(hooks[ev] ?? []).includes("seisin hook"));
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
    entry.hooks.every((h) => typeof h?.command === "string" && h.command.includes("seisin hook"));
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
    // Wired before the matcher was narrowed: still correct, just slow, so
    // `wired()` keeps saying yes and nobody is told to redo anything. Running
    // `wire` again is the way to pick up the narrower one, in place.
    if (narrow(settings)) {
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      out(`\n  ${C.green}narrowed${C.off}  ${SETTINGS}\n` +
        `  ${C.dim}PreToolUse now runs "seisin hook" only for the tools it reads, not for every tool${C.off}\n\n`);
      return { changed: true, file };
    }
    out(`\n  ${C.dim}already wired — ${SETTINGS} runs "seisin hook"${C.off}\n\n`);
    return { changed: false, file };
  }

  settings.hooks ??= {};
  for (const [ev, entries] of Object.entries(hookEntries())) {
    settings.hooks[ev] ??= [];
    if (!JSON.stringify(settings.hooks[ev]).includes("seisin hook")) settings.hooks[ev].push(...entries);
  }
  narrow(settings);                     // an older PreToolUse entry that was kept

  mkdirSync(join(config.root, ".claude"), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

  out(
    `\n  ${C.green}wired${C.off}  ${SETTINGS}\n` +
    `  ${C.dim}the agent now runs "seisin hook" before each tool call, which is what fills${C.off}\n` +
    `  ${C.dim}the log. Without it the boundary still holds — you just cannot see it work.${C.off}\n\n` +
    `  ${C.dim}Commit this file if the rest of your team should get it too.${C.off}\n\n`
  );
  return { changed: true, file };
}
