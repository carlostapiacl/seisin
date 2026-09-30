# Field notes: what running agents behind a boundary actually measured

> Everything on this page is a number from one real deployment — four teams of coding
> agents working on their author's own repositories, on one machine, for months. Where a
> number comes from someone else's instrument and not from seisin, it says so. Where it did
> not reproduce when I went back to check, it says that too, because a page of only the
> convenient measurements is advertising.

This is not a benchmark and there is nothing here to win. It is the other half of
[what it has been put through](what-it-has-been-put-through.md): that page asks whether the
tool does what it claims, this one asks what happened to the people and processes that used
it.

**Why publish it.** Everyone in this space publishes the mechanism and nobody publishes the
cost. That makes every write-up sound the same and leaves the one question a person running it has
— *what will this actually do to my day* — answered by anecdote. The numbers below are the
answer for one deployment. They will not be yours. They are at least somebody's.

---

## The setup

Four teams of agents, each a handful of roles with their own territory, working
against real repositories with real deadlines. (A *team* here is a handful of roles working
one set of repositories; seisin has no such object.) Roles run confined by
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) with a
policy seisin writes; a hook records what was attempted and names the owner of the path.

The policy in question, to give the numbers a scale: 31 roles, 1,892 path globs, a
106 KB `seisin.toml`. Not a demo.

Two instruments produced what follows, and they are not the same thing:

| | what it sees |
|---|---|
| **seisin's own log** | what the **kernel** denied, and what the hook decided, per role and path |
| **the deployment's pre-flight checker** | the agent harness's own checks before a tool call, which predate seisin and are not part of it |

Numbers from the second are marked. They are here because they are what made the case for
the first.

---

## 1 · Three quarters of everything the kernel denied was one lock file

Six days, every denial the kernel recorded:

| | |
|---:|---|
| **1,422** | reads and writes denied |
| **1,080** | of them on `.git/index.lock` — **75.9%** |
| **1,094** | on any path under `.git/` — 76.9% |
| **10** | distinct roles hit the boundary |

The top six targets were the same file in six different repositories. One role produced
1,061 of the 1,422 events by itself.

**None of it was a territory question.** `git status` and `git diff` refresh the index as a
courtesy, refreshing it takes the lock, and a role reading a repository it does not own
trips the boundary while doing nothing but looking. A person granting those is arbitrating
a mutex.

The fix was not a wider grant. It was `GIT_OPTIONAL_LOCKS=0`, which turns the courtesy off:
`status` stops touching the index, while `add`, `commit` and `checkout -b` still take the
locks they need. It removes the need for the grant instead of widening one — the
boundary does not move — and it deletes three quarters of the noise.

> The lesson generalises past git. Before you design a mechanism to handle a flood of
> requests, find out what the flood is made of. Ours was one file.

## 2 · What reached a person was one thing, and it was the right thing

Over the same window the queue of requests waiting on a person held **one** entry: a role in
one team wanting to write into another team's working directory, a path with nine declared
owners.

That is worth sitting with, because the obvious design conclusion from §1 is wrong. The
plumbing never reached a person. It stayed as kernel denials the role absorbed by itself,
and deduplication by `role:action:prefix` collapsed 1,445 recorded asks into a queue you can
read in ten seconds.

**The thing that saved a person's attention was not a new concept. It was a `GROUP BY`.**

## 3 · A denial that is correct and unheard still costs you

Measured by the deployment's own pre-flight checker, not by seisin: of **345 denials, 88 — 25% — were a
repeat of something that role had already been denied.** One role spent 37 tool calls on
two walls, hitting one of them nineteen times.

Not one of the 345 was a false positive. The boundary was right every single time, and it
still cost a quarter of the calls it touched, because **correct** and **heard** are
different properties and only the first one was being measured.

This is why `seisin walls` and the counter in the denial exist. It is also the finding I
would most expect to generalise: every permission layer measures precision and none of them
measures whether the agent understood.

