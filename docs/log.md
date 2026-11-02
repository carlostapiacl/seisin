# The log, the console, the MCP server and walls

## Seeing what happened

```bash
seisin log --verdict denied      # what the agents tried and could not do
seisin watch                     # follow it live
seisin ui                        # the same thing, for a person deciding
```

```
$ seisin log

  04:13:26  allowed  frontend write src/web/app.ts
  04:13:26  denied   frontend write src/api/orders.ts  → backend
  04:13:27  denied   frontend read .secrets/database-url.txt  → backend
  04:13:31  denied   frontend write src/api/orders.ts  → backend  [kernel]

  4 entries · 3 denied
```

`[kernel]` marks a line the kernel reported; the others came from the hook.

One append-only JSONL under `.seisin/`, and that is the whole storage design — no daemon, no
database, and `watch` is a tail. A run started with a W3C `TRACEPARENT` (a launcher's trace)
stamps its `trace_id` and `span_id` on every line, so the log joins that trace in any
OpenTelemetry tool.

Each line carries the hash of the one before it, and the first time a chained line is written
the start of the chain is recorded beside the log (`log.jsonl.genesis`). `seisin log verify`
checks both, so a line edited, removed or reordered breaks it, and so does stripping the chain
from every line to make the log read as one written before chaining:

```
$ seisin log verify

  broken  4 chained line(s), 2 break(s):
    line 1: expected prev 106c24967e0bdde077d73073b648f218, found 43918a17f2089effc44394a72e4289e9
    line 2: expected prev 43918a17f2089effc44394a72e4289e9, found 106c24967e0bdde077d73073b648f218
  a line was edited, removed or reordered just before each of these
```

Tamper-evident, not tamper-proof: whoever can write `.seisin/` could rewrite both files
together, which is why no role can write it.

**The agent cannot reach that file.** `.seisin/` is in no role's territory, because a record
the recorded process can edit is not a record. The hook sends each line to `seisin run` over
a unix socket granted by path and the parent does the writing, so the only verb available
from inside the sandbox is *append one line*. A hostile agent can still add noise to its own
history; what it cannot do is change what is already there.

**Two writers, and they see different things.** The **hook** reports the attempt before it
happens — which is how an *allowed* action gets recorded at all — and it is text-based and
evadable, on purpose. The **kernel** reports what it actually denied, and is not fooled by
anything. What escapes the hook goes unexplained, never unenforced.

![the console: requests waiting on a person, a grant that needs a reason and a second click for another role's path, the line it wrote, the denials grouped by path with the kind of each unowned one, the walls each role keeps hitting, the roles, and a control-files change shown before it is saved](https://raw.githubusercontent.com/carlostapiacl/seisin/main/docs/img/console.gif)

It opens on what needs a decision, not on the policy. Four numbers sit on top — waiting on
you, denied, the **top cause**, and calls **spent retrying** walls — each a link to the page
that explains it, and the last two are recomputed against the policy, which a log alone cannot
do: something granted since stops counting.

**A decision needs a reason.** Grant without one asks for it; Decline without one fills in
a default and asks again, so what is recorded is on screen first. The request says what a
grant covers before the click — *asked for `src/api/routes.ts` → granting
covers all of `src/api/**`*, and whose it is today. Sharing another role's territory takes a
second click that names it. After it, the console shows the line it wrote to `seisin.toml`
and where.

**Denied and Walls say the same thing about one path.** A path no role owns says what kind
of thing it is — *ownable*, or git's, temporary, build output, a credential — and the move
that fits each, which for all but the first is not an owner.

**Live, the roles are read-only:** territories and keys change in `seisin.toml`. The two
writes are decisions and the control files: beside each role, a toggle for each family it can
be handed (editor settings, instruction files), and one for `[protect] instructions`. A
toggle saves nothing. It shows the sandbox settings each role gains or loses and the exact
line it would write, and a second button, with a reason, saves it. If the server stops, the
page says *offline* and turns every write off until it answers again.


## What the log says about the policy

`check` reads the config and tells you what it would do. `review` reads what
actually happened and tells you where the config was wrong about it.

```
$ seisin review

  60 entries, 2026-08-23 to 2026-09-11

  Denied repeatedly
  a role denied on the same place over and over is a policy that is wrong,
  not an agent that is misbehaving

       9×  frontend write src/api/checkout — belongs to backend
       4×  backend write src/web — belongs to frontend

  seisin grant, or move the territory. Either way it is a decision, not noise.

  Granted, never used
  nothing was written here in the window above. This is the only evidence
  anyone will ever have for making a policy smaller

    frontend  public/**
    backend  migrations/**

  A short window proves nothing. Check the dates before you delete a line.

  Unowned
  touched by an agent, claimed by no role. Only an ownable path (kind `territory`)
  is a hole in the map; the rest is a kind of thing with its own answer, and none
  of them is an owner

       4×  territory  legacy

  territory: an ownable path no role claims: a real decision — give it an owner, or tell the agent not to write there
```

`--since 2026-10-01` or `--since 7d` reads only that stretch of the log: on a log months long,
"Denied repeatedly" is otherwise led by paths fixed long ago. A denial that is correct and needs
nothing — Claude Code updating its plugins from inside the sandbox — is listed apart as "Denied as
expected" and does not make `review` exit 1.

Three questions, and the middle one matters most. **Every
permission file only ever grows**, in every system, and always for the same
reason: nobody can prove a line is dead, so the safe move is to leave it. Here
the log can prove it — `public/**` was granted and nothing was written there in
three weeks. That is the only direction that makes a policy *smaller*.

The first is the one that changes how a denial reads. Forty denials on one
directory is not an agent misbehaving; it is a policy that is wrong, and until
you add them up it looks like forty tidy amber lines.

It is arithmetic over the log, with no model, network or heuristics: seisin's
whole argument is that interpreting text is the wrong way to decide things. Every finding carries the window it was computed
over, because *never used* means nothing without *in how long*.


## When the boundary is right and the agent cannot hear it

seisin answers *whose is this* at the moment of the denial — once, mid-turn — and then the
sentence is gone. Nothing carries it forward, so the agent tries again.

Measured in the author's own multi-agent setup: of **345 denials, 88 (25%) were a repeat of something that same role
had already been denied.** One role spent 37 calls on two walls, hitting one of them nineteen
times. Every denial was correct, and it still cost thirty-seven calls.

So a denial now carries its own history:

```
deploy/x.yml belongs to infra. It is not dev's to change. It is handed to infra: hand it
over rather than working around it. Do not put the change somewhere else instead (another
path, a copy, /tmp). You have been denied this 3 times now; it is not going to work on the
fourth try. Already queued as a handoff to infra…
```

And the standing list is a command:

```
$ seisin walls dev

  dev keeps hitting:

     19×  write ../shared/.git/index.lock  belongs to platform
      6×  read ~/.npmrc  no role declares ~/.npmrc — add it under a [roles.<name>] keys list

  23 of its calls went into retrying these.
```

That is the list said to the person at the terminal. The agent gets it in its own voice, at the
start of every session the hook is wired for:

```
Already denied more than once, and still denied — do not try again, hand it over:
- write ../shared/.git/index.lock (19×) — belongs to platform
- read ~/.npmrc (6×) — no role declares ~/.npmrc — add it under a [roles.<name>] keys list
```

and, on request, as data from the MCP server's `seisin_walls`. In a run handed along a chain, a
wall where the chain stops is listed without its owner: a person decides it, and the agent is
to pass on the one sentence its denial gives ([where a request goes](https://github.com/carlostapiacl/seisin/blob/main/docs/requests.md#where-a-request-goes)).

**A wall is recomputed against the policy, not read out of the log.** If the role would be
allowed today, it is not a wall — whatever happened yesterday. The obvious implementation is a
time window, on the argument that an old wall may have been granted since; the window is a
proxy for the question, and seisin has the policy right there, so it asks the question. A grant
makes its wall disappear on the next run instead of when a window expires. Same move as
`owners` and the request queue: recompute rather than believe.

Silent on the first denial, by design. A counter that reads `1×` every time is noise on the
turn where the sentence is already doing its job.

**Whether it makes an agent stop is not demonstrated, and will not be for a while.** The
obvious way to check is to compare repeats before and after — but the repeats were 86% one
lock file, and the release before this one deleted that wall outright with
`GIT_OPTIONAL_LOCKS=0`. Repeats did fall, by a lot, and **the fall is the wall going away,
not the sentence landing**: both shipped within days of each other and the bigger cause is the
other one. Isolating this needs a forward test (walls per role, runs with the hook wired
and no git locks in the way), not the history.


## Ask your own assistant

```jsonc
{ "mcpServers": { "seisin": { "command": "seisin", "args": ["mcp"] } } }
```

> *who owns src/api, and what is frontend waiting on?*

Seven tools. Four answer about the policy — `state`, `explain`, `requests`, `draft_grant` —
and three about what has happened: `activity` is the raw log, and **`causes` and `walls` are
the two an agent actually wants.** `activity` hands over events and leaves the assistant to
re-derive the shape without the policy; `causes` returns the day grouped by path and by name
with how many are on paths nobody owns, and `walls` returns what a role keeps being denied
*and would still be denied today*. Both are recomputed against the policy, so something
granted since stops counting — which is the part a log cannot know.

Read-only **by construction** — the server opens nothing for writing, and a test
asserts that no tool in it mutates anything. It can draft the exact change a
request would make; applying it is a command a person runs. Zero dependencies:
the official SDK wanted 91 packages for a server that speaks JSON on two file
descriptors.


