/**
 * What a line of policy grants on disk, as paths.
 *
 * Pulled out of srt.js, which used to hold both halves: translating a policy
 * into paths, and assembling the runtime's settings object out of them. The
 * first half has a second reader now — surface.js asks "what can ANY role
 * write?" to decide what the parent must not trust — and a module that needs
 * the answer should not have to import the settings builder to get it.
 *
 * No policy decisions live here. Every function answers "which path does this
 * mean", and the callers decide what to do with it.
 */
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { realpathSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { WILD } from "./paths.js";

/**
 * What every agent needs to write no matter which role it is.
 *
 * Found by running a policy with 32 roles through the sandbox: territory alone
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
   * same id: `/Users/ana/dev/project` and `/Users/bob/dev/project` collide, and
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
export const SOCKET_MAX = 104;

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
 * The agents that keep their state — and their sign-in — under a directory of
 * their own name, and where that sign-in sits when it is a file.
 *
 * `~/.claude` and `~/.codex` used to be granted to every run, whatever it ran.
 * The cost was measured on 2026-09-30: a role running nothing but `cat` read
 * `~/.codex/auth.json`, the ChatGPT tokens of whoever signed Codex in. The
 * directory is the agent's scratch, so it goes to a run of that agent; and the
 * other agents' sign-in files are denied to it, read and write, so a Claude
 * run cannot read Codex's tokens or swap them for another account's.
 *
 * `~/.claude/.credentials.json` is where Claude Code keeps its sign-in when
 * there is no keychain (Linux, and macOS when the keychain is unavailable).
 * On macOS it is normally in the login keychain, which no file rule reaches.
 *
 * What this does NOT close, said where it is decided: a run of Codex can read
 * its own `auth.json`, and so can every command Codex runs, because they share
 * one sandbox. Only Codex storing its sign-in in the keychain closes that
 * (`cli_auth_credentials_store = "keyring"`), and that is Codex's setting.
 */
export const AGENT_HOMES = { claude: "~/.claude", codex: "~/.codex" };
export const AGENT_CREDENTIALS = {
  claude: ["~/.claude/.credentials.json"],
  codex: ["~/.codex/auth.json"],
};
export const AGENTS = Object.keys(AGENT_HOMES);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const LAUNCHERS = new Set(["node", "npx", "bunx", "pnpx", "bun", "deno"]);

/** Which agent a token names, by its basename or its package path, or null. */
function agentNamed(token) {
  const t = String(token ?? "");
  const base = t.split("/").pop().replace(/\.(c|m)?js$/, "");
  if (AGENTS.includes(base)) return base;
  if (/@openai\/codex(\/|$)/.test(t)) return "codex";
  if (/@anthropic-ai\/claude-code(\/|$)/.test(t)) return "claude";
  return null;
}

/**
 * The agent a command line runs, or null when it is none seisin knows.
 *
 * Reads what a person writes after `--`: the program, through `env` and
 * `VAR=value`, through a launcher (`node …/@openai/codex/bin/codex.js`,
 * `npx @anthropic-ai/claude-code`), and through `sh -c "codex exec …"` by the
 * first word of the script. Nothing cleverer: a prompt that mentions "claude"
 * must not turn a run into a Claude run. A wrapper script is not followed —
 * `seisin run <role> --agent codex -- ./wrapper.sh` says it instead.
 */
export function agentOf(cmd = []) {
  const argv = [...cmd];
  for (let depth = 0; depth < 4 && argv.length; depth++) {
    while (argv.length && (argv[0] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0]) ||
      (argv[0].startsWith("-") && depth > 0))) argv.shift();
    if (!argv.length) return null;
    const head = argv.shift();
    const named = agentNamed(head);
    if (named) return named;
    const base = head.split("/").pop();
    if (LAUNCHERS.has(base)) {
      const next = argv.find((a) => !a.startsWith("-"));
      return next ? agentNamed(next) : null;
    }
    if (SHELLS.has(base)) {
      const i = argv.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (i === -1 || argv[i + 1] === undefined) return null;
      argv.splice(0, argv.length, ...argv[i + 1].trim().split(/\s+/));
      continue;
    }
    return null;
  }
  return null;
}

