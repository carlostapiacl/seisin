# What it has been put through

> Every claim in the README is downstream of something on this page. Where a
> finding is still open it says so, and where a fix is unverified it says that
> too — a security tool that only publishes its passes is advertising.

## The suite

**152 tests**, run on macOS and Linux, Node 18/20/22, on every push
([workflow](../.github/workflows/test.yml)).

Fourteen of them are not unit tests: they run real commands through the real
sandbox and check what the kernel did — and they skip themselves when `srt` is
not installed, so on a machine without it the suite reports 138 passing and 14
skipped rather than failing. That distinction matters enough that CI **fails if
those fourteen skip** — `srt` missing makes them skip themselves, and
a green run that quietly tested nothing looks exactly like a real one.

```
✔ a role reads the key it declares
✔ a role cannot read another role's key
✔ each role reads its own, so the deny is not just blanket
✔ a role writes inside its territory
✔ a role cannot write outside it
✔ reading another role's code still works
✔ the boundary survives a grandchild process
✔ an absolute path does not walk around the rule
```

### Where each claim was actually run

Two platforms enforce differently — Seatbelt on macOS, bubblewrap on Linux — so
"it works" is a per-platform claim. This is what has been exercised on each, and
what has not.

| | macOS 15 · Seatbelt | Linux · bubblewrap |
|---|---|---|
| the suite | **148/148, nothing skipped** | **148/148, nothing skipped** — Debian bookworm, bwrap 0.8.0, Node 22, in Docker |
| CI, every push | Node 18/20/22 | `ubuntu-latest`, Node 18/20/22 |
| `[runtime] isolate = true` | ✅ — and it did not start here at all until the 104-byte socket fix | ✅ — `tmpdir()` is `/tmp`, so the path never came close |
| Claude Code 2.1.270 | ✅ | not run |
| opencode 1.18.30 | ✅ | not run |
| codex 0.150.1 | ✅, with its own sandbox off | not run |
| LangGraph 1.2.11 | ✅ | not run |
| Windows | — | — |

The four agents have only been run under macOS. The suite covers both, and the
suite is what asserts the boundary holds; the agent runs are evidence that real
tools behave inside it, and that evidence is one platform deep.

The asymmetry in the `isolate` row is the reason this table exists. A defect can
be specific to the platform its author develops on, stay invisible on the other,
and be invisible in CI too when no test turns the feature on.

## Two outside reviews

Neither was commissioned and neither was friendly, which is the useful kind.

### Review 1 — architecture

Four findings, all four real, all four reproduced before being fixed.

| | what it was | now |
|---|---|---|
| **Policy ≠ enforcement** | `ownersOf` read `src/*` as one level; the kernel got `src`, the whole subtree. `seisin explain` said *denied* and the write landed | patterns the kernel cannot express exactly are **refused**, not widened. There is no exact translation to find later: a sandbox grants prefixes and "one level down" is not a prefix |
| **The audit trail was writable by what it audits** | `.seisin/` was in every role's allowWrite, so the log and queue could be truncated, rewritten or forged | the directory left the territory. The hook sends lines to the parent over a unix socket granted by path; the parent holds the file |
| **Paths were not canonical** | `src/web/../api/orders.ts` is backend's file and matched frontend's `src/web/**`. The kernel still refused — but `whose` named the wrong owner and the log said `allowed` for a write that was about to fail | resolved before anyone decides anything. Above the root owns nothing |
| **The README contradicted itself on Linux** | one section said the suite passed on Debian 12, another said it had never run there | CI now runs it on both platforms every push |

### Review 2 — security, file by file

Ten findings. **Seven held up.** Each was reproduced against the real kernel
before the fix and re-measured after.

| | what it was |
|---|---|
| **A full-repo role owned its own policy** | `writes = ["**"]` plus `denyWrite: []` meant the role could rewrite `seisin.toml` and come back wider next run |
| **A grant could land in the wrong role** | approving for a role that declares only `keys` wrote the permission into the *next* role, carrying a comment naming the role it was meant for |
| **A reason could become configuration** | approver text went into a comment unescaped, and a newline ends a comment |
| **A key could point outside the key directories** | a slash in the name made it relative to the repo root, so `keys = ["../.ssh/id_rsa"]` was a read grant hiding in the one list nobody audits twice |
| **`--observe` was read from the whole command line** | a flag belonging to the agent could change seisin's mode |
| **The audit socket sat in writable scratch** | the channel could be unlinked |
| **Every role shared the real home** | `~/.claude`, `~/.cache`, `/tmp` — so "its own folders" was only ever true of the repo |

