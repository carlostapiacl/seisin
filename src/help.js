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
    usage: ["seisin run <role> [--observe] [--debug-env] -- <command...>"],
    flags: [
      ["--observe", "open the repo for this run and record what the agent writes; keys and network stay shut"],
      ["--debug-env", "print the environment variables the role does not get"],
    ],
    notes: ["Everything after -- is the command's own, flags included: `-- claude --settings x.json` goes to claude."],
    examples: ['seisin run frontend -- claude', 'seisin run backend --observe -- claude -p "…"'],
    exits: [["n", "the command's own exit status"], ["127", "the command is not on the role's PATH"],
      ["128+n", "killed by signal n (130 for ctrl-c)"], ["2", "seisin could not start it (usage, policy, runtime)"]],
  },
  check: {
    usage: ["seisin check [role] [--verbose]"],
    flags: [["--verbose", "also print the protected paths, each warning's explanation and the standing limits"]],
    examples: ["seisin check", "seisin check frontend --verbose"],
    exits: [["0", "the policy can be enforced as written (warnings included)"], ["1", "a role cannot be enforced as written"], ["2", "usage or policy error"]],
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
    usage: ["seisin review [--all] [--min <n>]"],
    values: ["--min"],
    flags: [["--all", "every row, not the first ten per section"], ["--min <n>", "denials before a place counts as repeated (default 3)"]],
    examples: ["seisin review", "seisin review --min 5 --all"],
    exits: [["0", "no role denied repeatedly"], ["1", "a role was denied repeatedly"], ["2", "usage error"]],
  },
  walls: {
    usage: ["seisin walls <role> [--all] [--since <iso>] [--min <n>]"],
    values: ["--since", "--min"],
    flags: [["--all", "include walls not hit in the last few runs"], ["--since <iso>", "only denials after this time"],
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
