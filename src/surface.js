/**
 * What the parent trusts, and why no role may write any of it.
 *
 * The sandbox confines the agent. It does not confine the process that decides
 * what the agent gets: `seisin run` reads the policy, runs the key providers,
 * reads `file://` secrets and starts the runtime, all of it outside the box and
 * as you. Every file that process reads or executes is therefore part of the
 * boundary, and a role that can write one of them does not need to escape — it
 * waits for the next run, or for you to type the command yourself.
 *
 * That was fixed one file at a time: the policy, then `.seisin/`, then provider
 * scripts with a path. Each fix was right and each left the next member of the
 * family open. Measured on 2026-09-23 against the real kernel, with the fixes
 * above in place:
 *
 *   - a provider named `fakeprov` resolved through PATH; a role with a PATH
 *     directory in its territory planted its own, and the next run executed it
 *     unsandboxed (a marker file appeared outside every territory);
 *   - a role swapped a `file://` target for a symlink to another role's key,
 *     and the next run read that key and handed it over;
 *   - every role could create files in `~/.local/share/claude/versions/`, where
 *     the Claude Code binary you run outside the box lives, because the shared
 *     runtime scratch includes `~/.local/share`.
 *
 * So this module answers the question once, for the family: **which paths does
 * the parent trust?** Anything on that list that falls inside some role's
 * writable area is denied to every role, and `seisin check` prints the list
 * with the reason for each entry.
 */
import { readdirSync, statSync, accessSync, existsSync, realpathSync, constants } from "node:fs";
import { join, isAbsolute, delimiter, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { writePathsOf, realOrSelf } from "./grants.js";
import { STATE_DIR, CONFIG_NAME } from "./layout.js";

/** seisin's own package: the code the next `seisin run` executes. */
const SEISIN_HOME = realOrSelf(join(dirname(fileURLToPath(import.meta.url)), ".."));

const under = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

/**
 * Every directory some role can write in some run, as real paths.
 *
 * The union over roles, not one role's view: a role that cannot write a
 * provider script can still wait for the role that can. The repo root is in
 * it because `--observe` grants the whole repo to whichever role it runs.
 */
export function writableRoots(config) {
  const root = realOrSelf(config.root);
  const out = new Set([root]);
  // A grant inside the repo is covered by the repo root already, so only the
  // ones outside it are resolved. Resolving all of them was most of the cost:
  // 301 paths for the portfolio's 32 roles, most of them sidecars that do not
  // exist, 200 ms of failed realpath calls to learn nothing.
  for (const role of Object.values(config.roles ?? {}))
    for (const p of writePathsOf(config, role)) {
      if (under(p, config.root)) continue;
      out.add(realOrSelf(p));
    }
  // Nested roots add nothing either: ~/.local/share/x under ~/.local/share.
  const all = [...out];
  return all.filter((r) => !all.some((o) => o !== r && under(r, o)));
}

/**
 * The PATH the parent uses for its own lookups: yours, minus every directory
 * some role can write, minus relative entries.
 *
 * A relative entry (`.`, `bin`, an empty one between two colons) resolves
 * against whatever directory the parent is standing in, which is the repo —
 * the one place every role writes.
 */
export function trustedPath(config, env = process.env, roots = writableRoots(config)) {
  return (env.PATH ?? "").split(delimiter)
    .filter((d) => d && isAbsolute(d) && !roots.some((r) => under(realOrSelf(d), r)));
}

function isExecutable(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a command the parent runs lives, found only where no role can write.
 *
 * A command with a slash is a path, relative to the policy. A bare name is
 * looked up on {@link trustedPath}. When the only match sits in a writable
 * directory the lookup fails and says where it was found: running it would
 * mean running whatever a role last put there, and dropping to the next match
 * silently would run a different program than the one the policy's author
 * tested with.
 */
export function resolveExecutable(cmd, config, env = process.env) {
  if (cmd.includes("/")) return isAbsolute(cmd) ? cmd : resolve(config.root ?? ".", cmd);
  const roots = writableRoots(config);
  for (const dir of trustedPath(config, env, roots)) {
    const candidate = join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  const shadow = (env.PATH ?? "").split(delimiter).filter(Boolean)
    .map((d) => join(isAbsolute(d) ? d : resolve(config.root ?? ".", d), cmd))
    .find(isExecutable);
  throw new Error(
    shadow
      ? `"${cmd}" is only found at ${shadow}, in a directory a role can write.\n` +
        `  seisin runs it outside the sandbox, so it would run whatever a role last put ` +
        `there. Install it outside every territory, or give its absolute path.`
      : `"${cmd}" is not on PATH.`);
}

/** The target of a `file://` key, as written and resolved against the policy. */
function fileRefTargets(config) {
  const out = [];
  for (const role of Object.values(config.roles ?? {})) {
    for (const raw of role.keys ?? []) {
      const m = /^(?:[A-Za-z_][A-Za-z0-9_]*=)?file:\/\/(.+)$/.exec(raw);
      if (!m) continue;
      const hash = m[1].lastIndexOf("#");
      const path = hash === -1 ? m[1] : m[1].slice(0, hash);
      out.push({ path: isAbsolute(path) ? path : resolve(config.root, path), raw });
    }
  }
  return out;
}

/**
 * Where a program lives, as the directory to protect.
 *
 * The package, not the binary alone: a Python tool installed by uv runs
 * `~/.local/share/uv/tools/ruff/bin/ruff`, and the code it executes is the rest
 * of that tree. So the walk goes up from the binary to the first directory
 * that looks like the root of an installation — one holding a `package.json`
 * or a `pyvenv.cfg`, or the parent of a `bin/` — and stops at the writable
 * root. With nothing recognisable on the way, the binary's own directory.
 *
 * The first version protected the top-level entry under the writable root
 * instead, and on the portfolio that was `01-activos/`: every project, denied
 * to every role, because seisin itself lives in one of them.
 */
function packageRoot(p, root) {
  let dir = dirname(p);
  while (under(dir, root) && dir !== root) {
    if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "pyvenv.cfg"))) return dir;
    if (basename(dir) === "bin") return dirname(dir);
    dir = dirname(dir);
  }
  return dirname(p) === root ? p : dirname(p);
}