/**
 * The scratch list for a run of `agent`: every entry, minus the homes of the
 * agents it is not.
 *
 * `agent === undefined` is "no command known" — check, console, explain, and
 * the union surface.js needs — and answers with every home, which is the most
 * any run of the role gets. `null` is a command that is no agent seisin knows,
 * and gets neither home. An explicit `[runtime] writes` goes through the same
 * filter: listing `~/.codex` there says what a Codex run may write, not that
 * a `cat` may.
 */
export function runtimeWritesFor(config, agent) {
  const list = (config.runtimeWrites ?? RUNTIME_WRITES).map(expand);
  if (agent === undefined) return list;
  const others = AGENTS.filter((a) => a !== agent).map((a) => expand(AGENT_HOMES[a]));
  return list.filter((p) => !others.some((h) => p === h || p.startsWith(h + "/")));
}

/**
 * The sign-in files of every agent this run is not, absolute, under `home`.
 *
 * Empty when no command is known: a role's settings without a command are the
 * most it can get, and the most includes being run as either agent.
 */
export function otherAgentsCredentials(agent, home = homedir()) {
  if (agent === undefined) return [];
  const at = (p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);
  return AGENTS.filter((a) => a !== agent).flatMap((a) => AGENT_CREDENTIALS[a].map(at)).map((p) => realOrSelf(p));
}

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
export function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The path with symlinks followed, or the path itself if it is not on disk.
 *
 * `.native` is realpath(3): one call instead of an lstat per component, and on
 * a case-insensitive disk (APFS) it answers with the case the disk has. The JS
 * version keeps whatever case it was given, so `/users/x` and `/Users/x` —
 * one directory — compared as two, and a path spelled the other way came out
 * "outside the repo" while the kernel treated it as inside.
 */
export function realOrSelf(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function expand(p) {
  let out = p;
  if (p === "$TMPDIR") out = tmpdir();
  else if (p === "~" || p.startsWith("~/")) out = join(homedir(), p.slice(2));
  try {
    return realpathSync.native(out);
  } catch {
    return out; // not on disk yet; hand the literal through rather than drop it
  }
}

/**
 * `allowWrite` takes directories, not globs: the OS grants a subtree, it does
 * not pattern-match. `src/api/**` and `src/api/` mean the same thing to the
 * kernel, so the trailing glob is trimmed rather than passed through, where it
 * would be read as a literal directory named `**` and silently grant nothing.
 */
export function toWritePath(glob, key = "writes") {
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

/**
 * Every directory a role may write, absolute, as its settings will say it.
 *
 * Observe mode is not a role property — any role can be run with it — and it
 * grants the whole repo, so `observe: true` answers for that case.
 *
 * `.seisin/` is deliberately NOT here. It used to be, because the hook runs
 * inside the sandbox and has to record what it decided — which made the log and
 * the queue writable by the process they are a record of. The hook now sends
 * its lines to the parent over a socket and the parent holds the file. See
 * spool.js.
 *
 * Isolated: this role's own home and scratch, and nothing shared. Otherwise:
 * the real ~/.claude, ~/.cache and /tmp, which every role shares — convenient,
 * and the reason `isolate` exists.
 */
export function writePathsOf(config, role, { observe = false, agent } = {}) {
  const abs = (p) => (p.startsWith("/") ? p : join(config.root, p));
  const level = config.isolate === true ? "home" : config.isolate;
  const home = level === "home" ? roleHome(config, role.name) : null;
  return [
    ...(observe ? [abs(".")] : role.writes.map((g) => abs(toWritePath(g)))),
    ...(home
      ? [home, join(home, ".config"), join(home, ".local"), join(home, ".cache"), join(home, "tmp")]
      : runtimeWritesFor(config, agent)),
  ];
}
