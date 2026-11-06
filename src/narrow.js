/**
 * One policy, and what a single run makes of it: `seisin run <role> --only …
 * --deny … --var …`.
 *
 * The role in the policy is the most that role can ever do. A run can take away
 * from it and never add to it, so the file a person reads is always the ceiling,
 * whatever a launcher passes. A launcher that lends each task a few folders no
 * longer has to generate a policy per run to say so.
 *
 * What the run ends up under is written down, as an ordinary JSON policy named
 * by its own hash, in `<state>/policies/`. From there on the run is like any
 * other: the sandbox settings, the canary and the hook all read one policy
 * file. The hash is the `policy` every line of the log already carries, so a
 * log line can always be taken back to exactly what held at the time, and two
 * runs can never overwrite each other's.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { loadConfig, parseJsonPolicy, parseToml, policyId } from "./config.js";
import { WILD } from "./paths.js";
import { stateDir } from "./state.js";
import { expandVars, varNames } from "./vars.js";

/** Every value a repeatable flag was given. */
function valuesOf(mine, flag) {
  const out = [];
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] !== flag) continue;
    const v = mine[i + 1];
    if (v === undefined || v === "" || v.startsWith("-")) throw new Error(`${flag} needs a path`);
    out.push(v);
    i++;
  }
  return out;
}

export const narrowingOf = (mine) => ({ only: valuesOf(mine, "--only"), deny: valuesOf(mine, "--deny") });

/** A path or glob a run may name: inside the repo, relative, in one spelling. */
function clean(glob, flag) {
  if (isAbsolute(glob)) throw new Error(`${flag} ${glob}: relative to the repo, not absolute`);
  const n = normalize(glob).replace(/^\.\//, "");
  if (n === ".." || n.startsWith("../")) throw new Error(`${flag} ${glob}: outside the repo`);
  return glob.endsWith("/") ? `${n.replace(/\/+$/, "")}/**` : n;
}

/**
 * Whether every path `glob` can match is one `ceiling` matches too.
 *
 * Answered only when the answer is certain: the same text, `**`, or a subtree
 * that holds it. Anything else (`src/*`-style ceilings, a glob whose head is not
 * literal) is "no", because the cost of a wrong yes is a run with more than the
 * policy says, and the cost of a wrong no is a message that says what to write.
 */
export function coveredBy(glob, ceiling) {
  const g = normalize(glob);
  const c = normalize(ceiling).replace(/\/+$/, "");
  if (c === "**" || g === c) return true;
  const subtree = c.endsWith("/**");
  const base = subtree ? c.slice(0, -3) : c;
  if (WILD.test(base)) return false;
  const wild = g.search(WILD);
  const head = (wild === -1 ? g : g.slice(0, wild)).replace(/\/+$/, "");
  // A literal ceiling is that path and what is beneath it (owners.js, covers).
  return head === base || head.startsWith(base + "/");
}

/** The run's writes: what `--only` names, each of it inside what the role has. */
function narrowWrites(parsedRole, role, only) {
  const ceiling = Array.isArray(parsedRole.writes) ? parsedRole.writes : [];
  const names = only.map((g) => clean(g, "--only"));
  for (const g of names)
    if (!ceiling.some((c) => coveredBy(g, c)))
      throw new Error(
        `--only ${g}: role "${role}" cannot write that, so a run of it cannot either.\n` +
        `  A run only takes away from its role. Its writes are: ${ceiling.join(", ") || "none"}.`);
  // One already covered by another adds nothing but rules: the sandbox writes a set
  // of them per path, and Seatbelt refuses a profile past its size.
  const unique = [...new Set(names)];
  parsedRole.writes = unique.filter((g) => !unique.some((other) => other !== g && coveredBy(g, other)));
}

/**
 * The policy this run holds under, or the one it was given when there is nothing
 * to work out. Never starts anything: every refusal here is before the sandbox.
 */
export function effectiveConfig(config, role, { only, deny, observe = false }) {
  const text = readFileSync(config.path, "utf8");
  const parsed = String(config.path).endsWith(".json") ? parseJsonPolicy(text, config.path) : parseToml(text);
  const unbound = expandVars(parsed);
  const narrows = only.length > 0 || deny.length > 0;
  if (!narrows && varNames().length === 0 && unbound.length === 0) return { config, narrowed: null };
  if (observe && narrows)
    throw new Error("--observe opens the repo for the run, and --only and --deny close it: choose one.");
  const missing = unbound.filter((u) => u.role === role || !u.role);
  if (missing.length)
    throw new Error(
      `${config.path}: ${missing.map((u) => `$${u.name} (${u.where})`).join(", ")} has no value.\n` +
      `  Give it with --var NAME=value. The run does not start without it: a path left out ` +
      `is a run under a policy nobody wrote.`);
  const mine = parsed.roles[role];
  if (only.length) narrowWrites(mine, role, only);
  if (deny.length) {
    // On Linux a path has to exist to be mounted over. `never_writes` in a file
    // says so in `check`; a run asked for this on its line, and starting without
    // it would be a run with more than it was asked to have.
    if (process.platform === "linux")
      for (const g of deny.map((d) => clean(d, "--deny")))
        if (!existsSync(join(config.root, g.replace(/\/\*\*$/, ""))))
          throw new Error(`--deny ${g}: it does not exist, and on Linux a path has to exist to be closed. The run did not start.`);
    const had = Array.isArray(mine.never_writes) ? mine.never_writes : [];
    mine.never_writes = [...new Set([...had, ...deny.map((g) => clean(g, "--deny"))])];
  }
  const json = JSON.stringify(parsed, null, 2) + "\n";
  const id = createHash("sha256").update(json).digest("hex").slice(0, 12);
  const dir = join(stateDir(config.root), "policies");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, json);
  renameSync(tmp, file);
  // Validated like any policy, so a --deny the file could not hold is refused
  // here with the reason, rather than by the sandbox later.
  const effective = loadConfig(file, json, { root: config.root });
  effective.sourcePolicy = config.path;
  return {
    config: effective,
    narrowed: { source: config.path, sourcePolicy: policyId(config), only, deny, vars: varNames() },
  };
}