Plus two smaller ones: the MCP server's input buffer was unbounded, and its
declared schemas were documentation rather than enforcement.

**One finding did not hold.** The reason-injection escalation had already
stopped working — the strict parser landed hours earlier and turns a poisoned
reason into an unparseable file rather than a wider one. The reason is
sanitised anyway: a permission file a sentence can break is still broken.

## What a fix is worth here

Each of these is a command that was run, not an argument that was made.

**A role with the whole repo, against the real kernel:**

```
seisin.toml          blocked
.secrets/            blocked
.seisin/log.jsonl    blocked
src/ok.txt           written   ← its actual territory
```

**The audit trail, attacked from inside the box:**

```
rm .seisin/log.jsonl              blocked
echo BORRADO > .seisin/log.jsonl  blocked
echo x >> .seisin/requests.jsonl  blocked
unlink the audit socket           blocked
a confined process sending a line arrived
```

**Isolated mode, two roles:**

```
role a HOME  .../seisin-home-<repo>/a
role b HOME  .../seisin-home-<repo>/b
a → the real ~/.claude         cannot see it
a → writing b's home           blocked
a → reading b's home           blocked
```

That last line was **wrong here for a day**. The only thing measured was the
write, and the sentence written down read as general — so `a` could read the
session token `b`'s CLI had just written, while this page said otherwise. A
reviewer found it by reading the generated settings rather than the claim. It
is the failure this whole project is about, committed on the page that lists
the others.

### Review 3 — the same reviewer, on the fixed version

Confirmed the seven above closed, then found eight more.

| | what it was |
|---|---|
| **A policy could be cancelled further down the file** | duplicate tables and duplicate keys both parsed, last one wins. A config reads restrictive at the top and is undone forty lines below; the reviewer reads the first block |
| **A key that is a symlink escaped its directory** | the check compared text and the sandbox enforces on the destination. `.secrets/github-token.txt -> ~/.ssh/id_rsa` was a read grant on the ssh key. Measured: the read succeeded through the link *and* through the real path |
| **`check` mislabelled what it could not enforce** | every settingsFor error was reported as a glob problem, sending the reader to the wrong line — and it exited 0 on a config `run` would refuse |
| **The audit socket was at a guessable path** | already unlinkable-proof, but any other process of this user could connect and add lines |
| **Territory outside the repo was silent** | supported on purpose, and a different promise from "this repo, divided" |
| **`env = ["GITHUB_TOKEN"]` was silent** | the one place a secret reaches a role without being a declared key |
| **Reading was wide open** | "read anything except the declared key directories" leaves `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.config/gh` readable to every role |
| **Isolated mode was off by default** | so the shared-home fix applied only to people who switched it on |

The last two are the threat-model question rather than bugs, and they are
answered the same way: `[runtime] isolate = true` now closes reading as well as
writing, and it stays opt-in. Measured both ways — `~/.ssh` reads fine by
default and comes back `Operation not permitted` isolated.

### Review 4 — the config parser

One finding, and it was the kind that does not show up in review at all.

`[roles.__proto__]` does not appear in `Object.keys(roles)`. So `seisin check`
printed the roles that exist and said nothing — while every other role
inherited whatever that table declared. A config reading

```toml
[roles.frontend]
keys = []
```

came out of the parser owning the whole repo and holding `GITHUB_TOKEN`,
because forty lines earlier a table nobody could see had said so.

Closed twice over, because what it produces is invisible: the parser refuses
the three reserved names and builds every table with a null prototype, and
`loadConfig` reads only properties a file actually declared. Each was tested on
its own — the second one against a prototype polluted by hand.

The same review tightened three more: config is now emitted through one rule
instead of three (`init` did not check what `applyGrant` did, and
`renderObserved` builds lines out of log targets, which is text an agent
chose); log entries are validated the way queue entries already were, so a
process in the box cannot write `allowed` lines for paths it never touched —
which would not move the boundary but would move `review`, and
`init --from-observations` builds a policy out of exactly that; and the README
said 16 tests run against the real sandbox when 13 do.

### Review 5 — the npm package, before publishing

The tarball that would be published, installed globally, exercised by the team
that runs this in production. The half I cannot test alone — a real agent
crossing a real boundary — closed end to end: the denial, the request landing
in the queue, the grant rewriting `seisin.toml` with its provenance and
comments intact, and the same run succeeding afterwards.

