# What it has been put through

> Every claim in the README is downstream of something on this page. Where a
> finding is still open it says so, and where a fix is unverified it says that
> too — a security tool that only publishes its passes is advertising.

## The suite

**120 tests**, run on macOS and Linux, Node 18/20/22, on every push
([workflow](../.github/workflows/test.yml)).

Thirteen of them are not unit tests: they run real commands through the real
sandbox and check what the kernel did — and they skip themselves when `srt` is
not installed, so on a machine without it the suite reports 99 passing and 13
skipped rather than failing. That distinction matters enough that CI **fails if
those thirteen skip** — `srt` missing makes them skip themselves, and
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
