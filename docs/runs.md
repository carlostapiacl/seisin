# A console over many runs: `seisin ui --runs`

`seisin ui` reads one `seisin.toml` and its log. A launcher that lends every run a
territory of its own (an agent orchestrator that writes a policy per task, runs the agent
under it and then throws the worktree away) has no single policy to point it at. What it can
keep is each run's policy and log, copied out before the worktree goes. `seisin ui --runs`
reads a directory of those, read only:

```bash
seisin ui --runs <dir>                       # every run in <dir>, on 127.0.0.1:4179
seisin ui --runs <dir> --port 4300           # elsewhere
seisin ui --runs <dir> --link                # the link of the one already running
seisin ui --runs <dir> --link --json         # the same, for a program: nothing opened
```

The page lists every run, newest first, filtered by team, role, work item, status and
outcome. It sums what the shown runs were denied and what that cost in retries, and puts the
same denial in many runs on one line. A run opens as the console always looked: its policy,
its pending requests, its denials, its walls and its log.

## Read only

Nothing is written from this console. The territory was lent by whoever launched the run,
and a grant written into an archived `seisin.toml` would change nothing anywhere. So:

- every route that writes (`/api/decide`, `/api/decline-all`, `/api/control-files`) answers
  **405**, as does any method but `GET` and `HEAD`;
- the page draws no Grant, Decline or Decline all, and no control-files switch you can press.
  Where a request's buttons would be it says *Not granted here, ask for it in
  `<launcher>`*, with the path or the host;
- a request queue an older seisin left in the old form is shown as an error, never
  migrated. The console over one policy rewrites such a queue once; this one does not touch
  files that are not its own.

The token works as it does for `seisin ui`: it travels only in the link's fragment, never in
a response, and every `/api/` route asks for it.

## The directory: the contract

`<dir>` holds **one folder per run, named by the run's id.** That name is what `run=` takes,
so it may hold letters, digits, `.`, `_` and `-`, start with a letter or a digit, and run up
to 128 characters. Anything else in `<dir>` (a file, a folder with another name) is skipped.

```
<dir>/
  <run_id>/
    seisin.toml          the policy the run ran under, as it was written for it
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
| `launcher` | named in "ask for it in …" (e.g. `wapentake`) |

Beside the launcher's `status`, each run gets seisin's own `outcome`:

| outcome | when |
|---|---|
| `refused` | its canary failed: the boundary did not hold, nothing ran |
| `denied` | it ran, and was denied at least one file or host |
| `clean` | it ran, and was denied neither. The OS's own housekeeping (`kind: "system"`) and the canary's expected probes do not count |

A run whose system log dropped kernel messages (macOS, a flooded unified log) also says
**record incomplete**: the boundary held, but some of its denials may be missing from the log.
| `unread` | its `seisin.toml` is missing or does not load; the error is shown |

**When something is missing:**

- **No `run.json`**, or one that is not a JSON object: the run is listed under its folder's
  name, with no team, role, work item or status. Its start and end come from the first and
  last line of its log.
- **`.seisin/` missing or empty**: the run is listed as `clean` with nothing denied. A log is
  what says otherwise.
- **No `seisin.toml`**, or one that does not parse: the run is listed as `unread`, with the
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
