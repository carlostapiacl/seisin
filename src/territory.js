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
 * **Denied whole, allowed back.** Each data root is one deny, and what the
 * role keeps is an `allowRead` inside it. A deny covers what is created after
 * it, so another run's directory made beside the repo an hour into this one
 * is shut the moment it exists. That is the point of it.
 *
 * It was carved before — every sibling on the way to a kept path denied by
 * name, which is a photograph: an entry created during the run beside a kept
 * path was not covered, and read (measured, 2026-10-12). Two measured runtime
 * behaviours kept the allow out then, and each is now handled where it bites:
 *
 *   - macOS: an allow is emitted after the denies, and a deny that sits inside
 *     an allow is re-emitted after it whole (last match wins). For the key
 *     directory inside the repo that re-emitted deny also shuts the key files
 *     `[keys]` re-allows inside it. A deny spelt as a pattern is re-emitted
 *     MINUS the allows inside it, so those denies are spelt as one
 *     (outlastAllows, below).
 *   - Linux: the runtime restores the write mounts a deny wiped and then the
 *     read allows, read-only, on top of them — so a repo allowed back covers
 *     the territory inside it and every write fails with "Read-only file
 *     system" (srt 0.0.75/0.0.78). A kept path that holds a write path is
 *     allowed back piece by piece around it (territoryReads, below).
 *
 * **What that costs, said where it is decided.** On Linux, inside a kept
 * directory that is on the way to a write path, an entry created during the
 * run is not there for the role until the next run: it fails closed, it does
 * not leak. On both, the names of what the role keeps are visible where the
 * runtime has to show them (a Linux `ls ~` lists the mount points), and
 * nothing else in a data root is.
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
 * The most entries one directory may have where a kept path is allowed back
 * piece by piece (Linux, around a write path).
 *
 * Every piece is one allow, and one mount. The carving this replaced hit the
 * same wall from the other side: a repo kept inside a Mac's TMPDIR, 9,105
 * entries, made 9,163 denies, 815 KB of profile, and `spawn E2BIG` — no
 * agent, and no reason anyone could read. Past this the answer is a refusal
 * that names the directory, not a sandbox that cannot start.
 */
export const MAX_CARVE = 1000;

/** What the runtime treats as glob syntax in a path (sandbox-utils containsGlobChars). */
const GLOB = /[[\]*?]/;

const under = (p, dir) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");
const inside = (p, dir) => p !== dir && under(p, dir);

/**
 * The read rules that leave exactly `keep` readable inside `roots`:
 * `{ deny, allow }`, for denyRead and allowRead.
 *
 * Each root is denied whole, unless something kept covers it. Each kept path
 * under a root is allowed back, in both spellings. On Linux a kept path that
 * holds one of `writes` is not allowed back itself — its read mount would
 * land on the write mount inside it — but walked toward the writes, and every
 * child not on the way is allowed instead; the writes come back writable
 * through the runtime's own restore. Nothing is denied by name, so nothing
 * created later escapes the deny.
 *
 * Nothing at or under `denied` — the key directories, other roles' private
 * folders, the credential homes — is allowed back: an allow there would win
 * over the deny on macOS, and on Linux the deny's own mount restores it.
 *
 * `fs` is injectable for tests; it needs `readdir(dir) -> names`,
 * `kind(path) -> "dir" | "link" | "other" | null` and `real(path) -> path`.
 */