Two defects, both in `init --from-observations`:

| | what it was |
|---|---|
| **A file became a directory that does not exist** | observing a write to `NOTAS.md` proposed `NOTAS.md/**`, which grants nothing over the file that was actually written |
| **The observed policy deleted the roles that were idle** | it emitted only the roles the log had seen, and the file says *"diff it, then move it"* — so moving it silently removed the territory of every role that happened to do nothing during the window. A role that did nothing is not a role that needs nothing; it is a role nobody watched. Observation adds now, and each role says which part came from where |

Everything deliberately broken held: malformed arrays, an empty config, a role
with spaces, `--` in the wrong place, a territory outside the repo. Each named
the file, the line and the known roles.

**One open question, from the same run.** The agent knew whose file it was — but
it worked that out by reading `seisin.toml` and `.seisin/frontend.json` itself.
What it was handed was `EPERM`. The hook's side is verified here: it returns
`permissionDecision: "deny"` with the owner's name, for `Write` and `Edit`
alike. Whether that reached the agent's context in their run, or a different
call produced the `EPERM`, is one data point away and it is the sentence this
whole project is built on.

### Found here, not by a reviewer — `isolate` never started on macOS

Two outside reviews recommended making `[runtime] isolate = true` the default.
Turning it on to weigh the cost is how it came out that **it did not run at all**
on macOS, for every role name including a two-letter one:

```
Error: listen EINVAL: invalid argument
  /var/folders/.../T/seisin-home-<16 chars>/dev/tmp/srt-mux-34547-0.sock    106 bytes
```

The runtime creates its multiplexing socket **inside** the role's home, a unix
socket path is capped near 104 bytes, and `tmpdir()` on macOS is 48 of them
before anything else is added. The budget for a role home is 79 bytes and the
old name spent 81 before naming the role.

`spool.js` documents this exact limit, in this exact repo, for its own socket.
The same defect was re-derived one layer down — which is the tell that it is a
design problem rather than an oversight.

**Two fixes, and the second is the one that mattered.** The name went from
`seisin-home-` plus sixteen characters to `sn-` plus eight, and `settingsFor`
now refuses with its own message rather than letting the runtime fail on EINVAL
with no role named. But shortening the id exposed what the id was: **the tail of
the base64 of the path, which is the tail of the path**. `/Users/ana/dev/proyecto`
and `/Users/bob/dev/proyecto` produced the same one — three of four ordinary
pairs collided — and a collision here hands one checkout's role home, session
token included, to another. That was already true at sixteen characters. It is a
hash of the whole path now.

**And the reason none of it was caught: no test turned the feature on.** A green
suite said nothing about a documented mode that could not start. There are three
now — the path arithmetic, the collision pairs, and one that runs a role under
`isolate` end to end and asserts it both starts and loses `~/.ssh`.

Verified after the fix on macOS 15 and, in Docker, on Debian with bubblewrap
0.8.0: **148 of 148, nothing skipped on either.**

## Still open, and named

- **Deleting inside your own territory.** `rm` in a role's own folders
  succeeds, because writes and deletes are one permission to the kernel. Not
  coverable here — [the ask is upstream](upstream/denyUnlink.md), with a
  measurement behind it: 66 times in ~330 rounds of real agent work.
- **Forgery in the audit trail.** A hostile agent can still *send* lines, so it
  can pad its own history. It cannot erase or alter what is there. Tampering is
  closed; forgery is not.
- **Isolated mode is off by default.** With it off, reading is wide — `~/.ssh`
  and `~/.aws` are ordinary files to every role — and `~/.claude`, `~/.cache`
  and `/tmp` are shared between them. With it on, every CLI in the box sees an
  empty home and asks to log in again, and a permission tool that silently signs
  you out is one people uninstall. So it is a choice, made in the config, rather
  than a default. Which of the two you want *is* the threat model.
- **No resource limits.** CPU, memory, PID count and disk are not bounded. A
  runaway agent can still exhaust the machine; the boundary is about what it
  can reach, not how much of it there is.
- **Windows.** The runtime has a backend. seisin has never been pointed at it.
- **No fuzzing.** The parser has a property test over a fixed corpus, which is
  not the same thing.

## The claim this supports

Not *"safe against a hostile agent"*. The honest one:

> seisin confines the mistakes of agents you run yourself, using the operating
> system rather than pattern-matching, with per-role write isolation and
> isolation of the keys you declare.

Everything above is why that sentence is shaped the way it is.
