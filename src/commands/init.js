/**
 * `seisin init` — where the first policy comes from.
 *
 * Every permission tool dodges this question. Written by hand the first policy
 * is a guess, and the first unjustified denial is when the tool gets
 * uninstalled. So there are two ways in, and both of them **propose**:
 *
 *   init                      read what the repo already says about ownership
 *   init --from-observations  read what the agents actually did
 *
 * The second is better and needs a run first. Neither writes a policy you did
 * not read: `--from-observations` lands as `.observed`, not as the config.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIG_NAME, tomlString, tomlName } from "../layout.js";
import { read, logPath, observed, generalise } from "../log.js";
import { C, out } from "../render.js";

/**
 * Three places a repo already says who does what, in order of how much it
 * actually means. None is a policy, so all of them are proposals.
 */
export function discover(root) {
  const agents = join(root, ".claude", "agents");
  if (existsSync(agents)) {
    const roles = readdirSync(agents)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f.replace(/\.md$/, ""), writes: [], keys: [] }));
    if (roles.length) return { source: ".claude/agents/", roles };
  }

  for (const p of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const file = join(root, p);
    if (!existsSync(file)) continue;
    const paths = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0])
      .filter((g) => g && g !== "*");
    if (paths.length)
      return {
        source: p,
        roles: [...new Set(paths)].slice(0, 8).map((g, i) => ({
          name: g.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || `role-${i + 1}`,
          writes: [g.endsWith("/") ? g + "**" : g],
          keys: [],
        })),
      };
  }

  return {
    source: "nothing to read — this is a blank start",
    roles: [
      { name: "frontend", writes: ["src/web/**"], keys: [] },
      { name: "backend", writes: ["src/api/**"], keys: [] },
    ],
  };
}

/** The proposed config, as TOML. Pure: takes what `discover` found. */
export function renderConfig(found) {
  const lines = [
    "# seisin — which folders each agent writes, and which keys it may read.",
    "#",
    `# Proposed from: ${found.source}`,
    "# Nothing here is enforced until you run the agent through `seisin run`.",
    "# Anything not listed is denied. There is no permissive default.",
    "",
    "# [keys]",
    '# dir = ".secrets"      # every key lives here; roles name the files they may read',
    "",
    "[network]",
    "# The agent's own API comes first. Leave it out and the agent cannot even",
    "# authenticate — it fails with a 403 from the egress proxy before it does",
    "# any work, which reads as a broken install rather than a strict policy.",
    "#",
    "# THE LIST BELOW IS CLAUDE'S. If a role runs a different agent, add that",
    "# agent's host or the role will sit inside a perfect territory unable to",
    "# reach its own model. Per role:  [roles.NAME]  network = [ ... ]",
    "allow = [",
    '  "api.anthropic.com", "*.anthropic.com",',
    '  "github.com", "*.github.com",',
    '  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"',
    "]",
    "",
  ];
  for (const r of found.roles) {
    lines.push(`[roles.${tomlName(r.name)}]`);
    lines.push(`writes = [${r.writes.map(tomlString).join(", ")}]`);
    lines.push(`keys   = [${r.keys.map(tomlString).join(", ")}]`);
    lines.push("");
  }
  return lines.join("\n");
}

/** The observed config, as TOML. Pure: takes the log entries. */
export function renderObserved(config, entries) {
  const roles = observed(entries);
  const lines = [
    `# ${CONFIG_NAME} — written from ${entries.length} observed action(s).`,
    "#",
    "# This is what your agents actually did, generalised to directories. Read it",
    "# before you trust it: an agent that touched a file once by mistake asked for",
    "# that directory here, and observation cannot tell intent from accident.",
    "",
  ];
  if (config.keyDirs.length)
    lines.push("[keys]", `dir = [${config.keyDirs.map(tomlString).join(", ")}]`, "");
  lines.push("[network]", `allow = [${config.allowedDomains.map(tomlString).join(", ")}]`, "");

  /**
   * Every declared role appears, whether it acted or not.
   *
   * This used to emit only the roles the log had seen, and the file says "diff
   * it, then move it" — so moving it deleted the territory of every role that
   * happened to be idle during the observation window, silently. A role that
   * did nothing is not a role that needs nothing; it is a role nobody watched.
   *
   * So observation *adds*. What was declared stays, what was seen is appended,
   * and the comment beside each role says which part came from where — because
   * the whole reason to read this file is to tell the two apart.
   */
  for (const name of new Set([...Object.keys(config.roles), ...roles.keys()])) {
    const declared = config.roles[name];
    const seen = roles.get(name);

    const from = declared ? declared.writes : [];
    const found = seen ? generalise([...seen.writes]).filter((w) => !from.includes(w)) : [];
    const keys = [
      ...(declared ? declared.keys : []),
      ...(seen ? [...new Set([...seen.keys].map((k) => k.replace(/^.*\//, "")))] : []),
    ];

    // Every value below came out of the log, and the log records paths the
    // agent chose. tomlString refuses what the format cannot hold rather than
    // emitting a file that parses into something else.
    lines.push(`[roles.${tomlName(name)}]`);
    lines.push(`writes = [${[...from, ...found].map(tomlString).join(", ")}]`);
    lines.push(`keys   = [${[...new Set(keys)].map(tomlString).join(", ")}]`);
    lines.push(
      seen
        ? `# declared ${from.length}; observation added ${found.length} ` +
          `(${seen.writes.size} path(s) written, ${seen.keys.size} key(s) read)`
        : `# declared ${from.length}; this role did nothing while observing — kept as written`
    );
    lines.push("");
  }
  return { toml: lines.join("\n"), roles: roles.size };
}

export function init(cwd = process.cwd()) {
  const target = join(cwd, CONFIG_NAME);
  if (existsSync(target))
    throw new Error(`${CONFIG_NAME} already exists here. Delete it first if you meant to start over.`);

  const found = discover(cwd);
  writeFileSync(target, renderConfig(found));
  out(
    `\n  wrote ${C.b}${CONFIG_NAME}${C.off} with ${found.roles.length} role(s) from ${found.source}\n` +
    `  ${C.dim}These are a proposal, not a policy. Read them before you run anything.${C.off}\n\n` +
    `  next:  seisin check\n\n`
  );
  return found;
}

export function initFromObservations(config) {
  const entries = read(logPath(config.root), { verdict: "observed" });
  if (entries.length === 0)
    throw new Error("nothing observed yet. Run: seisin run <role> --observe -- <command>");

  const { toml, roles } = renderObserved(config, entries);
  const file = join(config.root, CONFIG_NAME + ".observed");
  writeFileSync(file, toml);
  out(
    `\n  wrote ${C.b}${relative(process.cwd(), file)}${C.off} from ${entries.length} observation(s), ${roles} role(s)\n` +
    `  ${C.dim}Not ${CONFIG_NAME} — a policy generated behind your back is not a policy. Diff it, then move it.${C.off}\n\n`
  );
  return { file, entries: entries.length, roles };
}
