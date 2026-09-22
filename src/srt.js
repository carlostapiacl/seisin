/**
 * Turns one role into a settings file for @anthropic-ai/sandbox-runtime.
 *
 * The schema is not guessed: it was read off the installed package and checked
 * against the real binary. Two things it taught us, both load-bearing here:
 *
 *   1. `network` and `filesystem` are top level. They are NOT nested under a
 *      `sandbox` key — that shape belongs to Claude Code's settings.json, which
 *      is a different file with a similar vocabulary. Mixing them up produces a
 *      config that parses as empty and denies everything.
 *   2. Every field is required. Leaving out `network.deniedDomains` or
 *      `filesystem.denyWrite` makes the runtime refuse to start rather than fall
 *      back to its defaults. Emitting the whole object removes that class of
 *      error, which is most of what this file is for.
 */
import { join, dirname } from "node:path";
import { STATE_DIR, CONFIG_NAME } from "./layout.js";
import { homedir, tmpdir } from "node:os";
import { entriesOf } from "./keys.js";
import { realpathSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";

/**
 * What every agent needs to write no matter which role it is.
 *
 * Found by running a real cell config through the sandbox: territory alone
 * looks correct and is unusable. An agent writes its session state under its
 * own config directory and its tools write scratch files to the temp dir, so a
 * policy of "your folders and nothing else" stops the agent before it starts.
 *
 * The list is not Claude-shaped by accident and it was Claude-shaped by
 * mistake: the first version named `~/.claude` and `~/.codex` and stopped
 * there, so the first agent that was neither — opencode, which logs to
 * `~/.local/share/opencode` — died on startup with `FileSystem.open`. Hence the
 * XDG directories, which is where a CLI that follows convention puts its state.
 *
 * `~/.config` is deliberately NOT here. That is where credentials live —
 * `~/.config/gh/hosts.yml` holds a GitHub token — and while reads outside the
 * declared key directories are open anyway, letting an agent WRITE there is a
 * different thing. A CLI that needs it can be granted it by name.
 *
 * These are grants, so they are listed rather than assumed: `seisin check`
 * prints them, and `[runtime] writes = []` turns them off for anyone who wants
 * to find out the hard way. Note what is NOT here — the home directory, the
 * shell profile, anything under the repo. Scratch space is not a back door.
 */
/**
 * Where a role's home and scratch live when `[runtime] isolate = true`.
 *
 * Under the state directory but outside the repo tree the roles write, so one
 * role cannot reach another's. Kept out of `.seisin/` inside the repo because
 * that whole directory is denyWrite now.
 */
/**
 * Short on purpose, and the reason is the same one spool.js already names: a
 * unix socket path is capped near 104 bytes on macOS and the failure when it is
 * too long is an unhelpful EINVAL.
 *
 * This file forgot that one layer down. The runtime creates its multiplexing
 * socket INSIDE the role's home — `<home>/tmp/srt-mux-<pid>-0.sock`, 25 bytes —
 * and the name here used to be `seisin-home-` plus 16 characters. On macOS
 * `tmpdir()` is 48 bytes on its own, so the total cleared 104 for **every role
 * name**, `qa` included: `isolate = true` did not misbehave, it failed to start.
 * Measured, and it is why `homeFits` below exists rather than a comment.
 *
 * Eleven bytes instead of twenty-eight leaves room for a role name up to
 * {@link MAX_ROLE_FOR_HOME} characters.
 */
export function roleHomeRoot(config) {
  /**
   * A hash of the whole path, not a slice of it.
   *
   * This was `base64url(root).slice(-16)` — the TAIL of the encoded path, which
   * is the tail of the path itself. Two checkouts that end the same way get the
   * same id: `/Users/ana/dev/proyecto` and `/Users/bob/dev/proyecto` collide, and
   * so do `/home/a/work/api` and `/home/b/work/api`. A collision here is not a
   * cosmetic clash — both repos' role `dev` would share one HOME, which is the
   * session token of one handed to the other. Measured on three of four ordinary
   * pairs; shortening the slice to fit the socket limit would have made it more
   * likely, not less.
   */
  const id = createHash("sha256").update(config.root).digest("base64url").slice(0, 8);
  return join(tmpdir(), `sn-${id}`);
}

/** What the runtime appends inside the role's home, at its longest. */
const SRT_SOCKET_TAIL = "/tmp/srt-mux-999999-0.sock".length;

/** The platform's cap on a unix socket path. macOS is the tight one. */
const SOCKET_MAX = 104;

/**
 * Whether a role's isolated home leaves room for the runtime's socket.
 *
 * Returns the room left over, negative when it does not fit. Callers refuse
 * rather than let the runtime fail with EINVAL and no explanation — a boundary
 * that cannot start should say so in its own words.
 */
export function homeFits(config, role) {
  return SOCKET_MAX - (roleHome(config, role).length + SRT_SOCKET_TAIL);
}

export function roleHome(config, role) {
  return join(roleHomeRoot(config), role);
}

/**
 * Where credentials live in a home directory, denied at both isolate levels.
 *
 * Denies rather than a read allowlist, and the reasoning is above: a
 * default-deny read set has to enumerate every library, interpreter and cache a
 * toolchain touches, gets one wrong, and fails as an unexplainable crash inside
 * the agent. Naming the places credentials actually live is narrower than the
 * ideal and holds up.
 *
 * `~/.config` is here whole rather than `~/.config/gh`: it is where a growing
 * number of CLIs keep their tokens, and listing them one by one is the
 * enumeration this list exists to avoid. A tool that needs a directory under it
 * can be granted it by name.
 */
export const CREDENTIAL_HOMES = [
  // The order is not arbitrary: `check` names the first few, so the ones a
  // reader recognises instantly go first. Everything in the list is denied
  // either way.
  "~/.ssh", "~/.aws", "~/.npmrc", "~/.config",
  "~/.gnupg", "~/.kube", "~/.docker", "~/.netrc", "~/.git-credentials",
];

export const RUNTIME_WRITES = [
  "~/.claude", "~/.codex",                 // the CLIs that keep state under their own name
  "~/.local/share", "~/.local/state",      // XDG data and state: where most others log
  "~/.cache", "$TMPDIR", "/tmp",
];

/**
 * `~` and `$TMPDIR` are the only expansions; everything else is a literal path.
 *
 * Symlinks are then resolved, and that is not a nicety. On macOS `/tmp` is a
 * link to `/private/tmp`, and the sandbox enforces on the destination — so a
 * grant written as `/tmp` grants exactly nothing, silently. Measured: with the
 * literal path, writing to /tmp inside the sandbox failed while the policy
 * looked correct on screen.
 */
/** Is this exact path a symlink? False if it is not on disk. */
function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The path with symlinks followed, or the path itself if it is not on disk. */
function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function expand(p) {
  let out = p;
  if (p === "$TMPDIR") out = tmpdir();
  else if (p === "~" || p.startsWith("~/")) out = join(homedir(), p.slice(2));
  try {
    return realpathSync(out);
  } catch {
    return out; // not on disk yet; hand the literal through rather than drop it
  }
}

/** Reads are denied wholesale under the key directory, then re-allowed one file at a time. */
/**
 * The settings one role gets.
 *
 * `spool` is the path of the parent's audit socket, when a parent is holding
 * one. It is granted by path so the hook can report what it decided without
 * the repo's state directory being writable from inside — see spool.js. With
 * no parent there is nothing to grant and nothing to reach.
 */
export function settingsFor(config, roleName, spool = null, observe = false) {
  const role = config.roles[roleName];
  if (!role) throw new Error(`unknown role "${roleName}". Known: ${Object.keys(config.roles).join(", ")}`);

  const abs = (p) => (p.startsWith("/") ? p : join(config.root, p));
  // "credentials" closes the places credentials live; "home" does that and
  // gives the role a home of its own. Only the second one needs a new HOME,
  // and only the second one signs every CLI in the box out. See config.js.
  //
  // `true` is normalised here as well as in the config reader, because a caller
  // embedding the library builds this object itself and `isolate: true` has
  // meant "home" since before there was a second level.
  const level = config.isolate === true ? "home" : config.isolate;
  const shielded = level === "credentials" || level === "home";
  const isolated = level === "home";

  /**
   * Refuse before the runtime does, because the runtime's refusal says nothing.
   *
   * With an isolated home too deep for the socket the runtime puts inside it,
   * `srt` dies on `listen EINVAL: invalid argument` and a path — no role, no
   * mention of `isolate`, nothing a reader could act on. This is the same
   * failure seisin already documents in spool.js, reached from the other side.
   */
  if (isolated) {
    const room = homeFits(config, roleName);
    if (room < 0)
      throw new Error(
        `\`isolate = true\` cannot hold role "${roleName}" here: its home leaves ` +
        `${-room} byte(s) too little for the runtime's socket, and a unix socket path ` +
        `is capped near ${SOCKET_MAX} bytes.\n` +
        `  Shorten the role name, or run with a shorter TMPDIR.`,
      );
  }

  const home = isolated ? roleHome(config, roleName) : null;
  const denyRead = [];
  const allowRead = [];

  // Every declared directory is denied, then each key the role names is
  // re-allowed. A key written without a directory resolves against the first
  // one, which keeps the ordinary single-directory config short.
  const dirs = config.keyDirs ?? [];
  for (const dir of dirs) {
    // A key *file* that is a symlink is refused below. The directory itself is
    // the same hole one level up: denyRead names the path as written, and the
    // runtime enforces on the destination — so `.secrets -> /tmp/elsewhere`
    // gives a deny that covers nothing and an allow that reaches out of the
    // repo. Refused rather than resolved, because a key directory that is not
    // where it says it is has nothing to gain from being clever about.
    const here = abs(dir);
    // lstat on the directory itself, not a comparison of resolved paths: on
    // macOS /var is a link to /private/var, so a repo under a temp directory
    // would fail this check for an ancestor it does not control.
    if (isLink(here))
      throw new Error(
        `[keys] dir "${dir}" is a symlink to ${realOrSelf(here)}.\n` +
        `  The sandbox enforces on the destination, so the deny would not cover what the ` +
        `allow reaches. Point [keys] dir at the real location instead.`);
    denyRead.push(here);
  }

  /**
   * Isolated mode also narrows what a role may READ, which the ordinary mode
   * does not touch at all.
   *
   * By default the model is "read anything except the declared key
   * directories", and that is a real limit worth saying out loud: `~/.ssh`,
   * `~/.aws`, `~/.npmrc`, `~/.config/gh/hosts.yml` and `~/.kube/config` are all
   * ordinary readable files to every role unless they happen to sit under a
   * key directory. For agents you run yourself that is a reasonable trade —
   * they need to read the machine to work. For anything you would not trust,
   * it is the whole game.
   *
   * These are denies rather than an allowlist on purpose. A default-deny read
   * set has to enumerate every library, interpreter and cache a toolchain
   * touches, gets one wrong, and fails as an unexplainable crash inside the
   * agent. Naming the places credentials actually live is narrower than the
   * ideal and it is a boundary that holds up in practice.
   */
  if (shielded) denyRead.push(...CREDENTIAL_HOMES.map(expand));

  /**
   * `~/.claude` and `~/.codex` are closed only at the `home` level, and the
   * difference is the whole reason the two levels exist.
   *
   * They hold a session, so closing them is right when each role is meant to be
   * a separate identity. But on macOS the agent's credential is not in there at
   * all — it is in the login keychain, reached through `$HOME`. At the
   * `credentials` level HOME is untouched, so the agent stays logged in and
   * every role shares that one session, exactly as they already do today.
   * Closing these two here would cost the session without buying the
   * separation, which is the worst of both.
   */
  if (isolated) {
    denyRead.push(...["~/.claude", "~/.codex"].map(expand));
    // And the other roles' homes. Giving each role its own HOME closed writing
    // between them and left reading wide open — so `a` could read the session
    // token `b`'s CLI had just written. Worse, the audit page said this was
    // closed, because the only thing measured was the write.
    //
    // Same shape as the key directories: deny the parent, allow your own.
    denyRead.push(realOrSelf(roleHomeRoot(config)));
    allowRead.push(realOrSelf(home));
  }
  /**
   * Only a key that IS a file becomes a read grant.
   *
   * A reference has no path, so there is nothing here to allow: it is resolved
   * by the parent before the sandbox starts and handed over as an environment
   * variable or as a scratch file. See keys.js. Filtering here rather than
   * upstream keeps the two kinds from having to know about each other — the
   * settings this function emits are still, entirely, about the filesystem.
   */
  for (const entry of entriesOf(role).filter((e) => e.kind === "file")) {
    const key = entry.raw;
    const path = key.includes("/") ? abs(key) : abs(join(dirs[0] ?? ".", key));
    // A key has to live in a declared key directory. Without this check a
    // slash in the name made the path relative to the repo root instead, so
    // `keys = ["../.ssh/id_rsa"]` re-opened a read outside `.secrets` — which
    // is a read grant written in the one list nobody reads twice, because
    // everything in it is supposed to be a key.
    // Resolved, not compared as text. The sandbox enforces on the destination
    // of a symlink — the same property that made a `/tmp` grant grant nothing —
    // so `.secrets/github-token.txt -> ~/.ssh/id_rsa` is a read grant on the
    // ssh key, written in the one list nobody audits twice. Measured: the read
    // succeeded through the link and through the real path.
    const real = realOrSelf(path);
    const inside = dirs.some((d) => {
      const root = realOrSelf(abs(d));
      return real === root || real.startsWith(root.endsWith("/") ? root : root + "/");
    });
    if (!inside)
      throw new Error(
        `keys = "${key}" for role ${role.name} resolves to ${real}, outside every [keys] dir ` +
        `(${dirs.join(", ") || "none declared"}).\n` +
        `${real === path ? "" : `  (it is a symlink: ${path} → ${real})\n`}` +
        `  A key must live in a declared key directory. To use another location, declare it: ` +
        `[keys] dir = ["${dirs[0] ?? ".secrets"}", "<the other one>"].`
      );
    allowRead.push(path);
  }

  return {
    network: {
      allowedDomains: role.network ?? config.allowedDomains,
      deniedDomains: [],
      // Exactly one socket: the parent's audit spool, when there is a parent.
      // Granted by path, not by turning unix sockets on.
      allowUnixSockets: spool ? [spool] : [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite: [
        // Observing means the kernel stops refusing, because otherwise there is
        // nothing to observe. `--observe` used to relax only the hook, so the
        // sandbox denied the write anyway and the banner said "nothing denied"
        // over a transcript of denials — and `init --from-observations` builds
        // a policy out of that transcript. It would read "the agent needs
        // nothing outside its territory", which is the opposite of the truth.
        //
        // The repo, and only the repo. Everything in denyWrite below still
        // holds: the config, the state directory and the key directories stay
        // shut even here, because observing is not a reason to hand over the
        // paperwork of the confinement.
        ...(observe ? [abs(".")] : role.writes.map((g) => toWritePath(g)).map(abs)),
        // `.seisin/` is deliberately NOT here. It used to be, because the hook
        // runs inside the box and has to record what it decided — which made
        // the log and the queue writable by the process they are a record of.
        // The hook now sends its lines to the parent over a socket and the
        // parent holds the file. See spool.js.
        // Isolated: this role's own home and scratch, and nothing shared.
        // Otherwise: the real ~/.claude, ~/.cache and /tmp, which every role
        // shares — convenient, and the reason `isolate` exists.
        ...(isolated
          ? [home, join(home, ".config"), join(home, ".local"), join(home, ".cache"), join(home, "tmp")]
          : (config.runtimeWrites ?? RUNTIME_WRITES).map(expand)),
      ],
      /**
       * The confinement's own paperwork, never writable — not even by a role
       * that was granted the whole repo.
       *
       * `writes = ["**"]` is a reasonable thing to write for a solo agent, and
       * it used to hand that agent its own policy file: rewrite seisin.toml,
       * get a wider territory on the next run. Measured against the real
       * kernel, not reasoned about. denyWrite wins over allowWrite in the
       * profile, so this holds however wide the territory gets.
       *
       * The key directories are already unreachable through denyRead — the
       * runtime turns a read-denied path into an unlink/create denial too — but
       * they are named here as well, because relying on that coupling is
       * relying on someone else's implementation detail staying put.
       */
      denyWrite: [
        /**
         * The role's own subtractions, `never_writes`.
         *
         * Here and not as a hole cut out of allowWrite, because the profile
         * cannot cut holes: it grants prefixes and denies prefixes, and a deny
         * wins over any grant however wide. That is the property the key is
         * built on, and the same one the entries below rely on.
         */
        ...(role.neverWrites ?? []).map((g) => toWritePath(g, "never_writes")).map(abs),
        abs(config.path ?? CONFIG_NAME),
        abs(STATE_DIR),
        ...dirs.map(abs),
        // The audit socket, and the directory holding it. Denying only the
        // socket left `mv /tmp/seisin-xxxx /tmp/gone` as a way to take the
        // channel out without ever touching the file that was protected.
        // Connecting is `network-outbound` and both of those are
        // `file-write-unlink`, so denying them leaves the first working.
        ...(spool ? [spool, dirname(spool)] : []),
        /**
         * Whatever the key providers execute.
         *
         * `seisin.toml` is denied because a role that can rewrite the policy
         * has no policy. A provider command is the same thing one level out:
         * the parent runs it, unsandboxed, as you — so a role that can rewrite
         * `bin/open-vault.sh` decides what runs outside the box. That is not a
         * wider boundary, it is no boundary, and it arrives disguised as an
         * ordinary file in somebody's territory.
         *
         * Found by writing the documentation: every worked example ended up
         * using a script, because the config language has no escapes and a
         * one-line shell pipeline cannot be spelled. So the shape this protects
         * is not a corner case — it is the shape the tool pushes you into.
         *
         * Only a command that resolves to a path. A bare name like `security`
         * or `op` is found on PATH, which is not this policy's to reason about.
         */
        ...providerPaths(config),
      ],
    },
  };
}

/**
 * The provider executables that live at a path, absolute.
 *
 * A command with no separator (`security`, `op`, `gpg`) is resolved by the OS
 * from PATH and is deliberately left alone: denying "wherever gpg happens to
 * be" would mean writing a rule about a machine rather than about a repo.
 */
export function providerPaths(config) {
  const out = [];
  for (const p of Object.values(config.keyProviders ?? {})) {
    const cmd = p.command?.[0];
    if (!cmd || !cmd.includes("/")) continue;
    out.push(cmd.startsWith("/") ? cmd : join(config.root ?? ".", cmd));
  }
  return [...new Set(out)];
}

/**
 * `allowWrite` takes directories, not globs: the OS grants a subtree, it does
 * not pattern-match. `src/api/**` and `src/api/` mean the same thing to the
 * kernel, so the trailing glob is trimmed rather than passed through, where it
 * would be read as a literal directory named `**` and silently grant nothing.
 */
function toWritePath(glob, key = "writes") {
  if (!EXPRESSIBLE(glob)) throw new Error(unexpressible(glob, key));
  if (glob === "**") return ".";
  return glob.replace(/\/\*\*$/, "") || ".";
}

/**
 * A write pattern the kernel can be given without changing its meaning.
 *
 * Exactly two shapes qualify: a literal path, and a subtree ending in `/**`.
 * Both map onto what allowWrite actually is — a prefix — so the policy, the
 * explanation and the enforcement stay the same sentence.
 *
 * Everything else is refused, and the one that made this necessary is `src/*`.
 * ownersOf() reads it as one level, because `*` compiles to `[^/]*`. The old
 * translation trimmed the `/*` and handed the kernel `src`, which is the whole
 * subtree. So `seisin explain` said denied and the write landed — measured, not
 * theorised. The document was tighter than the boundary, which is the one
 * direction a permission tool must never fail in.
 *
 * There is no exact translation to find later: Seatbelt and bubblewrap grant
 * prefixes, and "one level down" is not a prefix. Refusing is not a placeholder
 * here, it is the answer.
 */
const WILD = /[*?[\]]/;                       // owners.js treats all four as wildcards
const EXPRESSIBLE = (g) =>
  g === "**" ||                               // the whole repo
  !WILD.test(g) ||                            // a literal path
  (g.endsWith("/**") && !WILD.test(g.slice(0, -3)));   // a subtree, wildcard-free above it

function unexpressible(glob, key = "writes") {
  return `${key} = "${glob}" cannot be enforced as written.\n` +
    `  The sandbox grants a path and everything under it — there is no way to say ` +
    `"one level deep".\n` +
    `  Use "${glob.replace(/\/\*$/, "")}/**" for the whole subtree, or name the files.\n` +
    `  Refusing rather than widening: the old behaviour granted the subtree while ` +
    `seisin reported the narrow pattern.`;
}
