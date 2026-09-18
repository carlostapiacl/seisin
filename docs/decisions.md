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

## Refusing beats widening — twice, and once it would have been the wrong answer

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

**And the third case, found later, is the one where refusing would have been
wrong.** `writes = ["src/api"]` — a folder, no glob — was read by `covers()` as
that path and nothing else, while `toWritePath` handed `src/api` to the kernel
unchanged, where `allowWrite` is a prefix. Measured:

```
seisin explain dev write src/api/x.ts          denied — "has no owner"
seisin run dev -- sh -c 'echo > src/api/x.ts'  the file is written
```

Same failure as `src/*` and worse to live with, because nothing looked wrong.
The `src/*` version at least produced a pattern somebody had written oddly;
this one had `whose` reporting the path as **unowned** — telling a reader it was
protected — while a role could write it, and telling an agent to hand off work
that was already its own.

The fix is not a refusal, and the difference is exactly the rule above. "One
level down" has no exact translation into a prefix, so it is refused. A subtree
*is* a prefix — the kernel was already enforcing it correctly, and the only
thing missing was seisin saying the same thing. So `covers()` now reads a
wildcard-free pattern as the path and everything under it, which is what
`src/api`, `src/api/` and `src/api/**` have always meant to the OS.

Found by an agent doing unrelated work in a neighbouring file, which is the
argument for writing down the direction the failure has to point in: it is
recognisable from the outside.

**A fourth, same shape, same hour, found the same way.** `explain` did not strip
the repo root from an absolute target, so `seisin explain dev write
/abs/repo/src/api/x.ts` answered *denied — has no owner* about a file that role
could write. `whose` had always stripped it and so does the hook; only the
command people run **to check a boundary** disagreed with the boundary. A path
genuinely outside the root still gets its honest "no owner" — that is a question
about somewhere else.

Three of these in one day, all pointing the same way, is not three accidents.
The sentence they violate has to be a test, not a paragraph, which is what
`test/document-vs-boundary.test.js` is for: each case asserts one half of the
claim against the other, so that moving either one fails loudly instead of going
quiet.

## `isolate` is off by default, has two levels, and that is the threat model

`[runtime] isolate` used to be one switch and is now three values, because the
half worth having was welded to the half that breaks things.

```toml
isolate = false           # default: a role reads your home like any process you run
isolate = "credentials"   # ~/.ssh, ~/.aws, ~/.npmrc, ~/.config go dark. HOME untouched
isolate = "home"          # the above, plus a HOME, TMPDIR and XDG set of the role's own
```

`true` still means `"home"`, so a config written before the split reads the same.

**Why they had to come apart, measured rather than argued.** With a home of its
own, `claude -p` answers `Not logged in - please run /login`. The cause is not
this sandbox: Claude Code keeps its credential in the macOS **Keychain**, the
login keychain lives at `$HOME/Library/Keychains`, and moving HOME points that
at a keychain which is not there. `HOME=/empty claude -p` reproduces it with no
sandbox anywhere, so it would happen to any tool that relocates a home.

Meanwhile the part people actually want — the places credentials live, closed to
every role — never needed a new HOME at all. Side by side against the real
kernel:

| | `~/.ssh` `~/.aws` `~/.npmrc` `~/.config/gh` | `~/.claude` | `claude -p` |
|---|---|---|---|
| `false` | open | open | **OK** |
| `"credentials"` | **closed** | open | **OK** |
| `"home"` | **closed** | closed | `Not logged in` |

So `"credentials"` is adoptable on a machine you are already working on, and
`"home"` keeps its honest price for the case it is actually for: a role that
must not read another role's session. Which of the two you want is still the
threat model — that is why neither is a default.

**Rejected: linking the real keychain into the isolated home**, to get the
separation without the logout. Measured against a throwaway keychain, a confined
role reads **every** item in it, including one added without `-A`: a macOS ACL is
per *application*, and `security` is the application, so any process in the box
clears it. That trades one hole for a larger one — the login keychain is every
password you have — and it is the kind of thing that has to be measured before
it is offered, not after.