/**
 * Programs that run outside the box and live where a role can write.
 *
 * Two ways in. A PATH directory inside a writable area: anything a role drops
 * there shadows a real command the next time anybody types it. And a PATH
 * entry that is a symlink into a writable area — `~/.local/bin/claude` points
 * at `~/.local/share/claude/versions/…`, and that directory was writable by
 * every role through the shared runtime scratch.
 *
 * Only symlinks are followed. A regular file in a directory no role writes is
 * already out of reach; the cost is then one `readdir` per PATH entry and one
 * `realpath` per link.
 */
const SURFACES = new WeakMap();          // config -> PATH -> entries

export function executionSurface(config, env = process.env, roots = null) {
  // Once per config and PATH: `check` asks for every role's denies, and the
  // PATH scan is the same answer 32 times on the portfolio.
  const byPath = SURFACES.get(config) ?? SURFACES.set(config, new Map()).get(config);
  const key = env.PATH ?? "";
  if (!roots && byPath.has(key)) return byPath.get(key);
  const result = scanSurface(config, env, roots ?? writableRoots(config));
  if (!roots) byPath.set(key, result);
  return result;
}

function scanSurface(config, env, roots) {
  const out = [];
  const inWritable = (p) => roots.find((r) => under(p, r));
  // Deduplicated: the PATH a shell hands down repeats itself (33 entries, 21
  // distinct, on the machine this was measured on), and each repeat is a
  // directory listing and its links resolved again.
  for (const dir of new Set((env.PATH ?? "").split(delimiter))) {
    if (!dir || !isAbsolute(dir)) continue;
    const real = realOrSelf(dir);
    if (inWritable(real)) {
      out.push({ path: real, why: `on PATH (${dir}): a role could shadow any command there` });
      continue;
    }
    let entries;
    try { entries = readdirSync(real, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isSymbolicLink()) continue;
      // `.native`: one realpath(3) call. The JS implementation lstats every
      // component, and /usr/local/bin alone holds hundreds of links.
      let target;
      try { target = realpathSync.native(join(real, e.name)); } catch { continue; }
      const root = inWritable(target);
      if (root) out.push({ path: packageRoot(target, root), why: `${join(dir, e.name)} runs from here` });
    }
  }
  // What the next `seisin run` itself executes: node, seisin, the runtime.
  // Found in a writable place when node comes from a version manager that
  // installs under ~/.local/share (fnm), or seisin is a devDependency of the
  // repo it governs.
  for (const [p, why] of [
    [process.execPath, "the node that runs seisin"],
    [SEISIN_HOME, "seisin itself"],
  ]) {
    const real = realOrSelf(p);
    const root = inWritable(real);
    if (root) out.push({ path: real === SEISIN_HOME ? real : packageRoot(real, root), why });
  }
  return dedupe(out);
}

/** One entry per path; the first reason given wins. */
function dedupe(entries) {
  const seen = new Map();
  for (const e of entries) if (!seen.has(e.path)) seen.set(e.path, e);
  return [...seen.values()];
}

