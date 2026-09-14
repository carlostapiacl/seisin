# Decisions

> Why the tool is shaped the way it is, including the roads not taken. Each of
> these was a real fork with a defensible other side; a reader who disagrees
> should be able to see exactly where.

## The split: the kernel enforces, seisin explains

Everything else follows from this. Enforcement is
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)
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

**Measured afterwards, and it is stronger than the refusal assumed.** The open question was
whether a nested box could only ever intersect with the one around it. It cannot nest at all:
macOS refuses to apply a second Seatbelt profile to an already-sandboxed process, with
`sandbox_apply: Operation not permitted`, and that is the OS and not this tool —

```
sandbox-exec -p '(version 1)(allow default)' sh -c "sandbox-exec -p '(version 1)(allow default)' sh -c 'echo hi'"
  sandbox-exec: sandbox_apply: Operation not permitted
```

— with the most permissive profile that can be written, on both layers. So the refusal in
`seisin run` is not a policy choice about a thing that might have worked; it names something
the platform does not offer.

**The consequence for agents that sandbox themselves:** an agent that applies its own Seatbelt
profile per command — `codex` does, via `sandbox-exec` — cannot do so inside seisin. Every
command it tries to confine fails to start. Such an agent has to run with its own sandbox
turned off, because the boundary is already there and only one can exist.

## The refusal names the queue, and never the MCP

A denial already files a permission request — and until now it did so silently,
so nothing inside the box knew anything was pending. An agent could not tell the
person who sent it that the work was waiting on an approval rather than simply
impossible. The sentence now ends with *"Already queued for a person to answer —
retrying or waiting will not move it."*

Both halves earn their place. **Retrying**, because the queue deduplicates: a
second attempt at the same grant raises a counter and produces nothing new.
**Waiting**, because nothing reachable from inside the sandbox can approve, by
the design two sections above — an agent that settles in to wait is an agent
that has stopped working.

Rejected: naming the MCP server in the same sentence. The hook cannot know
whether one is configured — `wire` writes `.claude/settings.json` and MCP
servers live in a different file — so the choice was between saying it always
and guessing. Saying it always hands an agent that does not hold the tools a
name to go looking for, which costs it a turn to learn it has nothing. An agent
that *does* hold them discovers them the ordinary way, which is what tool
descriptions are for; `seisin_requests` and `seisin_draft_grant` now say when to
reach for them rather than only what they do.

There is a test for the absence, not only for the presence. A decision that is
only a paragraph gets undone by the next person who thinks the sentence could be
more helpful.

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
- **A role still holds its keys in plaintext, and it need not.** `keys` names a
  file the role reads, so the value is in the agent's context from the first
  read — and from there it can leave by any allowed domain. The enforcement
  runtime already implements the alternative: `credentials.envVars` with
  `mode: "mask"` hands the process a sentinel and substitutes the real bytes at
  egress, only toward the declared `injectHosts`. Re-measured on 0.0.76 against
  the `srt` binary on 2026-09-14, with a toy token and two reflecting hosts: the
  process sees `fake_value_…`, the host named in `injectHosts` receives the real
  value, and **a host that is allowed by the network policy but not declared for
  that credential receives the sentinel**. It is declarable from the settings
  file, so seisin could emit it without embedding the library.

  **The field name is load-bearing, and the wrong one fails in a way that looks
  like the feature is absent.** It is `credentials.envVars`; `credentials.env` is
  rejected as an unrecognized key, and `credentials.files` — the shape that looks
  closest to what `keys` already is — makes the file unreadable on macOS rather
  than masking it, so `cat` returns `Operation not permitted` and no sentinel ever
  appears. Both of those read as "masking does not work". Neither is a measurement
  of masking.

  **What it costs, which the paragraph above does not price.** `mode: "mask"` does
  not load on its own: the runtime refuses the config unless
  `network.tlsTerminate` is set, or `credentials.allowPlaintextInject` opts out.
  `tlsTerminate` is marked experimental and it is TLS MITM — the runtime
  terminates the role's HTTPS with a CA of its own and re-originates it, which is
  the only way it can see a header well enough to substitute one. That is not a
  field to fill in. It is reading all of the role's encrypted traffic, and it
  arrives as a condition of using the feature rather than as a choice.

  The opt-out is not one. Measured the same day: with `allowPlaintextInject` and
  no `tlsTerminate`, an HTTPS request to the host named in `injectHosts` carries
  the **sentinel**, not the real value — nothing can substitute inside a TLS
  session it cannot read. So over HTTPS, which is all the traffic that matters,
  the plaintext escape is `mode: "deny"` with extra steps: the role loses the
  secret and loses the capability too. Adopting masking means adopting the MITM.

  Not done, and the reason is that it is not a new field. Masking works for
  environment variables; on macOS the file form makes the file unreadable
  instead, because substituting file contents needs a mount that Seatbelt does
  not have. So adopting it changes what a key *is* — from a path the role reads
  to a variable with declared destinations — and that is a config break, not an
  option. The env-var form is the one to build: it behaves the same on both
  platforms, where a file-only path would be Linux-only and untested.

  And the config break is now the smaller half of the decision. The trade is:
  a role stops holding its tokens, and in exchange every role that holds one runs
  its HTTPS through an interception layer this project does not own, described by
  its own authors as experimental. Whoever weighs that should weigh it against
  what masking actually buys — which is the next paragraph, and it is less than
  it looks.

  **It closes half of a hole, and the half it does not close is the larger
  one.** Masking protects the credentials this policy declares. It does nothing
  about `~/.ssh`, `~/.aws` or `~/.npmrc`, which are ordinary readable files to
  every role unless `isolate` is on — see the section above. Whoever weighs
  these should weigh them together.
