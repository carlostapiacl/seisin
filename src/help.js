/**
 * `seisin <command> --help` — one command's flags, examples and exit codes.
 *
 * The flags listed here are also the flags each command accepts: cli.js
 * refuses any other, so a typo is an error instead of a question answered as
 * if it had not been asked. One table, so the help and the check cannot
 * disagree about what a command takes.
 *
 * `values` are flags that take the next word as their value.
 */
export const COMMAND_HELP = {
  run: {
    usage: ["seisin run <role> [--observe] [--debug-env] [--agent <name>] -- <command...>"],
    values: ["--agent"],
    flags: [
      ["--observe", "open the repo for this run and record what the agent writes; keys and network stay shut"],
      ["--debug-env", "print the environment variables the role does not get"],
      ["--agent <name>", "claude, codex or none: which agent the command runs, when seisin cannot tell from it (a wrapper script). Its home is the run's scratch; the other agents' sign-in is closed"],
    ],
    notes: ["Everything after -- is the command's own, flags included: `-- claude --settings x.json` goes to claude."],
    examples: ['seisin run frontend -- claude', 'seisin run backend --observe -- claude -p "…"'],
    exits: [["n", "the command's own exit status"], ["127", "the command is not on the role's PATH"],
      ["86", "the canary proved the generated boundary does not hold; the command was not started"],
      ["128+n", "killed by signal n (130 for ctrl-c)"], ["2", "seisin could not start it (usage, policy, runtime)"]],
  },
  check: {
    usage: ["seisin check [role] [--verbose] [--verify] [--parallel]"],
    flags: [["--verbose", "also print the protected paths and each warning's explanation (the limits of every repo: seisin help limits)"],
      ["--verify", "run each role's verify command inside its sandbox (the one thing check executes)"],
      ["--parallel", "experimental: with --verify, run role checks concurrently; shared resources may race"]],
    examples: ["seisin check", "seisin check frontend --verbose", "seisin check backend --verify", "seisin check --verify --parallel"],
    exits: [["0", "the policy can be enforced as written (warnings included)"], ["1", "a role cannot be enforced as written, or its verify failed"], ["2", "usage or policy error"]],
  },
  explain: {
    usage: ["seisin explain <role> read|write <path>", "seisin explain <role> read <key>", "seisin explain <role> mcp <server>"],
    flags: [],
    notes: ["A relative path is relative to the directory you are in."],
    examples: ["seisin explain frontend write src/app.js", "seisin explain backend read stripe.txt", "seisin explain frontend mcp github"],
    exits: [["0", "allowed"], ["1", "denied"], ["2", "usage error"]],
  },
  whose: {
    usage: ["seisin whose <path>"],
    flags: [],
    notes: ["Safe to call from inside the sandbox. A relative path is relative to the directory you are in."],
    examples: ["seisin whose backend/src/server.py"],
    exits: [["0", "answered"], ["2", "usage error"]],
  },
  scan: {
    usage: ["seisin scan [--all]"],
    flags: [["--all", "walk the whole folder, not only where the territories are"]],
    examples: ["seisin scan", "seisin scan --all"],
    exits: [["0", "no certain credential outside the key dirs"], ["1", "at least one certain credential"], ["2", "usage error"]],
  },
  review: {
    usage: ["seisin review [--all] [--min <n>] [--since <date|duration>]"],
    values: ["--min", "--since"],
    flags: [["--all", "every row, not the first ten per section"], ["--min <n>", "denials before a place counts as repeated (default 3)"],
      ["--since <when>", "only what was recorded since a date (2026-10-01) or a duration back from now (7d, 12h, 2w)"]],
    examples: ["seisin review", "seisin review --since 7d", "seisin review --min 5 --all"],
    exits: [["0", "no role denied repeatedly"], ["1", "a role was denied repeatedly"], ["2", "usage error"]],
  },
  walls: {
    usage: ["seisin walls <role> [--all] [--since <when>] [--min <n>]"],
    values: ["--since", "--min"],
    flags: [["--all", "include walls not hit in the last few runs"], ["--since <when>", "only denials since a date (2026-09-01) or a duration back from now (7d)"],
      ["--min <n>", "times denied before it is a wall (default 2)"]],
    examples: ["seisin walls frontend", "seisin walls frontend --since 2026-09-01 --min 3"],
    exits: [["0", "no walls"], ["1", "walls listed"], ["2", "usage error"]],
  },
  wire: {
    usage: ["seisin wire"],
    flags: [],
    notes: ["Writes .claude/settings.json in this repo, merged with what is there."],
    examples: ["seisin wire"],
    exits: [["0", "wired, or already wired"], ["2", "usage error, or settings.json is not valid JSON"]],
  },
  requests: {
    usage: ["seisin requests"],
    flags: [],
    notes: ["#n is a position and shifts as requests are settled; the id under each one does not."],
    examples: ["seisin requests"],
    exits: [["0", "nothing pending"], ["1", "requests pending"], ["2", "usage error"]],
  },
  grant: {
    usage: ['seisin grant <n|id> [--reason "…"]'],
    values: ["--reason"],
    flags: [['--reason "…"', "recorded beside the grant in the policy"]],
    examples: ["seisin grant 1", "seisin grant 'frontend:write:docs' --reason \"owns the docs now\""],
    exits: [["0", "granted, or already granted"], ["2", "no such request, or it cannot be granted"]],
  },
  decline: {
    usage: ['seisin decline <n|id> [--reason "…"]'],
    values: ["--reason"],
    flags: [['--reason "…"', "recorded with the decision"]],
    examples: ["seisin decline 2 --reason \"not frontend's key\""],
    exits: [["0", "declined"], ["2", "no such request"]],
  },
  log: {
    usage: ["seisin log [--role <r>] [--verdict allowed|denied|observed] [--limit <n>]", "seisin log verify"],
    values: ["--role", "--verdict", "--limit"],
    flags: [["--role <r>", "only this role"], ["--verdict <v>", "allowed, denied or observed"], ["--limit <n>", "how many entries (default 40)"]],
    examples: ["seisin log --role frontend --verdict denied", "seisin log verify"],
    exits: [["0", "printed; for verify, the hash chain holds"], ["1", "verify: the hash chain is broken"], ["2", "usage error"]],
  },
  watch: {
    usage: ["seisin watch"],
    flags: [],
    examples: ["seisin watch"],
    exits: [["0", "stopped with ctrl-c"], ["2", "usage error"]],
  },
  init: {
    usage: ["seisin init [--force]", "seisin init --from-observations"],
    flags: [["--force", "overwrite an existing seisin.toml, keeping the old one as seisin.toml.bak"],
      ["--from-observations", "write seisin.toml.observed from what observed runs recorded"]],
    examples: ["seisin init", "seisin init --from-observations"],
    exits: [["0", "written"], ["2", "a policy is already there, or nothing was observed"]],
  },
  ui: {
    usage: ["seisin ui [--port <n>] [--link]"],
    values: ["--port"],
    flags: [["--port <n>", "port on 127.0.0.1 (default 4178)"], ["--link", "print the link of a console already running, start nothing"]],
    examples: ["seisin ui", "seisin ui --link"],
    exits: [["0", "stopped"], ["2", "could not start"]],
  },
  mcp: {
    usage: ["seisin mcp"],
    flags: [],
    notes: ["An MCP server on stdio, read-only: it can explain and draft, never grant."],
    examples: ["claude mcp add seisin -- seisin mcp"],
    exits: [["0", "stdin closed"]],
  },
  hook: {
    usage: ["seisin hook"],
    flags: [],
    notes: ["Claude Code's hook: one event on stdin, a decision on stdout. `seisin wire` installs it."],
    examples: [],
    exits: [["0", "always — the hook explains, the kernel enforces"]],
  },
};
COMMAND_HELP.deny = COMMAND_HELP.decline;