/**
 * Everything the parent reads or executes, named by the policy, with the reason.
 *
 * Denied to every role whatever its territory, the way `seisin.toml` always
 * was: these are cheap to list and a role that can write one of them has no
 * policy.
 */
export function parentInputs(config, { env = process.env } = {}) {
  const abs = (p) => (isAbsolute(p) ? p : join(config.root, p));
  const out = [
    { path: abs(config.path ?? CONFIG_NAME), why: "the policy" },
    { path: abs(STATE_DIR), why: "seisin's log and request queue" },
    ...(config.keyDirs ?? []).map((d) => ({ path: abs(d), why: "a key directory" })),
  ];
  for (const [scheme, p] of Object.entries(config.keyProviders ?? {})) {
    const cmd = p.command?.[0];
    if (!cmd) continue;
    let path;
    // A provider that does not resolve here is not denied here: the run that
    // needs it fails at resolution, with the message resolveExecutable gives.
    try { path = resolveExecutable(cmd, config, env); } catch { continue; }
    out.push({ path, why: `the ${scheme}:// key provider, run outside the box` });
  }
  for (const { path, raw } of fileRefTargets(config))
    out.push({ path, why: `read by the parent for key "${raw}"` });

  // Both spellings of every entry: the one written, and the one the kernel
  // meets when a symlink sits on the way. A deny on the written path alone let
  // writes through once already (never_writes, 2026-09-22).
  return out.flatMap((e) => {
    const real = realOrSelf(e.path);
    return real === e.path ? [e] : [e, { ...e, path: real }];
  });
}

/**
 * Files that tell a program running outside the box what to execute.
 *
 * Git runs `.git/hooks/*` and whatever `.git/config` names (core.hooksPath,
 * core.fsmonitor). Claude Code runs the hooks, plugins and skills its settings
 * declare, and the MCP servers in `.mcp.json`. direnv runs `.envrc` on `cd`.
 * Codex starts what `config.toml` lists. A role that writes one of these does
 * not escape the box; it leaves a command for you to run the next time you
 * open that project — measured on 2026-09-23: every role could open
 * `~/.claude/settings.json` for writing through the shared runtime scratch.
 *
 * The runtime already covers part of this with patterns (`**\/.git/hooks/**`,
 * `**\/.mcp.json`, `**\/.claude/commands`). Literal paths hold more than
 * patterns do — the runtime also protects each literal path's ancestors — so
 * every control file of every project inside a role's territory is named
 * literally, and the patterns stay as a second layer.
 */
export const CONTROL_FILES = [
  ".git/hooks", ".git/config",
  ".claude/settings.json", ".claude/settings.local.json",
  ".claude/hooks", ".claude/plugins", ".claude/skills", ".claude/commands", ".claude/agents",
  ".mcp.json", ".envrc", ".codex/config.toml",
];

const RUNNER = (f) =>
  f.startsWith(".git/") ? "git" : f === ".envrc" ? "direnv" : f.startsWith(".codex/") ? "Codex" : "Claude Code";

// Case-insensitive, because the disk is: on APFS `.CLAUDE/Settings.json` is
// the same file, and the kernel was measured refusing it.
const CONTROL_RE = new RegExp(
  `(^|/)(${CONTROL_FILES.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(/|$)`, "i");

/** Does this path name a control file, at any depth? What `explain` asks. */
export const isControlPath = (p) => CONTROL_RE.test(p);

/** Where no control file is looked for: dependencies and build output. */
const PRUNE = new Set(["node_modules", ".git", "vendor", "dist", "build", ".venv", "venv",
  "__pycache__", ".next", "target", ".turbo", ".cache", "Pods", ".gradle", ".dart_tool"]);

/** A directory holding one of these is where somebody opens a project. */
const MARKERS = new Set([".git", ".claude", ".mcp.json", ".envrc", ".codex"]);

/**
 * How deep under a territory to look for projects.
 *
 * Measured on the portfolio over every territory at once: depth 3 finds 128
 * project roots reading 2.6k directories (~0.4 s under load); depth 4 finds
 * 130 reading 5.5k (0.9 s); depth 6, 132 and 2.1 s. The four below depth 3
 * are `.claude` folders agents left inside source trees (`features/…`,
 * `tests/Feature/Api`), not projects anybody opens — and on macOS the pattern
 * layer still refuses writing into them. The whole portfolio at depth 8 is
 * 23k directories, which is why the walk is per role and never over the repo.
 */
const SCAN_DEPTH = 3;

