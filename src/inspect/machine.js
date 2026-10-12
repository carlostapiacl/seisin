import { resolve, delimiter } from "node:path";
import { RUNTIME_WRITES, expand } from "../srt.js";
import { realOrSelf } from "../grants.js";
import { wired, broadlyWired } from "../commands/wire.js";

export function relativePathWarnings() {
  const warnings = [];
  // PATH entries that are not absolute resolve against wherever the parent is
  // standing, which is the repo. They are ignored for every lookup seisin makes
  // outside the sandbox; said here because a lookup that skips them can find a
  // different program than your shell does.
  const unanchored = (process.env.PATH ?? "").split(delimiter).filter((d) => !d || !d.startsWith("/"));
  if (unanchored.length)
    warnings.push({
      kind: "relative-path",
      headline: `PATH has ${unanchored.length} relative entr${unanchored.length === 1 ? "y" : "ies"} (${unanchored.map((d) => JSON.stringify(d)).join(", ")})`,
      detail: "They resolve inside the repo, where roles write, so seisin skips them when it looks for a program to run outside the sandbox.",
    });
  return warnings;
}

export function scratchWarnings(config) {
  const warnings = [];
  // Scratch is granted to every role, so a repo sitting inside it is writable
  // by all of them no matter what the territory says. Saying so is the
  // difference between a limitation and a trap — and it is not hypothetical:
  // the test fixture lived in the temp dir and made a boundary test pass for
  // the wrong reason.
  // Both sides resolved, or the comparison is a coin flip. `expand()` follows
  // symlinks — it has to, because on macOS /tmp is a link to /private/tmp and a
  // grant written as /tmp grants nothing — so the root has to be followed too.
  // Without this a repo at /tmp/x is never reported as sitting in scratch,
  // which is the one case where the warning matters most.
  const scratch = (config.runtimeWrites ?? RUNTIME_WRITES).map(expand);
  const root = realOrSelf(resolve(config.root));
  const inside = scratch.filter((s) => root === s || root.startsWith(s + "/"));
  if (inside.length)
    warnings.push({
      kind: "scratch",
      headline: `this repo lives inside shared scratch space (${inside[0]})`,
      detail: "Every role can write scratch, so territory does not hold here. Move the repo, or set [runtime] writes = [].",
    });
  return warnings;
}

export function hookWarnings(config) {
  const warnings = [];
  if (!wired(config.root))
    warnings.push({
      kind: "hook-not-wired",
      headline: "only denials are being recorded: the agent has not been told to run the hook",
      detail:
        process.platform === "darwin"
          ? "the boundary holds either way, and denials are still logged and still queue a " +
            "request — `seisin run` reads them from the kernel. What is missing is every " +
            "action that was allowed, so `review` cannot tell you which grants are unused and " +
            "`init --from-observations` has nothing to build from. Run `seisin wire` once in " +
            "this repo."
          : "the boundary holds either way — but on this platform the kernel's denials are " +
            "not readable either, so log, watch, requests, grant and review all read a record " +
            "that nobody is writing. Run `seisin wire` once in this repo.",
    });

  else if (broadlyWired(config.root))
    warnings.push({
      kind: "hook-matcher-broad",
      headline: "the hook runs on every tool call: it was wired before 0.5.0 with the matcher \"*\"",
      detail:
        "nothing is lost — every tool the hook reads is still covered — but each Read, Glob " +
        "and TodoWrite starts a process that has nothing to say. Run `seisin wire` again: it " +
        "narrows seisin's own entry in place and leaves everyone else's hooks alone.",
    });
  return warnings;
}