/**
 * What the tool cannot do at all — as opposed to `check`'s warnings, which are
 * things wrong with *this* config.
 *
 * Kept apart on purpose. A limit printed as a warning reads as something a
 * person could fix, and after the third run it reads as nothing at all.
 *
 * They used to close `check --verbose`, six paragraphs under every repo's
 * findings, identical in each one — so the part of the output about *this*
 * repo was the part nobody reached. `check` now names how many there are and
 * where to read them: `seisin help limits`. `inspect()` still returns them,
 * so the MCP hands them out with the map.
 */
export const LIMITS = [
  ...(process.platform === "darwin" ? [] : [{
    kind: "kernel-denials-unreadable",
    headline: "denials by the kernel are not recorded on this platform",
    detail:
      "on macOS `seisin run` reads them out of the system log, so a denial the hook never " +
      "saw still lands in `seisin log` with its owner and still queues a request. There is no " +
      "equivalent to read here — bubblewrap does not log denials, and the runtime's substitute " +
      "is not reachable from outside it. The boundary holds exactly as well; what you lose is " +
      "seeing it work. Run `seisin wire` so the hook records what it can. The ask is upstream: " +
      "github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md",
  }]),
  {
    kind: "keys-only-what-you-declared",
    headline: "key isolation covers the directory you declared, and nothing else",
    detail:
      "a credential sitting in the repo outside [keys] dir is ordinary readable " +
      "content to every role. Run `seisin scan` to find them — check does not, " +
      "because reading the whole tree on every invocation is how a command stops " +
      "being run.",
  },
  {
    kind: "observe-cannot-see-the-network",
    headline: "`--observe` opens the filesystem, never the network",
    detail:
      "so it cannot tell you which domains an agent needs. The runtime does record every " +
      "denial the proxy makes — host, port and reason — but only a caller that embeds the " +
      "library can read them; nothing reaches a caller that runs the binary, which is what " +
      "seisin does. So for an agent whose endpoints are not published, the options are to " +
      "find them another way or drop the network restriction for it. The ask is upstream: " +
      "github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md",
  },
  ...(process.platform === "linux" ? [{
    kind: "control-files-linux",
    headline: "a project's hooks and settings are protected only where they already exist",
    detail:
      "bubblewrap denies a path by mounting over it, and for a path that is not there it would " +
      "create it on your disk. So on Linux a role can still create a .git/hooks entry or a " +
      ".claude/settings.json in a project of its territory that had none. On macOS the kernel " +
      "denies creating them too.",
  }] : []),
  {
    kind: "shared-scratch",
    headline: "roles share ~/.cache, ~/.local/share and the temp dir unless isolate = \"home\"",
    detail:
      "programs installed there that are on your PATH are protected, and so are Claude Code's " +
      "settings and plugins. Anything else a program outside the sandbox reads from those places — a " +
      "cache it executes, a tool not on PATH — is writable by every role. isolate = \"home\" " +
      "gives each role its own.",
  },
  {
    kind: "agent-sign-in",
    headline: "~/.claude goes only to runs of claude, ~/.codex only to runs of codex",
    detail:
      "seisin reads the agent off the command after `--`, and a run is denied the other " +
      "agents' sign-in files (~/.codex/auth.json, ~/.claude/.credentials.json). What a run " +
      "of an agent can still read is its own: Codex and every command Codex runs share one " +
      "sandbox, so with a ChatGPT sign-in kept in ~/.codex/auth.json they can read those tokens. " +
      "Codex keeps them in the keychain instead with cli_auth_credentials_store = \"keyring\" " +
      "in its config. A wrapper script is not followed: `seisin run <role> --agent codex -- ./script` " +
      "names it. The protected paths `seisin check --verbose` lists are for every agent at once, " +
      "because a role can be run as any of them.",
  },
  {
    kind: "unlink-uncovered",
    headline: "a role can delete inside its own territory",
    detail:
      // The path that used to be here ships with the repo and not with the npm
      // package, so for most readers it named a file they do not have.
      "writes and deletes are one permission to the kernel, so `rm` inside a " +
      "role's own folders succeeds. Closing it needs denyUnlink in the sandbox " +
      "runtime: github.com/carlostapiacl/seisin#how-it-holds",
  },
];