export function territoryReads(roots, keep, { writes = [], denied = [], platform = process.platform, fs = realFs } = {}) {
  // realAncestor, not realOrSelf: a territory not created yet still has to
  // be spelt the way the kernel will meet it (`/tmp/x` is `/private/tmp/x`).
  // Both spellings of each: where it resolves, and where its NAME lives (the
  // directories above resolved, the last component as written). A kept
  // symlink — `~/.local/bin/claude` — has to be reachable by name for a PATH
  // lookup to find it, and by target for the read to land.
  const nameOf = (k) => { const d = k.slice(0, k.lastIndexOf("/")) || "/"; const r = fs.real(d); return `${r === "/" ? "" : r}/${k.slice(k.lastIndexOf("/") + 1)}`; };
  const no = [...new Set(denied.map(fs.real))];
  const open = (p) => !no.some((d) => under(p, d));
  const kept = [...new Set(keep.flatMap((k) => [fs.real(k), nameOf(k)]))].filter(open);
  // Nested roots (`/private/var/folders/…/T` inside `/private/var/folders`)
  // are covered by the outer deny; one kept whole needs no deny at all.
  const real = [...new Set(roots.map(fs.real))].filter((r) => fs.kind(r) === "dir");
  const deny = real.filter((r) => !real.some((o) => inside(r, o)) && !kept.some((k) => under(r, k)));
  const shut = kept.filter((k) => deny.some((r) => inside(k, r)));
  if (platform !== "linux") return { deny, allow: shut };

  const w = [...new Set(writes.map(fs.real))];
  const allow = [];
  const walk = (dir) => {
    let names;
    try { names = fs.readdir(dir); } catch { return; }      // unreadable: nothing comes back
    if (names.length > MAX_CARVE)
      throw new Error(
        `read = "territory" cannot keep ${dir} readable around what the role writes inside it: it holds ` +
        `${names.length} entries, and on Linux each is one mount (the most it takes is ${MAX_CARVE} per directory).\n` +
        `  Written inside it: ${w.filter((x) => inside(x, dir)).join(", ")}.\n` +
        `  Move the repo to a directory with fewer neighbours, or narrow the reads entry that keeps this path.`);
    for (const name of names.sort()) {
      const child = dir === "/" ? `/${name}` : `${dir}/${name}`;
      if (w.some((x) => under(child, x)) || !open(child)) continue;   // a write, or denied
      if (fs.kind(child) === "dir" && w.some((x) => inside(x, child))) walk(child);
      else allow.push(child);
    }
  };
  for (const k of shut) {
    if (w.some((x) => under(k, x))) continue;                // comes back as a write
    if (w.some((x) => inside(x, k)) && fs.kind(k) === "dir") walk(k);
    else allow.push(k);
  }
  return { deny, allow };
}

/**
 * The denies, respelt so that each keeps its own allows open on macOS.
 *
 * A deny strictly inside an allow is re-emitted after the allows, because the
 * last rule that matches wins and the allow would otherwise re-open it. A
 * deny written as a path comes back whole, and that shuts every allow inside
 * IT — the key files inside the key directory inside the repo. A deny written
 * as a pattern comes back minus each allow its pattern covers (srt 0.0.78,
 * macos-sandbox-utils lateReadDenyFilters). So those denies, and only those,
 * are spelt as a pattern that matches exactly their own path: one character
 * of the last name in brackets, `.secrets` as `.secret[s]`.
 *
 * A path that already holds glob syntax cannot be spelt that way without
 * matching something else, and is refused.
 */
export function outlastAllows(denies, allows, real = (p) => p) {
  const open = allows.map(real);
  return denies.map((written) => {
    const d = real(written);
    if (!open.some((a) => inside(a, d)) || !open.some((a) => inside(d, a))) return written;
    const slash = d.lastIndexOf("/");
    let at = d.length - 1;
    while (at > slash && !/[A-Za-z0-9_-]/.test(d[at])) at--;
    if (GLOB.test(d) || at <= slash)
      throw new Error(
        `read = "territory" cannot keep ${d} shut around what is allowed inside it: its name holds ` +
        `characters the sandbox reads as a pattern, or none it can bracket.\n  Rename it.`);
    return `${d.slice(0, at)}[${d[at]}]${d.slice(at + 1)}`;
  });
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
 * What a role keeps readable: its repo, what it writes, its `reads` and its
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

/** Whether `p` is shut by the mode: under a data root, and under nothing kept. */
export function shutByTerritory(p, keep, roots = dataRoots(), real = realAncestor) {
  const r = real(p);
  const kept = keep.map(real);
  if (!roots.some((root) => under(r, root))) return false;
  return !kept.some((k) => under(r, k));
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