Rejected: splitting the product into `mode = "team"` and `mode = "hostile"`.
That is two names for the switch that already exists, and it implies a "hostile"
mode is *safe against hostile agents*, which this is not. **Which of the two you
want is the threat model** — so it is a line in the config and a paragraph, not
a brand.

On the read side, at both levels: denies of the places credentials live, not a
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

## The kernel gets to speak, and it is an instrument rather than a control

The hook reports the attempt before it happens, and it is allowed to be
imperfect — what escapes it goes *unexplained, not unblocked*. That sentence is
the split this whole tool rests on, and for a while it hid a consequence nobody
had priced: **the log only ever held what the hook understood.** Everything else
left no trace at all, because a kernel refusal surfaces as a bare `Operation not
permitted` on the child's stderr, with no path, no operation and no owner.

The measurement that forced this. In production, wrapping two cells of an agent
team: the team's own hook had recorded 48,050 actions and 1,210 blocks, while
seisin's log held **one** entry. Four defects found while wrapping the first
cell all presented identically — a file that stopped growing — and diagnosing
them took a night, because nothing anywhere named the path that had been
refused. A tool whose line is *"when it blocks, it tells you whose it was"* was
delivering that in `explain`, which you have to go and ask, and not at the
moment of the block, which is when it is worth anything.

macOS already writes the missing line. Every Seatbelt denial lands in the system
log with the operation, the absolute path, and the runtime's own attribution tag
attached. `seisin run` now reads that stream and records what it finds, so a
refusal the hook never saw becomes a line with an owner and a request in the
queue — the same two things a refusal the hook *did* see produces.

**It does not touch the boundary, and that is what makes it allowed.** By the
time a line exists here the kernel has already refused. Nothing in this path can
widen a grant, narrow one, or change an outcome; the run behaves identically
with the monitor off. So "refusing rather than widening" is not in tension with
it — observing cost nothing to observe, which is the only reason it was built at
all. Had reading these required opening anything, the answer would have been no.

### Not through the runtime, and why the ask upstream is still open

The runtime collects exactly these events — `startMacOSSandboxLogMonitor` — but
`initialize()` takes `enableLogMonitor = false` and `dist/cli.js` omits the
argument, so on the `srt` path the collector is never constructed. Not "collected
and unread": **never collected.** That distinction is the difference between an
upstream patch that would have fixed this and one that would have changed
nothing, and it is why [the filed ask](upstream/cli-violations.md) was rewritten
rather than sent as drafted.

Embedding the library instead of spawning the binary would give us the flag. It
was rejected: `seisin run` spawning `srt` is what keeps the enforcement someone
else's job and this tool's failure modes small, and importing a research-preview
sandbox manager into the parent process to read a log is a large change of shape
for a small gain.

### Two anchors for attribution, because each one alone is wrong

A denial has to be proven to belong to *this* run before it is written under this
role's name. Crediting another sandbox's refusal to a role would be inventing a
fact about somebody's work, which is the one thing this tool exists not to do.

- **The process tree.** Exact while the process is alive, and worthless once it
  has exited — which, for the short commands that get refused most, is before
  the line arrives. Measured: attribution by tree alone recorded *nothing* for a
  one-line `sh -c`.
- **The runtime's command tag.** Survives the process, and depends on the
  runtime's quoting staying recognisable. Read by parsing the tag back into an
  argument list rather than by re-generating the quoting, because any correct
  quoting of the same arguments parses to the same list — so this keeps working
  through a change that re-implementing `quote()` would not survive.

Either one is enough, and whichever answers first hands over the per-`srt`
session suffix; from there attribution is one string comparison, exact against
every other sandbox on the machine. When neither can answer, the denial is
**held and re-examined, then dropped** — counted in a number the run prints, never
guessed at. Verified with two runs of two repos side by side: each log held its
own refusal and neither held the other's.

### The stream starts before the child, and that ordering is the feature

The first version started the monitor after the spawn, since that is when the
pid exists. It recorded zero denials, because `log stream` has its own startup
and a refused `sh -c` is over in single-digit milliseconds. So the stream starts
first and the pid is handed over afterwards, with anything that arrives in the
gap held rather than credited on faith.