function projectRoots(dir, depth = SCAN_DEPTH) {
  const out = [];
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, level] = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    if (level === 0 || entries.some((e) => MARKERS.has(e.name))) out.push(d);
    if (level >= depth) continue;
    for (const e of entries)
      if (e.isDirectory() && !e.isSymbolicLink() && !PRUNE.has(e.name)) stack.push([join(d, e.name), level + 1]);
  }
  return out;
}

/**
 * The control files of one project directory, as literal paths.
 *
 * On Linux only the ones that exist: bubblewrap denies a path by mounting over
 * it, and to do that for a path that is not there it creates it on the host
 * (never_writes has the measurement). A `.git` that is a file is a worktree
 * pointing at its repository, and the pointer is what gets protected.
 */
function controlsOf(dir, platform) {
  const out = [];
  let git = null;
  try { git = statSync(join(dir, ".git")); } catch {}
  if (git?.isFile()) out.push({ path: join(dir, ".git"), why: "a worktree's pointer to its repository, read by git" });
  if (git?.isDirectory())
    for (const f of [".git/hooks", ".git/config"])
      out.push({ path: join(dir, f), why: `${f}, run by git outside the box` });
  /**
   * `.claude` whole, as one entry, rather than its seven control files.
   *
   * Every literal path costs sandbox start-up — the runtime adds a rule for
   * each of its ancestors. Measured with one real role's profile: 50 literals
   * started in ~1.9 s like none at all, 150 in ~2.3 s, 400 in 4.8–7.7 s. One
   * entry for the directory covers every file in it, its ancestors, and
   * creating it where it did not exist. The cost is
   * that a role cannot write a project's `.claude/` at all, which is the
   * directory Claude Code reads its instructions to itself from.
   */
  if (platform !== "linux" || existsSync(join(dir, ".claude")))
    out.push({ path: join(dir, ".claude"), why: ".claude, whose settings, hooks and skills Claude Code runs outside the box" });
  // The single files only where they exist: where they do not, the patterns
  // refuse creating them, and a literal each would be start-up for nothing.
  for (const f of [".mcp.json", ".envrc", ".codex/config.toml"]) {
    const p = join(dir, f);
    if (existsSync(p)) out.push({ path: p, why: `${f}, run by ${RUNNER(f)} outside the box` });
  }
  return out;
}

/**
 * The home's control files, one by one — never `~/.claude` whole.
 *
 * That directory is also where Claude Code keeps its sessions, todos and
 * history, and it writes them from inside the box on every turn. Denying the
 * directory would stop the agent; denying what it executes does not (checked
 * with `claude -p` under the new profile: it answered, and what it was refused
 * were lock and cache files under plugins/, which it tolerates).
 */
function homeControls(platform) {
  const home = homedir();
  return [
    ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks", ".claude/plugins",
    ".claude/skills", ".claude/commands", ".claude/agents", ".codex/config.toml",
  ]
    .map((f) => ({ path: join(home, f), why: `${f}, run by ${RUNNER(f)} outside the box` }))
    .filter((e) => platform !== "linux" || existsSync(e.path));
}

/**
 * Everything this role's profile must deny beyond its own `never_writes`.
 *
 * Per role, and that is not only a saving. The kernel profile is one role's,
 * so the only protected paths that matter in it are the ones inside what that
 * role can write; a provider script in `backend`'s territory is already out of
 * `frontend`'s reach. The union over roles (writableRoots) is for the other
 * question — which directories the parent may trust at all.
 */
const DENIES = new WeakMap();            // config -> key -> entries
const ROOTS = new WeakMap();             // config -> dir -> project roots under it

export function denyFor(config, role, { env = process.env, platform = process.platform, observe = false } = {}) {
  // Memoised per config: `check` builds every role's settings and then asks
  // for the same list again to show it; on the portfolio that was 2.6 s twice.
  const memo = DENIES.get(config) ?? DENIES.set(config, new Map()).get(config);
  const key = `${role.name}\0${observe}\0${platform}\0${env.PATH ?? ""}`;
  if (memo.has(key)) return memo.get(key);
  const result = computeDenies(config, role, { env, platform, observe });
  memo.set(key, result);
  return result;
}

/** Project roots under `dir`, once per config: roles share directories. */
function rootsUnder(config, dir) {
  const memo = ROOTS.get(config) ?? ROOTS.set(config, new Map()).get(config);
  if (!memo.has(dir)) memo.set(dir, projectRoots(dir));
  return memo.get(dir);
}