/** `seisin help limits`, as text. */
export function renderLimits(C) {
  const lines = ["", `${C.b}what seisin cannot do, in any repo${C.off}`, ""];
  for (const l of LIMITS) lines.push(`  ${C.b}${l.headline}${C.off}`, `  ${l.detail}`, "");
  lines.push(`  ${C.dim}seisin check lists what is wrong with this repo's policy${C.off}`, "", "");
  return lines.join("\n");
}

/** The flag words a command accepts, for the unknown-flag check. */
export function flagsOf(name) {
  const h = COMMAND_HELP[name];
  if (!h) return null;
  const values = h.values ?? [];
  const known = h.flags.map(([f]) => f.split(" ")[0]).filter((f) => !values.includes(f));
  return { known, values };
}

/** The help for one command, as text. */
export function renderHelp(name, C) {
  const h = COMMAND_HELP[name];
  const lines = ["", "usage:", ...h.usage.map((u) => `  ${u}`)];
  if (h.flags.length) {
    const w = Math.max(...h.flags.map(([f]) => f.length));
    lines.push("", "flags:", ...h.flags.map(([f, d]) => `  ${f.padEnd(w)}  ${d}`));
  }
  if (h.notes?.length) lines.push("", ...h.notes.map((n) => `  ${n}`));
  if (h.examples.length) lines.push("", "examples:", ...h.examples.map((e) => `  ${e}`));
  const w = Math.max(...h.exits.map(([c]) => c.length));
  lines.push("", "exit codes:", ...h.exits.map(([c, d]) => `  ${c.padEnd(w)}  ${d}`));
  lines.push("", `  ${C.dim}seisin --help for every command${C.off}`, "", "");
  return lines.join("\n");
}
