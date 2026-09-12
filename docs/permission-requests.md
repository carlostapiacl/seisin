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

### Why the console may approve and the MCP server may not

Both run on the operator's machine, so the distinction has to be more than
intent. It is: **a confined role cannot reach the console.**

Measured, not assumed. From inside the box, `curl` against the console's own
port on loopback gets exactly what it gets from a domain outside its allowlist —
the egress proxy makes no exception for `127.0.0.1`:

```
console on 127.0.0.1     000   blocked
api.anthropic.com        404   reached — it is in the allowlist
example.com              000   blocked
```

The MCP server is the opposite by construction: it speaks on the agent's own
stdio. Anything it can do, the agent can cause. So the split is not a policy
about who *should* approve, it is a fact about who *can* reach the channel.

One more thing had to be true, and was not for free. Loopback is no boundary
against the browser — any page the operator has open can POST to `127.0.0.1`.
So `seisin ui` mints a token per run, inlines it into the page it serves, and
demands it back on the only endpoint that writes. A tab from somewhere else
cannot read it, and asking for it in a custom header also forces a preflight
this server never answers.

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

And "append-only" is now enforced rather than asserted. It was not, for a while:
`.seisin/` sat in every role's allowWrite because the hook runs inside the box
and has to record what it decided — so the queue was writable by the processes
it is a record of, and a request could be truncated, rewritten or invented. The
file said the word and nothing held it up.

The directory left the territory and a socket took its place. The hook sends a
line to `seisin run`, which holds the file; `allowUnixSockets` grants that one
socket path, so it is a channel rather than an opening. From inside, the only
verb is *send one line* — there is no descriptor, so no seek, truncate or
unlink.

The honest limit: a hostile agent can still send lines, so it can pad its own
queue. It cannot erase or alter what is already there. Forgery and tampering are
different problems and only the second one is closed here.

## The MCP server

`seisin mcp` speaks the Model Context Protocol on stdio, so your own assistant
can answer "who owns `src/api`?" and "what is frontend waiting on?" without you
opening a config.

It is read-only **by construction**, not by policy. Nothing on disk is opened
for writing by that process. `seisin_draft_grant` returns the change as text and
the command a person runs; it does not stage a proposal file, because a staged
file is one `mv` away from being policy and the last step is supposed to belong
to a human in a channel the agent does not have.

```jsonc
// .mcp.json, or wherever your client keeps servers
{ "mcpServers": { "seisin": { "command": "seisin", "args": ["mcp"] } } }
```

| tool | answers |
|---|---|
| `seisin_state` | the whole map, plus every way it does not hold |
| `seisin_explain` | may this role touch this path, and whose is it |
| `seisin_requests` | what is waiting on a person |
| `seisin_activity` | recent allow/deny decisions |
| `seisin_draft_grant` | the change a request would make — as text, not applied |

A test asserts that no tool name in that list mutates anything. If somebody adds
`seisin_grant`, the suite goes red before it reaches a release, which is the
difference between an invariant and a paragraph.

### Why it has no SDK

The official MCP SDK pulls **91 packages and 26 MB** (measured against 1.30.0)
— express, hono, cors, jose
— for a server that exchanges line-delimited JSON on two file descriptors. In a
tool people install to *reduce* their attack surface, every transitive
dependency is the thing they were trying to avoid.

The cost is honest and worth stating: the protocol is tracked by hand, and it
moves — the 2026-07-28 revision made the core stateless and moved the handshake
into `_meta`. For a stdio server with read-only tools the shape of
`tools/list` and `tools/call` did not change, which is the only reason this is
defensible. `PROTOCOLS` in `src/mcp.js` is where a break would surface first.

## What this is not

- **Not an approval workflow.** There are no roles, no delegation, no
  notifications to other people. One operator, one machine.
- **Not a way to run unattended.** If nobody approves, nothing is granted and the
  agent stays confined. That is the correct failure.
- **Not a replacement for writing the policy.** `init --from-observations` is
  still the right way to start; requests are for the long tail that observation
  did not see.