Cost, since the constraint was explicit — this runs alongside a hook that fires
on **every** tool call, tens of thousands of times in one cell's history:
**nothing is added to that path at all.** The monitor is a sibling process and
the hook never touches it, so the number that mattered for `whose` — 166 ms,
which is why it lives only on the denial path — has no equivalent here.

What it does cost, measured rather than reasoned about: **128 ms per run**, from
683 ms to 811 ms over eight runs of the same refused command with and without the
monitor. That is the stream's own startup plus the drain at exit, and it is paid
once per `seisin run` — a unit that lasts as long as an agent session, not as
long as a tool call. The drain is capped at 250 ms and settles 60 ms after the
stream goes quiet; the measured lag between a refusal and its line arriving was
under a millisecond, with the line landing before `srt` had finished exiting, so
the 60 ms is a floor against scheduling noise rather than an estimate of the lag.

### What is not recorded, said out loud

The kernel refuses plenty that is not a territory question: `/dev/tty` on every
command a CLI runs, dtrace helpers, font caches. A denial is recorded when it
lands inside the repo or inside a path the role's own settings named; everything
else is counted and the count is printed when the run ends. Filtering that
nobody can see is indistinguishable from an instrument that is not working.

### Linux gets a sentence, not a shim

There is no equivalent stream to read. bubblewrap does not log refusals; the
runtime synthesises them by observing write-intent syscalls through its own
`apply-seccomp` stub, reporting over a socket it creates, reading paths out of
the traced process's memory — its own comment calls those events
attacker-controlled and racy. That is not attachable from outside and not worth
reimplementing. On Linux the watcher reports itself unavailable with the reason,
`seisin run` says so once, and the boundary is unchanged. **Claims are made per
platform here or they are not made.**

## `review` answers two questions it used to get wrong, and now declines one

`review` is arithmetic over the log, and that has not changed. What changed is
that arithmetic over the wrong input is still arithmetic — it just produces a
confident wrong answer, which is worse than no answer at all. Both findings
below came out of the same real repository on the same day, and both are the
same mistake: the command answering a question its input could not support.

### A key directory is not a territory drawn wrong

"Stopped, repeatedly" existed to turn forty tidy amber lines into one sentence:
*this is a policy that is wrong, not an agent misbehaving.* Its advice is **grant
it, or move the territory**, and for a role stopped at another role's folder
that advice is right.

For a role stopped at a `[keys] dir` it is the opposite of right. A key
directory is closed to **everyone** — nobody holds it, so there is no owner to
name and no handoff to make — and it is the one place where granting is never
the answer. Measured on a real repository: **six of the eight lines** at the top
of this report were key directories, which made the loudest thing this command
says *grant two roles the credential directory.*

They are reported apart now, under a heading that says what they are: the policy
working. The distinction was never missing — the log already carries `kind:
"key"` from both writers, the hook from the config and the parent for a kernel
denial. This report was the only thing not reading it.

`guarded` does not affect the exit code, and that is deliberate. `review` exits 1
on friction so it composes in CI; a boundary refusing exactly what it was
configured to refuse must not fail a build, or a correct policy can never go
green.

### "Never used" declines to answer rather than answer from half a log

This is the finding that can make a policy smaller, and therefore the one where
being wrong deletes a permission somebody needed. It is read off `allowed`
lines — and **only the hook writes those**. The kernel reports what it refused;
it has nothing to say about what went through.

So on a repo where `wire` was never run, the log holds denials and nothing else,
every grant falls through as unused, and the section reports that the entire
policy is dead — under a heading calling itself *the only evidence anyone will
ever have for making a permission file smaller.* Measured: every write
permission of every role, listed, while those roles were working.

**It became reachable the day the kernel started writing here.** Before that an
unwired repo had an empty log and this section said nothing, which was
accidentally correct. That is the general shape and it is worth naming: a
partial input is more dangerous than no input, because it looks like an answer.

With no `allowed` line in the window, `unused` stays **empty rather than full**
and `unusedKnowable` says why. Empty is the direction this has to fail in: a
consumer that has never heard of the flag then under-reports instead of
recommending the deletion of a working policy.

### Found on the way, and it was older than either

