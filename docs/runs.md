# The console's runs

`seisin ui` is one console: what is waiting on you, the runs, what was denied, the roles and
the log. **Runs** is one more item in its menu, and it gets its runs from one of three places:

- **A repository with no launcher:** from its own log. Every line `seisin run` writes names its
  run, so there is nothing to set up.
- **A launcher that keeps a folder per run:** a policy names the directory, relative to the
  policy file, and the launcher it is lent by:

  ```toml
  [console]
  runs = ".my-harness/seisin/runs"
  launcher = "my-harness"
  ```

- **No policy at hand:** `seisin ui --runs <dir>` is the same console over the directory alone,
  on port 4179 unless told otherwise.

```bash
seisin ui                                    # the policy, and its runs, on 127.0.0.1:4178
seisin ui --link                             # the link of the one already running
seisin ui --runs <dir>                       # the directory alone, on 127.0.0.1:4179
seisin ui --runs <dir> --link --json         # its link, for a program: nothing opened
```

The page lists every run, newest first, filtered by team, role, work item, status and
outcome. It sums what the shown runs were denied and what that cost in retries, and puts the
same denial in many runs on one line. A run opens as the same views, over that run: its denials, its
walls, its policy and its log.

## Read only

A run is never granted from. What it was lent is the launcher's to lend, and a grant written
into an archived policy would change nothing anywhere. With `[console] launcher` the whole
console reads this way, because two places that approve the same thing are one too many:

- every route that writes (`/api/decide`, `/api/decline-all`, `/api/control-files`) answers
  **405**, as does any method but `GET` and `HEAD`, when there is no policy or a launcher lends it;
- the page has no **Waiting on you**. A denial says *Not granted here: access is asked for in
  `<launcher>`*. A request the run asked for stays in `/api/run`, for a program that reads it;
- a request queue an older seisin left in the old form is shown as an error, never migrated.

`[console] launcher` closes the console, not the CLI: `seisin grant` still does what a person
at a terminal tells it.

The token travels only in the link's fragment, never in
a response, and every `/api/` route asks for it.

## The directory: the contract

`<dir>` holds **one folder per run, named by the run's id.** That name is what `run=` takes,
so it may hold letters, digits, `.`, `_` and `-`, start with a letter or a digit, and run up
to 128 characters. Anything else in `<dir>` (a file, a folder with another name) is skipped.

```
<dir>/
  <run_id>/
    seisin.toml          the policy the run ran under, as it was written for it. A run
                         narrowed from one policy has none here: what it held under is
                         in .seisin/policies/, and the newest there is read instead
    .seisin/             what seisin kept beside it: log.jsonl (and rotated log.jsonl.N),
                         requests.jsonl
    run.json             the launcher's word on the run (optional)
```

`run.json` is one JSON object. The console reads these fields, as strings, and ignores the
rest:

| field | what it is |
|---|---|
| `run_id` | shown as the run's name; defaults to the folder's name |
| `team` | filter and grouping |
| `work_item` | filter, e.g. `WI-41` |
| `role` | the launcher's role for the run (planner, executor, reviewer…), a filter. Not a seisin role: those are in `seisin.toml` |
| `repo` | shown, and searched |
| `started_at`, `ended_at` | ISO dates. Newest first by `started_at` |
| `status` | the launcher's verdict (done, failed…), a filter |
| `launcher` | named in "ask for it in …" (e.g. `my-harness`) |

Beside the launcher's `status`, each run gets seisin's own `outcome`:

| outcome | when |
|---|---|
| `refused` | its canary failed: the boundary did not hold, nothing ran |
| `denied` | it ran, and was denied at least one file or host |
| `clean` | its canary passed, and it was denied neither. The OS's own housekeeping (`kind: "system"`) and the canary's expected probes do not count |
| `no-record` | nothing says the boundary held: no log, or no passed canary in it. It was not found clean, there is nothing to tell |

