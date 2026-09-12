# Permission requests

> How a denial stops being a dead end, and why approving one is deliberately
> not something an agent can do.

## The problem

A permission tool that can only say no is a tool people uninstall.

The loop today: the agent is denied, the turn stops, you go and edit a config,
you run it again. That is three context switches for one line of policy, and it
happens most often at exactly the wrong moment — mid-task, when you were
watching something else.

Worse, it teaches the wrong reflex. The cheapest way to make the error go away
is to widen the policy generously, once, and never look again. That is how a
permission file becomes seven hundred `allow` entries that nobody can read.

## The inversion

A denial already contains everything a request needs. The hook knows which role
asked, what it wanted, and who owns it. So it writes that down:

```
agent denied  →  the hook records a request
              →  you see it where you already are
              →  you approve or refuse, by hand
              →  the next run has it
```

Nothing about the enforcement changes. The kernel still refuses, the turn still
stops. What changes is that the refusal leaves something behind that a human can
act on in one command instead of in an editor.

## The invariant

> **Approving is not a tool call.**

This is the line the whole design hangs from. If granting a permission were an
MCP tool, an agent holding that tool could widen its own territory, and the
record would say a human did it. Every audit trail after that point is fiction.

So the channels are split, and the split is the feature:

| channel | can do | cannot do |
|---|---|---|
| the MCP server | read state, read pending requests, **draft** a proposal | grant anything |
| the console (UI) | everything above, plus **approve** | — |
| the CLI | everything above, plus **approve** | — |

An agent can ask, and can even write the exact diff it wants. Turning that into
policy requires a person acting in a channel the agent does not have.

This is also why the UI is not where approval is *hosted* — it is one of two
places where a human can do it. The other is a terminal, which matters because
the tool has to work for someone who never opens the console.

## The hook writes the request, not the agent

The agent could describe *why* it wants the path, which would be richer. It does
not, for two reasons.

First, it would need a tool to do it, and giving the confined process a channel
to the thing confining it is the shape of every sandbox escape ever written.

Second, a motive supplied by the requester is the least reliable field in the
record. The useful motive is the one written by whoever approves — *"yes,
frontend owns the checkout flow now"* — because that is the sentence someone
will need in three months.

So the hook records facts it already has: role, action, path, owners, when, how
many times. The reason belongs to the approval.

## Where the notification lives

A queue nobody opens is not human-in-the-loop.

There is no daemon and no always-on requirement. Instead the notice rides on
what you are already looking at: `seisin run` prints pending requests when the
run ends, in the same terminal that just showed you the denial.

The console and the MCP are conveniences on the same file. None of the three is
required for the tool to work, which is the property that lets someone install
this without adopting a process.

## Provenance

A grant records who asked, how many times, and who approved it — in the config,
as a comment, next to the line it added.

```toml
[roles.frontend]
writes = [
  "src/web/**",
  "src/api/checkout/**",   # granted 2026-09-12 · asked 3× · "frontend owns checkout now"
]
```

Without this, a policy file is a list of permissions with no history, and the
only safe operation on a line nobody remembers is to leave it there. That is the
mechanism by which permission files only ever grow.

## The file

`.seisin/requests.jsonl`, append-only, beside the log.

Append-only matters for the same reason it does for the log: a decision that can
be rewritten is not evidence. A granted or refused request is not deleted, it is
followed by a line saying what happened to it.

## What this is not

- **Not an approval workflow.** There are no roles, no delegation, no
  notifications to other people. One operator, one machine.
- **Not a way to run unattended.** If nobody approves, nothing is granted and the
  agent stays confined. That is the correct failure.
- **Not a replacement for writing the policy.** `init --from-observations` is
  still the right way to start; requests are for the long tail that observation
  did not see.
