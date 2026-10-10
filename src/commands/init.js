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
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, copyFileSync, appendFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { CONFIG_NAME, tomlString, tomlName } from "../layout.js";
import { read, logPath, observed, generalise } from "../log.js";
import { C, out } from "../render.js";
import { loadConfig } from "../config.js";
import { applyGrant } from "../requests.js";
import { setKey } from "../controls.js";
import { keyName } from "../owners.js";
import { toRepoRelative } from "../paths.js";

/**
 * Three places a repo already says who does what, in order of how much it
 * actually means. None is a policy, so all of them are proposals.
 */
export function discover(root) {
  const keyDir = KEY_DIRS.find((d) => isDir(join(root, d))) ?? null;
  const agents = join(root, ".claude", "agents");
  if (existsSync(agents)) {
    const roles = readdirSync(agents)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f.replace(/\.md$/, ""), writes: [], keys: [] }));
    if (roles.length) return { source: ".claude/agents/", roles, agents: roles.length, keyDir };
  }

  for (const p of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const file = join(root, p);
    if (!existsSync(file)) continue;
    const roles = fromCodeowners(readFileSync(file, "utf8"));
    if (roles.length) return { source: p, roles, agents: 0, keyDir };
  }

  const dirs = codeDirs(root);
  return {
    source: dirs.length
      ? "the top-level folders that hold code — one role each"
      : "nothing to read — this is a blank start",
    roles: dirs.length
      ? dirs.map((d) => ({ name: roleName(d), writes: [`${d}/**`], keys: [] }))
      : [{ name: "agent", writes: [], keys: [] }],
    agents: 0,
    keyDir,
  };
}

/** Where a repo keeps its keys by convention, in the order they are looked for. */
const KEY_DIRS = [".secrets", "secrets", ".keys"];

/**
 * One role per owner, with every path that owner has.
 *
 * It was one role per LINE, named after the path, and cut at eight — so a
 * team's ownership came back as eight roles called `apps-web`, `apps-api`… with
 * the rest dropped and nothing said. An owner is the thing a role stands for.
 * A line's first owner takes it: CODEOWNERS lets several share a path, and
 * seisin would rather print one proposal a person corrects than invent an
 * overlap. `*` is skipped — it is the fallback owner, not a territory.
 */
export function fromCodeowners(text) {
  const byOwner = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const [glob, owner] = raw.replace(/#.*$/, "").trim().split(/\s+/);
    if (!glob || glob === "*" || !owner) continue;
    // CODEOWNERS anchors a leading "/" at the repo root; seisin's writes
    // are already repo-relative, so a literal "/apps/**" would ask the
    // kernel for the machine's /apps and make `explain` (which reads it as
    // outside the repo) disagree with what the profile grants. Strip the
    // anchor. A trailing "/" means a directory, so it becomes "/**".
    const rel = glob.replace(/^\/+/, "");
    const path = rel.endsWith("/") ? rel + "**" : rel;
    const name = roleName(owner.replace(/^@/, "").replace(/^.*\//, "")) || `role-${byOwner.size + 1}`;
    const role = byOwner.get(name) ?? byOwner.set(name, { name, writes: [], keys: [] }).get(name);
    if (!role.writes.includes(path)) role.writes.push(path);
  }
  return [...byOwner.values()];
}

const roleName = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The top-level folders that hold code, for a repo that says nothing else.
 *
 * It proposed `src/web/**` and `src/api/**` whatever the repo looked like, so
 * the first `check` was about folders that did not exist. Kept simple on
 * purpose: a folder counts when some file under it (a few levels down) has a
 * source extension. Dot-folders, dependencies and build output are skipped,
 * and a folder of only documents or images proposes nothing — it is somebody's
 * territory, but not the first thing a person wants to decide.
 */
const CODE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|sql|vue|svelte|astro|dart|scala|ex|exs|lua|pl|r|m|html|css|scss)$/i;
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "coverage", "__pycache__", "venv"]);

function codeDirs(root) {
  let top;
  try { top = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return top
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name) && roleName(e.name))
    .map((e) => e.name)
    .filter((d) => holdsCode(join(root, d), 4))
    .sort();
}

function holdsCode(dir, depth) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  if (entries.some((e) => e.isFile() && CODE.test(e.name))) return true;
  if (depth <= 1) return false;
  return entries.some((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name) && holdsCode(join(dir, e.name), depth - 1));
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** The proposed config, as TOML. Pure: takes what `discover` found. */
export function renderConfig(found) {
  const lines = [
    "# seisin — which folders each agent writes, and which keys it may read.",
    "#",
    `# Proposed from: ${found.source}`,
    "# Nothing here is enforced until you run the agent through `seisin run`.",
    "# Anything not listed is denied. There is no permissive default.",
    "#",
    "# Each role runs as its own process:  seisin run <role> -- <agent>",
    "# A Claude Code subagent runs inside its parent's process, so it has its",
    "# parent's role — give it its own by running it as its own `seisin run`.",
    "",
    "# [runtime]",
    '# read = "territory"   # opt-in: keep data roots shut; roles declare reads/toolchain/verify',
    "",
    ...(found.keyDir
      ? ["[keys]", `dir = ${tomlString(found.keyDir)}      # every key lives here; roles name the files they may read`]
      : ["# [keys]", '# dir = ".secrets"      # every key lives here; roles name the files they may read']),
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
    if (!r.writes.length) lines.push("# writes nothing yet: add the folders this role owns, e.g. \"app/**\"");
    lines.push(`[roles.${tomlName(r.name)}]`);
    lines.push(`writes = [${r.writes.map(tomlString).join(", ")}]`);
    lines.push(`keys   = [${r.keys.map(tomlString).join(", ")}]`);
    lines.push('# reads = ["path/**"]       # data outside the repo this role must read');
    lines.push('# toolchain = ["~/.venvs/app"] # stack under a home or another data root');
    lines.push('# verify = ["npm", "test"]  # seisin check --verify runs this inside the role');
    lines.push("");
  }
  return lines.join("\n");
}