A run whose system log dropped kernel messages (macOS, a flooded unified log) also says
**record incomplete**: the boundary held, but some of its denials may be missing from the log.
| `unread` | its policy is missing or does not load; the error is shown |

**When something is missing:**

- **No `run.json`**, or one that is not a JSON object: the run is listed under its folder's
  name, with no team, role, work item or status. Its start and end come from the first and
  last line of its log.
- **`.seisin/` missing or empty**: the run is listed as `no-record`, with nothing denied.
- **No policy at all** (no `seisin.toml`, no `seisin.json`, nothing in `.seisin/policies/`), or one that does not parse: the run is listed as `unread`, with the
  reason, and does not open.

**What counts as a retry.** Across runs, every denial after the first of the same thing in
the same run, system denials aside. An archived run's policy does not change, so a repeat is a
retry against a wall that was still there. Inside one run the walls view says the same thing
the console over one policy does.

**The generated settings** a run's Roles view shows are worked out again from its archived
`seisin.toml`, against the archive folder. Relative territory resolves there, not in the
worktree the run had.

## Writing runs in this shape: `--policy`, `--state-dir`, `--run-id`

A launcher does not have to copy anything out of a worktree. Give each run a folder under
`<dir>`, write the policy into it, and start the run from the worktree with:

```bash
cd <worktree>
seisin run agent --policy <dir>/<run_id>/seisin.json --state-dir <dir>/<run_id>/.seisin \
  --run-id <run_id> -- claude -p "…"
```

`--run-id` is stricter than a folder name: letters, digits, `_` and `-`, up to 64 characters (no
`.`). An id that fits it fits both.

- `--policy <file>` reads the policy from that file and roots it at the working directory,
  so the territory is the worktree and nothing of seisin's is written into it (no
  `seisin.toml` to keep out of git, no `.seisin/` to copy). The file may be `seisin.toml`, or
  `seisin.json` for a launcher that generates the policy: JSON can hold a quote in a value,
  and it is read as strictly (same settings, a key written twice refused). A JSON policy is
  changed where it is generated, so `grant` does not edit it.
- `--state-dir <dir>` keeps the log and the request queue there. With `<dir>/<run_id>/.seisin`
  the run is already in the shape this console reads, while it runs and after.
- `--run-id <id>` names the run in the log with the launcher's id, so one run's lines and the
  launcher's records join on the same key.
- `seisin check --json` says which of these the installed seisin supports (`capabilities`),
  and the sandbox, path and version each role gets.

`--policy` and `--state-dir` work with any command (`seisin whose`, `seisin walls`…), the same
way.

## One policy for every run: `--only`, `--deny`, `--var`

Most of what a launcher writes per run is the same every time. Measured on a pilot over 275 runs: four
of its five kinds of agent never wrote anything, and what changed between runs of the fifth was which
folders that task could write and which tests it could not touch. So a launcher can keep one policy with
a role per kind of agent, and say the rest on the line:

```toml
[runtime]
read = "territory"
isolate = "credentials"
writes = ["$RUN/home", "$RUN/tmp"]

[roles.planner]
writes = []
reads = ["$RUN/config", "$AGENT_BIN"]
local_ports = ["$MCP_PORT"]

[roles.executor]
writes = ["**"]
reads = ["$RUN/config", "$AGENT_BIN"]
local_ports = ["$MCP_PORT"]
```

```bash
cd <worktree>
seisin run executor --policy <dir>/seisin.toml --state-dir <dir>/runs/<run_id>/.seisin --run-id <run_id> \
  --var RUN=<run folder> --var AGENT_BIN=<agent's folder> --var MCP_PORT=8769 \
  --only "src/api/**" --deny "src/api/held.test.ts" -- claude -p "…"
```

