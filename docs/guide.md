# Using seisin: one agent, several, or a fleet

seisin is the same tool at every size. What changes is who lends the territory, where the runs are
kept, and who decides what an agent asked for. This guide takes the three cases in order; each
builds on the one before.

| | one agent | several agents, one repository | a fleet behind a launcher |
|---|---|---|---|
| the policy | `seisin.toml` in the repo | the same file, one role per agent | one file the launcher keeps, one role per kind of agent |
| a run is started by | you | you, or a script | the launcher, with `--policy`, `--state-dir`, `--run-id` |
| the runs are kept | in the repo's log | in the repo's log | one folder per run (docs/runs.md) |
| a request is decided | by you: `seisin grant`, or the console | by you; seisin routes it to the role that owns the path | where the run was launched; the console reads only |
| you read | the end of each run, `seisin attention` | the console by role | `seisin attention --runs`, the console over the folder |

---

## 1. One repository, one agent

You want the agent to edit your code and not your credentials, your `.git`, or the rest of the machine.

```bash
npm install -g seisin
cd your-repo
seisin init          # proposes a seisin.toml from what the repo already says
seisin check         # read it before you trust it: each role, what it may write and read
seisin wire          # the PreToolUse hook: the agent hears whose a path is before and after a denial
seisin run dev -- claude -p "fix the failing test in src/api"
```

`seisin run` starts the agent inside its role. Before anything of the agent's runs, a **canary** tries
the policy from inside the sandbox: a write it must not make, a secret it must not read, a port it must
not reach. If any of them goes through, nothing starts and the run exits **86**.

When the run ends, seisin says what it was denied, in five words that every screen uses:

```
seisin: 4 denials in this run — 1 expected, 1 protected on purpose, 2 to look at:
  no owner   write docs/guide.md (2×) — an ownable path no role claims: a real decision — give it an owner, or tell the agent not to write there
  → seisin explain dev write docs/guide.md · across runs: seisin attention
```

| word | what it is | what to do |
|---|---|---|
| **no owner** | no role owns the path | decide: give it to a role, or tell the agent not to write there |
| **outside** | a host, a port, a key, or a path outside the repository | the allow list's question |
| **other role** | another role's territory | hand the work over, or the territory is drawn wrong |
| **protected** | closed to every role on purpose (`.git`, the policy, control files) | nothing |
| **expected** | the agent program's own housekeeping (plugin updates, OS preferences) | nothing |
| **granted since** | denied before a grant you have since made | nothing |

A denial that a person could fix also leaves a **request**:

```bash
seisin requests                              # what the agent asked for and cannot have
seisin grant 1 --reason "dev owns the docs"  # adds the line to seisin.toml, with its provenance
seisin decline 1 --reason "not in scope"
```

Granting is never a tool call: an agent can read the queue and draft the change, only a person applies
it. Over several runs:

```bash
seisin attention --since 7d    # did the boundary hold, and what needs a person
seisin review --since 7d       # where the policy was wrong: repeated denials, grants never used
seisin ui                      # the same, in a browser, with Grant and Decline
```

`seisin ui` opens on an **Overview**: whether the boundary held, your role, and what needs a person. If
something is waiting on you it is the first card, and the role's page has Grant and Decline next to what
the role may write today.

## 2. One repository, several agents

Two or more agents in the same repository each get a **role**: the folders it may write, the keys it may
read, the hosts it may reach. Anything not listed is denied.

```toml
[keys]
dir = ".secrets"

[roles.web]
writes = ["web/**", "public/**"]
keys   = ["netlify-token.txt"]

[roles.api]
writes  = ["api/**", "migrations/**"]
keys    = ["database-url.txt"]
network = ["api.stripe.com"]
```

```bash
seisin run web -- claude -p "…" &
seisin run api -- codex exec "…" &
```

Each run is confined on its own; neither can write the other's territory or read the other's keys.
When `web` is denied a write in `api/`, the denial says so (**other role** · belongs to api) and the
request is routed to the role that owns the path, so the decision is about a boundary between two roles,
not a widening of one.

What changes when you read it:

- **The console is read by role.** The sidebar lists every role of the policy. A role's page says what it
  may do (writes, reads, keys, network, the sandbox that holds it), its requests with Grant and Decline,
  what it was denied across its runs, and its runs. A run opens in place, under the role, in order: the
  canary, each denial once with its count and where it stands, the end.
- **Walls**: what a role keeps being denied, and how many calls retrying cost: `seisin walls web`, in the
  terminal. In the console, a role's page lists what it was denied by how many runs hit it; the
  retry count is in `seisin walls`.
