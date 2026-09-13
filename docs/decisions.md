# Decisions

> Why the tool is shaped the way it is, including the roads not taken. Each of
> these was a real fork with a defensible other side; a reader who disagrees
> should be able to see exactly where.

## The split: the kernel enforces, seisin explains

Everything else follows from this. Enforcement is
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)
asking the OS; seisin decides what to ask for and says whose file it was.

It is why the hook is allowed to be imperfect. A hook that misreads a shell
command costs an explanation, never a boundary — what escapes it goes
**unexplained, not unblocked**. Every design question below was settled by
asking which side of that line it falls on.

## A permission layer, not a sandbox

Leading with "sandbox" puts this beside containers, microVMs and gVisor, where
it loses on the only axis that comparison measures — and it is not trying to
win there. Two agents in one container are back where they started: same files,
same keys, no answer to *whose is it*.

Rejected along with it: naming a new category ("Agent Permission Layer", "RBAC
for repos"). A category nobody has heard of has to be explained before the tool
can be, and [a three-row table](../README.md#why-not-a-container) does the same
work without asking the reader to learn vocabulary.

## MIT, not Apache-2.0

Apache-2.0 was the real alternative and it has two things MIT does not: an
explicit patent grant, in a field where large players are patenting, and a
matching licence with the dependency.

MIT wins on the goal. It is the licence a legal team approves without opening a
ticket, and the whole point is that someone tries this on a Tuesday afternoon
without asking anyone. The all-caps disclaimer is the clause that matters most
here anyway: this is a security tool whose README says it holds against an agent
that is wrong, not one that is trying.

The moment to revisit is a company asking about patents — not before. There is
one catch worth knowing: today the copyright is held by one person, so
relicensing is still possible. **That ends at the first merged pull request.**

## Refusing beats widening, twice

Two places refuse rather than guess, for the same reason.

A write pattern the kernel cannot express exactly — `src/*`, meaning one level
down — is **refused**. A sandbox grants prefixes and "one level down" is not a
prefix, so there is no exact translation waiting to be written. The old
behaviour handed the kernel the whole subtree while `seisin explain` reported
the narrow pattern: the document was tighter than the boundary, which is the one
direction a permission tool must never fail in.

The config generator does the same with paths that leave the cell, and the
principle is stated in the field report that prompted it: *if refusing is easier
than computing the escape, refusing is the better bug.* Where computing it is
exact, compute it; where it is ambiguous, refuse.

## `isolate` is off by default, and that is the threat model

With `[runtime] isolate = true` each role gets its own HOME, TMPDIR and XDG
directories, and reading closes as well as writing — `~/.ssh`, `~/.aws`,
`~/.npmrc` and the other roles' homes all go dark.

Off by default, because turning it on makes every CLI in the box see an empty
home and ask to log in again. A permission tool that silently signs you out is
one people uninstall.

Rejected: splitting the product into `mode = "team"` and `mode = "hostile"`.
That is two names for the switch that already exists, and it implies a "hostile"
mode is *safe against hostile agents*, which this is not. **Which of the two you
want is the threat model** — so it is a line in the config and a paragraph, not
a brand.

On the read side specifically: denies of the places credentials live, not a
read allowlist. A default-deny read set has to enumerate every interpreter,
library and cache a toolchain touches, gets one wrong, and fails as an
unexplainable crash inside the agent. Narrower than the ideal, and it holds up.

## Approving is not a tool call

The MCP server can read state, read the queue and draft the exact change. It
cannot grant. If it could, an agent holding that tool could widen its own
territory and the record would say a human did it.

The console *can* approve, and the difference is checkable rather than a matter
of trust: **a confined role cannot reach the console.** Measured — `curl`
against its port on loopback returns nothing, the same as a domain outside the
allowlist. The MCP server is the opposite by construction: it speaks on the
agent's own stdio. The split is a fact about reach.

## `review` does arithmetic, and nothing else

No model, no network, no heuristics. The argument this tool makes is that
interpreting text is the wrong way to decide things — a component that reads the
log and forms an opinion would contradict it on the way in, and add a network
dependency to a tool people install to reduce their attack surface.

What arithmetic buys: **permissions granted and never used**. Every permission
file only ever grows, everywhere, because nobody can prove a line is dead. The
log can prove it.

## No SDK for the MCP server

The official SDK is 91 packages and 26 MB — express, hono, cors, jose — for a
server exchanging line-delimited JSON on two file descriptors. In a tool people
install to reduce their attack surface, every transitive dependency is the thing
they were trying to avoid.

The honest cost: the protocol is tracked by hand and it moves. `PROTOCOLS` in
`src/mcp.js` is where a break surfaces first.

## seisin does not nest, and refuses instead of trying

`seisin run qa -- seisin run dev -- …` is refused by name. It was measured in both directions,
with the inner role both wider and narrower than the outer one, and it never worked: the inner
run died in the runtime with `rc=13` and a Node warning about an unsettled await — no role
named, no boundary named, reading as seisin crashing rather than as a refusal. Before that it
failed one step earlier, on a `$TMPDIR` the outer box had already reshaped.

Making it work was the other side of the fork, and it was not taken, because the shape that
reaches for it is usually the wrong one. The case is a dispatcher that starts roles: an
orchestrator, a launcher, a queue runner. Putting that dispatcher *inside* a box makes every
worker a descendant of it — and the dispatcher is the role that should hold the least, since
it decides who works rather than doing the work. Whatever a second box would hold there, it is
not "its own territory", and a permission tool should not be vague about that.

So the shape the refusal points at is siblings, not descendants: the dispatcher sits above the
roles and is *asked* to start one, rather than running inside one and spawning it. That keeps
the narrow-privilege argument for the dispatcher intact — fixed executable, fixed cwd,
sanitised env, role from an allowlist — while leaving each worker's territory decided by the
policy rather than by whoever happened to launch it.

**What is still unmeasured, and the refusal does not claim otherwise:** whether a nested box
could only ever intersect with the one around it. That is a property of the sandbox runtime,
not of seisin, and nothing here has tested it — the inner run never got far enough to try.

## Still open

- **The queue says "refused" and means "asked for".** An agent can file a
  request for its own role without having been denied anything. The wording
  should be settled before it hardens across the UI, the MCP and the README.
- **Deleting inside your own territory** is not covered and not coverable here.
  [The ask is upstream](upstream/denyUnlink.md).
- **Forgery in the audit trail.** Tampering is closed; a hostile agent can still
  add lines to its own history.
- **No resource limits.** CPU, memory, PIDs and disk are unbounded. The boundary
  is about what an agent can reach, not how much of it there is.