- **`--only <glob>`** is all this run may write. Each one has to be inside what the role may write, or the
  run does not start. It is worked out only when the answer is certain: the same text, `**`, or a subtree
  that holds it. Under a ceiling with a wildcard in the middle, name the same glob or widen the ceiling.
- **`--deny <glob>`** is added to the role's `never_writes` for this run. On Linux a path has to exist to be
  closed, so a `--deny` on one that does not exist stops the run.
- **`--var NAME=value`** fills `$NAME` in `reads`, `toolchain`, `local_ports`, `verify` and `[runtime]
  writes`. Nowhere else: a variable cannot name a territory, a host, a key, or anything seisin executes.
  A run with a value missing for its role does not start. `check`, `explain` and the MCP server have no run
  to ask, so they leave that entry out, and `check` says which.

The role in the file is the most a run can have, and that is what a person reviews. What a run held under
is written to `<state-dir>/policies/<hash>.json`, and `<hash>` is the `policy` on its log lines. A line
with `event: "narrowed"` names the policy it came from, what it took away and which variables it was given,
by name. A folder with no `seisin.toml` or `seisin.json` of its own is read from there, so these runs need
nothing else to appear in this console.

An `--only` another one covers (`src/api/a.ts` beside `src/api/**`) is left out of the policy, which changes nothing
the run may write. Each path left costs rules in the sandbox's profile, and on macOS the profile has a size limit:
measured with a policy of 16 reads and paths of about 100 characters, 45 distinct paths start and 46 do not. Past it
the run does not start.

`--only` is refused before anything starts when the repo, or a path of the role, sits inside what `[runtime] writes`
gives every role as scratch (`/tmp` and `~/.cache` by default), because scratch is written around it. Move the repo,
or set `[runtime] writes` to a list that leaves it out. `--deny` closes its path inside scratch too.

A write refused only because of `--only` or `--deny` is in the log and not in the request queue: the role
already has it in the policy, so no grant could answer it. What the role does not have at all is still asked.
The agent is told the same: `--only` left it out of this run, no grant changes that, and nothing was queued.

## When `seisin run` is killed

A SIGTERM or SIGHUP is passed on to the agent. A SIGKILL runs no handler, and the agent has a process group of its own,
so a kill of seisin's group does not reach it. A small process outside the group and the sandbox holds a pipe from the
run, and if the pipe closes without the run having said it finished, it kills what it has followed from the runtime
down by parent pid, a child in its own session included.

Measured on macOS. **A process that double-forks is not caught**: once it has left the tree it cannot be found, and on
macOS there is no way to adopt orphans. It stays confined by the sandbox and can keep writing inside its territory. A
launcher with a folder only that run uses can look for what still has it open.

## Links

The console's link, as `seisin ui --runs` prints it:

```
http://127.0.0.1:4179/#t=<token>
```

One run: the same link with `&run=<run_id>` after the token:

```
http://127.0.0.1:4179/#t=<token>&run=01M5EXEC0A
```

The page takes the token and the run from the fragment, keeps the token for the tab and
leaves `?run=<run_id>` in the address, so a reload stays on the run. One server serves every
run: a panel links to each without starting anything per run.

`seisin ui --runs <dir> --link --json` prints, without starting or opening anything:

```json
{"running":true,"url":"http://127.0.0.1:4179/#t=…","port":4179,"mode":"runs","dir":"/…/runs"}
```

or `{"running":false,"port":4179}` when no console is up on that port. The URL carries the
token, so whatever reads it should hand it on as a link, never log it. The record it is read
from is a 0600 file under this user's runs root, removed when the console stops.

## How many

Measured on 2026-10-26 with 600 runs, 31 MB of logs copied from a real pilot (macOS, Node
24). The first read of the directory took **4–5 s**; the server starts it as soon as it
listens. After that each run is remembered by the signature of its files (stats only, no
directory listing), and a poll of `/api/runs` took **~0.2 s** warm, or less with a filter. A run
that is archived does not change, so it is never read twice.