- **Notifications**: with `[notify]`, a message per new request (ntfy, Slack, any webhook), so a request
  does not wait for someone to open the console.
- **Your assistant can ask**: `seisin mcp` is a read-only MCP server. An agent can ask whose a path is,
  what it was denied and why, and it cannot grant anything.

## 3. A fleet of agents behind a launcher

An orchestrator starts many agents, often in worktrees it throws away, each run with its own task. This
is the case seisin is being built toward, and most of what follows exists for it.

**One policy, narrowed per run.** Keep one file with a role per *kind* of agent (planner, executor,
reviewer…), and say on the command line what this run may touch:

```bash
cd <worktree>
seisin run executor --policy <dir>/seisin.toml --state-dir <dir>/runs/<run_id>/.seisin --run-id <run_id> \
  --var RUN=<run folder> --var MCP_PORT=8769 \
  --only "src/api/**" --deny "src/api/held.test.ts" -- claude -p "…"
```

- `--policy` reads the policy from outside the worktree and roots it at the working directory, so
  nothing of seisin's is written into the worktree.
- `--state-dir` and `--run-id` put the run's log and queue in a folder named by the launcher's id: the
  run is archived in the shape the console reads, while it runs and after.
- `--only` and `--deny` narrow the role for this run; the role in the file is the most any run can have,
  and that is what a person reviews. What the run held under is kept beside its log.
- `--var` fills the few paths and ports one policy cannot know in advance.

**The archive.** One folder per run under one directory, with the launcher's word on the run in
`run.json` (`team`, `work_item`, `role`, `status`, dates). The contract is in
[docs/runs.md](runs.md).

**Reading a fleet.**

```bash
seisin attention --runs <dir> --since 24h          # the morning check
seisin attention --runs <dir> --work-item WI-41    # one work item, every run it took
seisin attention --runs <dir> --json               # for the launcher's own panel
seisin ui --runs <dir>                             # the console over the archive
```

`seisin attention` exits 1 when a run's canary failed in the window, so it composes in CI or a cron.

**What is designed for this case:**

- **Who decides is the launcher.** A territory the launcher lends is the launcher's to widen. With
  `[console] launcher = "<name>"` the console and the server write nothing: every denial says *access is
  asked for in `<name>`*, and a grant written into an archived run would change nothing anywhere.
  `seisin grant` still does what a person at a terminal tells it.
- **The console reads the fleet by role**, not by run. Hundreds of runs become a handful of roles; the
  filter at the top (window, team, the launcher's word for the run, work item) applies to every view, so
  a work item is read whole: every role it used and every run it took.
- **Denials are sorted, not totalled.** In a fleet almost every denial is the boundary working. The same
  file name in many places is one line (`…/__pycache__ in 26 places`), the ports the system hands out are
  one line, and a cause first seen in the last day is marked new.
- **Each run proves the boundary before it starts.** The canary runs per run and per role. A run whose
  canary failed is counted apart, and nothing of the agent's ran in it.
- **The record says when it is incomplete.** On macOS the system log can drop kernel messages under load;
  a run where that happened is marked, so a quiet run is not mistaken for a clean one.
- **Trace context.** A launcher that passes a trace id has it on every line of the run's log, so its
  records and seisin's join on the same key.

**Not yet:** an agent identity the launcher can rely on (today the role and the run id are what the log
carries), and granting from the console for a launcher that lends territory (it is the launcher's
decision, and it stays there).

---

## Which console you see

| started as | it reads | it opens on | writes |
|---|---|---|---|
| `seisin ui` in a repository | the policy, its log, the runs in it | Overview | Grant, Decline, control files |
| `seisin ui` with `[console] runs` | the policy, and the runs directory it names | Overview | as above, unless `[console] launcher` is set |
| `seisin ui --runs <dir>` | the directory alone | Overview | nothing |

It is one console in every case; what changes is what it has to read and whether a decision can be made
from it.

## Where to read more

- [configure.md](configure.md) — every field of the policy
- [requests.md](requests.md) — how a denial becomes a request, and what a grant records
- [log.md](log.md) — the log, `review`, `attention`, the console, the MCP server, walls
- [runs.md](runs.md) — the archive contract, and the flags a launcher uses
- [keys.md](keys.md) — keys by reference, and what masking does and does not do
- [sandboxes.md](sandboxes.md) — tartaros, sandbox-runtime, and a sandbox of your own