function computeDenies(config, role, { env, platform, observe }) {
  const mine = writePathsOf(config, role, { observe });
  const minePaths = [...new Set(mine.flatMap((p) => [p, realOrSelf(p)]))];
  const inMine = (p) => minePaths.some((w) => under(p, w));

  const surface = executionSurface(config, env).filter((e) => inMine(e.path));

  const dirs = mine.filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const repoDirs = dirs.filter((p) => under(p, config.root));
  const controls = repoDirs.flatMap((d) => rootsUnder(config, d)).flatMap((d) => controlsOf(d, platform));
  // The home is a project too, for Claude Code and Codex: ~/.claude/settings.json
  // is read by every session. Not walked — only its own control files.
  if (["~/.claude", "~/.codex"].some((h) => inMine(join(homedir(), h.slice(2)))))
    controls.push(...homeControls(platform));

  /**
   * Patterns, macOS only (bubblewrap does not take them), and anchored to this
   * role's own directories so that `.claude` means a project's and never the
   * home's, where Claude Code keeps its sessions.
   *
   * Anchored patterns cost nothing at start-up (measured with 24: the same as
   * none) and cover what the literals cannot: a `.claude` deeper than the walk,
   * or one a role creates where there was none. The home's
   * files stay literal (homeControls).
   */
  const globs = platform === "darwin"
    ? repoDirs.flatMap((d) => [
        `${d}/**/.claude`, `${d}/**/.claude/**`,
        `${d}/**/.git/hooks/**`, `${d}/**/.git/config`,
        `${d}/**/.mcp.json`, `${d}/**/.envrc`, `${d}/**/.codex/config.toml`,
      ]).map((path) => ({ path, why: "any project's control files in this territory, by pattern" }))
    : [];

  // The policy, `.seisin/` and the key directories are denied whatever the
  // territory, as they always were. What the providers and `file://` keys
  // point at is denied where this role can write it: `/usr/bin/security` in
  // every profile would be a rule about the machine, and no role reaches it.
  const always = new Set(["the policy", "seisin's log and request queue", "a key directory"]);
  const inputs = parentInputs(config, { env }).filter((e) => always.has(e.why) || inMine(e.path));

  return dedupe([...inputs, ...surface, ...controls, ...globs]);
}

/**
 * The protection covering a repo-relative path, or null — what `explain` asks.
 *
 * So the sentence and the kernel agree: a request to write `seisin.toml` used
 * to be filed as "belongs to dev" for a role with `writes = ["**"]`, and
 * granting it would have granted nothing.
 */
export function protectedBy(config, target, { platform = process.platform } = {}) {
  /**
   * A project's `.claude/`, any file in it, and the other control files — the
   * same rule the kernel is given. On Linux the kernel only holds the ones
   * that exist, so only those are called protected there: a sentence stricter
   * than the boundary is the direction this project refuses.
   */
  const f = /(^|\/)\.claude(\/|$)/i.test(target)
    ? ".claude"
    : CONTROL_FILES.find((c) => new RegExp(`(^|/)${c.replace(/\./g, "\\.")}(/|$)`, "i").test(target));
  if (f && (platform !== "linux" || existsSync(isAbsolute(target) ? target : join(config.root, target)))) {
    const why = f === ".claude"
      ? ".claude, whose settings, hooks and skills Claude Code runs outside the box"
      : `${f}, run by ${RUNNER(f)} outside the box`;
    return { path: target, why };
  }
  const full = realOrSelf(isAbsolute(target) ? target : join(config.root, target));
  return parentInputs(config)
    .find((e) => under(full, realOrSelf(e.path)) || under(join(config.root, target), e.path)) ?? null;
}

/**
 * What `seisin check` shows: every protection that takes something away from a
 * role — a path inside its territory that it will not be able to write — with
 * the reason and the roles it applies to.
 *
 * The policy, `.seisin/` and the key directories are left out: they have been
 * closed to every role since the first release and saying so on every check
 * is noise. Patterns are left out too; they are a second layer, listed in
 * surface.js.
 */
export function protections(config, roles = Object.values(config.roles), opts = {}) {
  const always = new Set(["the policy", "seisin's log and request queue", "a key directory"]);
  const byPath = new Map();
  for (const role of roles) {
    let entries;
    try { entries = denyFor(config, role, opts); } catch { continue; }
    for (const e of entries) {
      if (always.has(e.why) || e.path.includes("*")) continue;
      // Only what the role could otherwise write: a literal control-file path
      // is listed for every project in the territory whether it exists or not,
      // and the ones that do not exist are shown only if their project does.
      const hit = byPath.get(e.path) ?? byPath.set(e.path, { path: e.path, why: e.why, roles: [] }).get(e.path);
      hit.roles.push(role.name);
    }
  }
  return [...byPath.values()].filter((e) => existsSync(e.path) || !e.why.includes(" run by "));
}
