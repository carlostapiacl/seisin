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

const SETTINGS = join(".claude", "settings.json");

/** Where the PreToolUse entry lives, and what it has to say. */
export function hookEntry(command = "seisin hook") {
  return {
    matcher: "*",
    hooks: [{ type: "command", command }],
  };
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
    PreToolUse: [{ matcher: "*", hooks: h }],
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
    out(`\n  ${C.dim}already wired — ${SETTINGS} runs "seisin hook"${C.off}\n\n`);
    return { changed: false, file };
  }

  settings.hooks ??= {};
  for (const [ev, entries] of Object.entries(hookEntries())) {
    settings.hooks[ev] ??= [];
    if (!JSON.stringify(settings.hooks[ev]).includes("seisin hook")) settings.hooks[ev].push(...entries);
  }

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