**And the counter's effect is still unmeasured, for a reason worth copying down.** The test
would be repeats before and after — but 86% of the repeats in the kernel log were one lock
file, and the previous release removed that wall entirely. Repeats fell from 684 in a day to
18; almost all of that is the wall going away. Two improvements landed days apart and the
larger one ate the other's test case. What is left to measure the sentence against is the
remaining 24%, spread thin, in teams where the hook is not always wired. So: built, shipped,
and not yet shown to work — which is a different sentence from the one a changelog usually
writes.

## 4 · The cost of not knowing whose it was, in requests

Also from the deployment's pre-flight checker. Its ownership map only covered the team it ran in, so for
a file owned by a role in another team it reported `owner: —` — the same string it used for
a file nobody owned. Those two need opposite responses: one means *claim it*, the other
means *go ask*.

**294 of 915 denials carried that empty owner.** The visible cost: one role asked another to
edit a single file **45 times — 23% of every request the team made in the window** — when
the owner was in a different team entirely and was never asked.

That is the whole argument for answering *whose is it* rather than just *no*, priced.

## 5 · The key mechanism was there the whole time and nobody used it

The most uncomfortable number on this page, and the reason `file://` is now built in.

| | measured 2026-09-21 |
|---:|---|
| **31 of 31** | roles declare `keys = []` |
| **151** | credential-shaped files outside the protected directories |
| **134** | of those readable by any process on the machine |
| **13** | flagged by `seisin scan` as certainly a credential |

*Method: the 151 and 134 are `find` by name — `.env`, `*.env`, `*.pem`, `*.key` — excluding
`node_modules`, `.git` and the declared key directories, with `-perm -o+r` for the second.
The 13 is `seisin scan`, which reads content shapes rather than names. The gap between the
methods is the point: names over-count, content under-counts what it is unsure of, and
neither is the truth on its own.*

The key directories were declared only so that `seisin scan` would not walk them. The
mechanism for scoping a secret to one role existed, was documented, and had zero users in
the deployment that built it.

The lesson is not "people are careless". It is that the mechanism asked for a file path,
and the secrets people actually have are either in a vault with no path, or in a `.env`
holding twelve variables where granting the file grants all twelve. The feature was shaped
for a situation that does not occur.

## 6 · What asking costs, and a number that did not reproduce

An internal note recorded `seisin whose` at **166 ms**. Re-measured on 2026-09-21 against
the same policy, it does not reproduce. What does, on that machine, as a median of 15 runs:

| | median |
|---|---:|
| `node -e ''` — the runtime starting, nothing else | 144 ms |
| `seisin --version` — plus loading seisin's modules | 356 ms |
| `seisin whose <path>` — plus reading and evaluating the 106 KB policy | 536 ms |

So roughly 210 ms of module loading and 180 ms of policy work, on a laptop that was not
idle. The original figure may have come from a quieter machine or a smaller policy — the
policy has grown since — but I cannot reproduce it, so it does not get to stand.

The conclusion the old number supported does survive, and it is the useful part: put the
question on the denial path, not on every call. At one query per tool call this would be
hours of pure latency across a window; asked only when something was denied, it was 915
queries over 378 runs. Whatever the per-call figure is on your machine, that ratio is the
design.

*(210 ms to load the modules of a CLI that a hook calls on every denial is not good, and it
is not a measurement problem. It is on the list.)*

---

## Measure even when you are confident

The deployment's other machinery taught the same lesson more than once: the obviously-better
change measured worse, and only measuring said so.

---

## Reproducing any of this

Nothing here needs the deployment. Against your own policy and log:

```bash
seisin check                  # the map, and every way it does not hold
seisin scan                   # credential shapes outside the declared key directories
seisin review                 # what the log says about the policy, as arithmetic
seisin walls <role>           # what that role keeps being denied, and what retrying cost
seisin log --verdict denied   # the raw record
```

The composition in §1 is that last command, grouped by target. If you run it and three
quarters of your denials are also one file, you did not need a new concept either.

## What this page is not

It is one deployment, one person, one machine, one toolchain, and every number is from a
system whose author also wrote the tool being measured. Nothing here is a controlled
comparison and none of it says seisin is better than an alternative — no alternative was run
against the same work. Treat it as a case, not as evidence.

If you run something similar and your numbers differ, that is worth more to this repository
than agreement. Open an issue.
