/**
 * `[runtime] read = "territory"`: reading denied where people keep their data,
 * re-opened only along the paths a role needs.
 *
 * The default read model is a list of what not to read — key directories, the
 * places credentials live, other agents' sign-in. It holds for agents you run
 * yourself. Against one you would not trust it loses by one every time a new
 * product leaves a folder of its own: measured on 2026-10-06 by an orchestrator that evaluates agents,
 * a role confined that way could still list `~/.claude`, list the whole
 * project tree of the person running it, and `cat` an evaluation check kept
 * outside its worktree. None of the three was a credential, so none was on
 * the list.
 *
 * So this mode turns the list around, but not all the way. Denying `/` and
 * allowing back is the read allowlist decisions.md rejected, for a reason that
 * still holds: every interpreter, library and cache a toolchain touches would
 * have to be named. The data roots are what gets denied — homes, temp
 * directories, mounted volumes — and the system stays readable, because there
 * is nobody's data in `/usr`. What a role needs from inside a data root is
 * finite and known before it starts: its repo, its territory, its run, its
 * toolchain. That list is the short one, and it is the one written.
 *
 * **Carved, not allowed back.** The runtime offers `allowRead` inside a
 * `denyRead`, and this does not use it, for two measured reasons:
 *
 *   - macOS: a deny nested inside an allow is re-emitted after it (last match
 *     wins), so allowing the repo would shut the key files `[keys]` re-allows
 *     inside their own directory. The key grant would stop working the moment
 *     the mode was turned on.
 *   - Linux: the runtime mounts `allowRead` read-only AFTER the writable
 *     mounts, so a repo in `allowRead` covers the role's own territory and
 *     every write fails with "Read-only file system" (measured, srt 0.0.75/0.0.78).
 *
 * Instead each data root is walked down toward what is kept, and every
 * sibling on the way is denied. Deny-only, so it composes with every allow
 * seisin already emits, on both platforms the same way.
 *
 * **What that costs, said where it is decided.** It is a photograph: an entry
 * created during the run beside a kept path is not covered. And the
 * NAMES along the path stay listable — a role inside `~/work/repo` can `ls
 * ~/work` and see what is there, though it can open none of it. Secrets that
 * must stay shut belong in roots that hold no territory, where they are denied
 * whole.
 */
