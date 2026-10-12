import { resolve, delimiter, join } from "node:path";
import { realOrSelf, runtimeWritesFor, toWritePath } from "../grants.js";
import { realAncestor } from "../paths.js";
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
  // the wrong reason, and a role in a toy repo under /tmp wrote outside its
  // `writes` with nothing on screen to say why.
  // Both sides resolved, or the comparison is a coin flip. `expand()` follows
  // symlinks — it has to, because on macOS /tmp is a link to /private/tmp and a
  // grant written as /tmp grants nothing — so the root has to be followed too.
  // Without this a repo at /tmp/x is never reported as sitting in scratch,
  // which is the one case where the warning matters most.
  //
  // The scratch a role is really given, not the default list: `[runtime]
  // writes` when the policy sets it, and none of it under `isolate = "home"`,
  // where each role gets a home of its own instead (grants.js, writePathsOf).
  const level = config.isolate === true ? "home" : config.isolate;
  const scratch = level === "home" ? [] : runtimeWritesFor(config, undefined);
  const under = (p) => scratch.find((s) => p === s || p.startsWith(s + "/"));
  const fix = (s) => `Move it out of ${s}, or set [runtime] writes to a list that leaves ${s} out ` +
    `(\`[runtime] writes = []\` gives no role any shared scratch).`;
  const root = realOrSelf(resolve(config.root));
  const around = under(root);
  if (around) {
    warnings.push({
      kind: "scratch",
      headline: `every role can write the whole repo: it lives inside ${around}, which every role gets as scratch`,
      detail: "Territory does not hold here — a role's writes is no limit when the directory around the repo " +
        `is granted to all of them. ${fix(around)}`,
    });
    return warnings;
  }
  /**
   * The repo is outside scratch, and part of a territory still is: a `writes`
   * entry that goes through a symlink (`out -> /tmp/out`) or up and out with
   * `..`. The kernel enforces on the real path, so that part of the role's
   * territory is every role's. Said per resolved path, once.
   */
  const seen = new Set();
  for (const r of Object.values(config.roles)) {
    for (const g of r.writes ?? []) {
      let real;
      try { real = realAncestor(join(config.root, toWritePath(g))); } catch { continue; }
      const s = under(real);
      if (!s || seen.has(real)) continue;
      seen.add(real);
      warnings.push({
        kind: "territory-in-scratch",
        headline: `every role can write ${r.name}'s ${g}: it resolves to ${real}, inside ${s}, which every role gets as scratch`,
        detail: `That part of ${r.name}'s territory does not hold — the kernel enforces on the real path. ${fix(s)}`,
      });
    }
  }
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