/** A proposal that adds observed permissions to the current policy text. */
export function renderObserved(config, entries, text = readFileSync(config.path, "utf8")) {
  // Start from the policy being proposed for promotion. Rebuilding writes and
  // keys alone discarded isolate, never_writes, providers, per-role network,
  // MCP and every other setting, including those of roles that did not act.
  config = loadConfig(config.path, text);
  const roles = observed(entries);
  let toml = text;
  const notes = [];
  for (const name of Object.keys(config.roles)) {
    const seen = roles.get(name);
    if (!seen) {
      notes.push(`# ${name}: this role did nothing while observing — kept as written`);
      continue;
    }
    // A host path is not a repo-relative grant. Unknown roles and outside
    // paths from older logs cannot silently become territory in the proposal.
    const paths = [...seen.writes].map((p) => toRepoRelative(config, resolve(config.root, p)))
      .filter((p) => !isAbsolute(p) && p !== ".." && !p.startsWith("../"));
    const additions = [
      ...generalise(paths).map((grant) => ({ action: "write", grant })),
      ...[...seen.keys].map((target) => ({ action: "read", grant: keyName(config, target) })),
    ];
    let added = 0;
    for (const request of additions) {
      const field = request.action === "read" ? "keys" : "writes";
      // A valid role can omit either list. Insert only a missing list and
      // retry the same grant; existing values and comments stay untouched.
      let result;
      try {
        result = applyGrant(toml, { ...request, role: name, times: 1 }, "observation proposal");
      } catch (e) {
        if (!e.message.includes(`has no ${field} list`)) throw e;
        toml = setKey(toml, `roles.${name}`, field, "[]", "", "from observation");
        result = applyGrant(toml, { ...request, role: name, times: 1 }, "observation proposal");
      }
      toml = result.toml;
      if (result.changed) added++;
    }
    notes.push(`# ${name}: observation added ${added}; all other settings kept as written`);
  }
  loadConfig(config.path, toml);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const heading = [
    `# ${CONFIG_NAME} — proposal from ${entries.length} observed action(s).`,
    "# Observation adds territory and keys; read the diff before promoting this file.",
    ...notes, "",
  ].join(eol);
  return { toml: heading + eol + toml, roles: [...roles.keys()].filter((name) => config.roles[name]).length };
}

export function init(cwd = process.cwd(), { force = false } = {}) {
  const target = join(cwd, CONFIG_NAME);
  const had = existsSync(target);
  if (had && !force)
    throw new Error(`${CONFIG_NAME} already exists here. seisin init --force replaces it, keeping the old one as ${CONFIG_NAME}.bak`);

  const found = discover(cwd);
  if (had) copyFileSync(target, target + ".bak");
  writeFileSync(target, renderConfig(found));
  const ignored = ignoreState(cwd);
  out(
    `\n  wrote ${C.b}${CONFIG_NAME}${C.off} with ${found.roles.length} role(s) from ${found.source}\n` +
    (had ? `  ${C.dim}the previous one is ${CONFIG_NAME}.bak${C.off}\n` : "") +
    (found.keyDir ? `  ${C.dim}[keys] dir = "${found.keyDir}" — it is there, so it is declared${C.off}\n` : "") +
    (ignored ? `  ${C.dim}added .seisin/ to .gitignore — the log and the request queue belong to this machine${C.off}\n` : "") +
    `  ${C.dim}These are a proposal, not a policy. Read them before you run anything.${C.off}\n` +
    // Said once, here, where someone with one agent decides whether to go on.
    (found.agents <= 1
      ? `  ${C.dim}one agent? its own sandbox covers most of this. seisin adds a built environment, a key dir no role reads\n` +
        `  unless it is declared, and an owner named on every denial — it earns its setup at two roles.${C.off}\n`
      : "") +
    `\n  next:  seisin check\n\n`
  );
  return found;
}

/**
 * `.seisin/` into the repo's .gitignore, when it has one and it is not there.
 * The state directory is this machine's record; committed, every clone would
 * start with somebody else's log and queue. No .gitignore, nothing written.
 */
function ignoreState(cwd) {
  const file = join(cwd, ".gitignore");
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  if (/^\/?\.seisin\/?\s*$/m.test(text)) return false;
  appendFileSync(file, `${text.endsWith("\n") || !text ? "" : "\n"}.seisin/\n`);
  return true;
}

export function initFromObservations(config) {
  const entries = read(logPath(config.root), { verdict: "observed" });
  if (entries.length === 0)
    throw new Error(
      "nothing observed yet.\n" +
      "  observations come from the hook: run `seisin wire` once, then observe an agent —\n" +
      "    seisin run <role> --observe -- claude      (or codex, …)\n" +
      "  a plain shell command goes through no hook and records nothing. keys stay denied while observing.");

  const { toml, roles } = renderObserved(config, entries);
  const file = join(config.root, CONFIG_NAME + ".observed");
  writeFileSync(file, toml);
  out(
    `\n  wrote ${C.b}${relative(process.cwd(), file)}${C.off} from ${entries.length} observation(s), ${roles} role(s)\n` +
    `  ${C.dim}Not ${CONFIG_NAME} — a policy generated behind your back is not a policy. Diff it, then move it.${C.off}\n\n`
  );
  return { file, entries: entries.length, roles };
}