import { readdirSync, lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { realOrSelf, writePathsOf, expand } from "./grants.js";
import { realAncestor } from "./paths.js";

export const READ_MODES = ["all", "territory"];

/** Files an agent reads at start that live outside its home directory. */
export const AGENT_FILES = { claude: ["~/.claude.json"], codex: [] };

/**
 * Where data lives, per platform. Whole roots: what is under them belongs to
 * somebody. `/opt/homebrew/var` and `/usr/local/var` hold the databases a
 * package manager runs (Postgres, Redis); the rest of `/opt/homebrew` is the
 * toolchain and stays readable.
 */
export const DATA_ROOTS = {
  darwin: [
    "/Users", "/private/tmp", "/private/var/folders", "/private/var/root", "/Volumes",
    "/opt/homebrew/var", "/usr/local/var", "/Library/Keychains",
  ],
  linux: [
    "/home", "/root", "/tmp", "/var/tmp", "/mnt", "/media", "/srv", "/run/user",
    "/run/secrets", "/var/lib/docker",
  ],
};

/** The data roots of this machine: the platform's, plus HOME and TMPDIR wherever they are. */
export function dataRoots(platform = process.platform, home = homedir(), tmp = tmpdir(), real = realOrSelf) {
  const base = DATA_ROOTS[platform] ?? DATA_ROOTS.linux;
  return [...new Set([...base, home, tmp].map(real))];
}

/**
 * The most entries one directory on the way may have.
 *
 * Every sibling is one deny, and the runtime hands the whole profile to
 * `sandbox-exec` as an argument. Measured: a repo kept inside a Mac's TMPDIR,
 * 9,105 entries, made 9,163 denies, 815 KB of profile, and `spawn E2BIG` —
 * no agent, and before the canary existed, no reason anyone could read. A repo
 * under a home is a few hundred (measured: ~230 for a repo four levels down). Past this the answer is
 * a refusal that names the directory, not a profile that cannot start.
 */
export const MAX_CARVE = 1000;

const under = (p, dir) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");

/**
 * The read denies that leave exactly `keep` readable inside `roots`.
 *
 * A root with nothing kept under it is denied whole. A root with something
 * kept is listed, and each child that is not on the way to a kept path is
 * denied; the children that are, are walked the same way. A kept path is
 * readable whole, so nothing below it is visited.
 *
 * Symlinks among the children are left alone rather than denied: the sandbox
 * enforces on the destination, so denying `~/link -> ~/work/repo` would deny
 * the repo itself. A link into a denied place is denied there; a link into a
 * kept one is meant to be read.
 *
 * `fs` is injectable for tests; it needs `readdir(dir) -> names`,
 * `kind(path) -> "dir" | "link" | "other" | null` and `real(path) -> path`.
 */
export function carveDenies(roots, keep, fs = realFs) {
  // realAncestor, not realOrSelf: a territory not created yet still has to
  // be spelt the way the kernel will meet it (`/tmp/x` is `/private/tmp/x`).
  // Both spellings of each: where it resolves, and where its NAME lives (the
  // directories above resolved, the last component as written). A kept
  // symlink — `~/.local/bin/claude` — has to be reachable by name for a PATH
  // lookup to find it, and by target for the read to land.
  const nameOf = (k) => { const d = k.slice(0, k.lastIndexOf("/")) || "/"; const r = fs.real(d); return `${r === "/" ? "" : r}/${k.slice(k.lastIndexOf("/") + 1)}`; };
  const kept = [...new Set(keep.flatMap((k) => [fs.real(k), nameOf(k)]))];
  const out = [];
  const walk = (dir) => {
    if (kept.some((k) => under(dir, k))) return;          // kept whole
    if (!kept.some((k) => under(k, dir))) { out.push(dir); return; }
    let names;
    try { names = fs.readdir(dir); } catch { out.push(dir); return; }   // unreadable: shut it
    if (names.length > MAX_CARVE)
      throw new Error(
        `read = "territory" cannot carve ${dir}: it holds ${names.length} entries, and each would be one ` +
        `deny in the sandbox profile (the most it takes is ${MAX_CARVE} per directory).\n` +
        `  Something the role keeps is inside it: ${kept.filter((k) => under(k, dir)).join(", ")}.\n` +
        `  Move the repo to a directory with fewer neighbours, or narrow the reads entry that keeps this path.`);
    for (const name of names.sort()) {
      const child = dir === "/" ? `/${name}` : `${dir}/${name}`;
      const kind = fs.kind(child);
      if (kind === "link" || kind === null) continue;
      if (kind === "dir") walk(child);
      else if (!kept.some((k) => under(child, k))) out.push(child);
    }
  };
  // Nested roots (`/private/var/folders/…/T` inside `/private/var/folders`)
  // would be walked twice; the outer walk already covers the inner one.
  const real = [...new Set(roots.map(fs.real))].filter((r) => fs.kind(r) === "dir");
  for (const r of real.filter((r) => !real.some((o) => o !== r && under(r, o)))) walk(r);
  return out;
}

const realFs = {
  real: realAncestor,
  readdir: (d) => readdirSync(d),
  kind: (p) => {
    try {
      const s = lstatSync(p);
      return s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : "other";
    } catch { return null; }
  },
};

/**
 * What a role is carved toward: its repo, what it writes, its `reads` and its
 * `toolchain`. One answer for the settings and for `check`, so the warning
 * about an unreadable PATH entry and the kernel agree.
 */
export function keptFor(config, role, { observe = false, agent, program } = {}) {
  return [
    config.root,
    // The program the run starts, and where its link points: without it there
    // is no run. Measured: `claude` installs as ~/.local/bin/claude ->
    // ~/.local/share/claude/versions/<v>, and the run died on `env: claude: No
    // such file or directory`. The file, not its directory — the rest of
    // ~/.local/bin stays shut.
    ...(program ? [program, realOrSelf(program)] : []),
    // The agent's own files that are not under its home directory. Its home
    // (~/.claude) is scratch and kept with the writes; ~/.claude.json, its
    // settings and session index, sits beside it, and without it Claude Code
    // starts and says "Not logged in" (measured, 2026-10-09). A run of no
    // agent, or of another, does not get it.
    ...(agent ? (AGENT_FILES[agent] ?? []).map(expand) : []),
    ...writePathsOf(config, role, { observe, agent }),
    ...(role.reads ?? []).map((p) => readPath(config.root, p)),
    ...(role.toolchain ?? []).map((p) => readPath(config.root, p)),
  ];
}

/** Whether `p` is shut by the carving: under a data root, and on the way to nothing kept. */
export function shutByTerritory(p, keep, roots = dataRoots(), real = realAncestor) {
  const r = real(p);
  const kept = keep.map(real);
  if (!roots.some((root) => under(r, root))) return false;
  return !kept.some((k) => under(r, k) || under(k, r));
}

/**
 * The `bin` directory of each toolchain entry that has one, for the front of
 * PATH. A venv, `~/.cargo`, a node install all keep their programs there;
 * declaring the toolchain and then finding `python` resolves to another one
 * would be a second way of not having it.
 */
export function toolchainBins(config, role, isDir) {
  return (role.toolchain ?? []).map((p) => readPath(config.root, p))
    .flatMap((p) => [p.endsWith("/bin") ? p : `${p}/bin`].filter(isDir));
}

/** `~` and relative spellings of a read entry, absolute. Missing paths are kept as written. */
export function readPath(root, p) {
  const trimmed = p.replace(/\/\*\*$/, "") || ".";
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return `${homedir()}/${trimmed.slice(2)}`;
  if (trimmed.startsWith("/")) return trimmed;
  return `${root}/${trimmed}`.replace(/\/\.$/, "");
}