`src/review.js` and `src/scan.js` each contained literal NUL bytes, so **git
classified both as binary**. Every diff of them, in every commit since they were
written, reads `Bin 4635 -> 7446 bytes`. A file with no readable diff cannot be
reviewed, on a project whose README asks you to read it before you trust it.

Two different causes, two different fixes. In `review.js` the NUL was a
separator inside Map keys, and it bought nothing: `tomlName` restricts a role
name to `[A-Za-z0-9_-]`, so a space can never fall in the wrong place however
odd the path is. It is a space now. In `scan.js` the constant is real — it is
how a binary file is recognised while looking for secrets — so only its spelling
changed, from the byte to `\u0000`. Same value, same test, and the file has a
diff again.

## A request is addressed by what it is, not by where it sits

`seisin grant <n>` and `deny <n>` took a position in the pending list, and the
comment above them said it was "stable while you read it". That is false exactly
where it matters.

The queue is filled by agents that are still running. On a live repository it
grew and shrank between one command and the next, and `deny 1` settled a
different request than the one printed as `#1` seconds earlier — a real one,
from a role doing real work, closed by a command aimed at a test. Twice in one
session, by someone who had just written the tool.

It is time-of-check-to-time-of-use in the one command whose entire job is
deciding a permission. Every argument for this project — that a boundary should
name what it refused, that nothing is taken at its word — is worth nothing if
approving the wrong thing is one race away.

A number still works, because reading a list and typing a number is how anyone
will use it. But each entry now prints an id — `<role>:<action>:<path>` — that
does not move when the queue does, and an argument that is not a number is
matched against it. **An ambiguous match is refused rather than resolved**, for
the same reason the rest of this file refuses rather than guesses: choosing for
you is the failure being fixed.

**What it does not fix, and is worth knowing.** A settled request does not
reopen. A later `asked` for the same key raises its counter and leaves the state
alone, so a mistaken `deny` cannot be undone by the agent asking again — the
file is append-only and nothing rewrites a line. That is correct for evidence
and wrong for recovery, and it is unresolved: the honest repair today is to
grant the permission on its merits, which is a decision about the policy rather
than an undo.

## Still open

- ~~**The queue says "refused" and means "asked for".**~~ **Settled 2026-09-14**,
  and it was two problems rather than one.

  The first is the one recorded here: nothing required a denial to have
  happened, so a process inside the box could file a request for a path its own
  role already owns and the queue would print *first refused on …* about an
  event that never occurred — in front of a person about to approve it.
  `seisin run` now drops any request the policy does not actually refuse. Same
  treatment `owners` already got: the claim is recomputed by the parent rather
  than believed, and the parent is the one process the confined side cannot
  reach. It deliberately does **not** require the agent to have *tried* — asking
  before reaching is reasonable — so the entry reads **asked**, which is true
  either way.

  The second was not written down and is worse to read: **the same word meant
  two opposite things in the same command.** A queue entry said `first refused
  on src/api/x.ts` — the kernel said no — and `seisin deny` answered `refused
  frontend ✕ src/api/**` — *you* said no. Now the boundary **refuses** and a
  person **declines**, which is the distinction this whole tool is built on, and
  it was the one pair of words that blurred it.
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

## No second config format, for anybody

seisin reads one file with one shape. The pull to add a second is constant and always
reasonable in the moment: a team already declares who owns what — in a CODEOWNERS, in an
agent manifest, in whatever their orchestrator reads — and asking them to restate it is
asking them to keep two truths in sync.

The answer is that they translate it, outside this repo, and `seisin.toml` stays generated
rather than hand-kept. A translator is thirty lines against a format its author already
understands; a second first-class format is a parser, a precedence rule between the two, and
a new way for the policy to disagree with itself — in the one file whose job is to be the
thing everybody agrees on.

This was tested rather than assumed. A team running several agent cells generates their
policy from what their own configs already say, on their side, and the generator knows
things seisin has no business knowing: how many cells there are, where each one's records
live, which roles share a name across cells. An adapter shipped here could not have known
any of it, and shipping one anyway would have made this repo responsible for a format it
does not own.

`seisin init` sits on the other side of the same line: it *proposes* from `.claude/agents/`
and `CODEOWNERS` and then gets out of the way. It reads those formats once, to write ours.
It does not keep reading them.
