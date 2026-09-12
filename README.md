# seisin

[![test](https://github.com/carlostapiaolguin3-stack/seisin/actions/workflows/test.yml/badge.svg)](https://github.com/carlostapiaolguin3-stack/seisin/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/seisin?color=222)](https://www.npmjs.com/package/seisin)
[![license](https://img.shields.io/badge/license-MIT-222)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-222)](package.json)
[![no dependencies](https://img.shields.io/badge/dependencies-1-222)](package.json)

> **seisin** *(n.)* — the legal possession of a piece of land. Not who owns it on paper: who holds it now.

**Give each AI agent its own folders and its own keys.** The kernel enforces it, and when it blocks something it tells you *whose* file it was.

![seisin denying a write outside a role's territory, then naming the owner](docs/img/demo.gif)

```
$ seisin run frontend -- sh -c 'echo // fix >> src/api/orders.ts'
  sh: src/api/orders.ts: Operation not permitted

$ seisin run frontend -- seisin whose src/api/orders.ts
  src/api/orders.ts belongs to backend
  you are frontend. Hand it over rather than working around it.
```

That second line is the whole point. Every other permission layer in this space answers *yes* or *no*. Answering **"no, and it belongs to `backend`"** turns a block into a handoff.

## Sixty seconds

```bash
npm install -g seisin
cd your-repo
seisin init                            # proposes a policy from what the repo already says
seisin check                           # read it before you trust it
seisin run frontend -- claude -p "…"   # run an agent inside its own territory
```

On Linux, [three system packages first](#install). Everything below is why it works and where it does not.

**Contents** · [Why this exists](#why-this-exists) · [What it is *not* for](#what-it-is-for-and-what-it-is-not-for) · [Install](#install) · [Configure](#configure) · [Agents it runs](#which-agents-it-has-been-run-with) · [Requests](#when-it-says-no-it-leaves-a-request-behind) · [MCP](#ask-your-own-assistant) · [How it holds](#how-it-holds) · [Secrets](#how-it-protects-secrets) · [Status](#status)

---

## Why this exists

Two things are true about agent permissions today, and both are in the official docs.

**1. Permission rules match text, not behaviour.** From the Claude Code documentation:

> Calls matching `rm *` **as written** are denied […] Other `Bash` calls, **including `/bin/rm`**, fall through to the permission mode.

A rule is a string comparison against a command someone might not spell that way. A child process does not spell it at all.

**2. The tools that *do* ask the OS don't know who anyone is.** They take one global policy. That is fine for one agent. The moment you run two — separate worktrees, a frontend agent and a backend agent, a hotfix agent and a sprint agent — "may this be written?" is the wrong question. The right one is **"whose is it?"**

`seisin` answers the second question and hands the first one to the operating system.

## What it is for, and what it is not for

> **It turns an agent's mistake into a contained mistake. It does not turn a hostile
> agent into a harmless one.**

That distinction is the whole threat model, and it is worth reading before you install
rather than after.

**It holds against an agent that is wrong.** One that edits the file it was not asked
about, reads the key meant for another role, or calls an API nobody declared. The kernel
refuses, and it does not care how the command was spelled — verified against a grandchild
process, an absolute path, a symlink, a `python -c`, and a shell redirect the agent fell
back to when its own file API was refused.

**It is not built to hold against an agent that is trying.** Measured, in this repo's own
fixtures:

| | |
|---|---|
| it can read everything except the declared keys | by design — an agent that cannot read the repo cannot work. `seisin scan` exists because secrets live elsewhere too |
| it can write anything inside its own territory | including staging an exfiltration, or destroying its own uncommitted work with `rm` |
| `base64` defeats the redaction | only the literal value is masked, and only on stdout and stderr |
| an allowed domain is an allowed channel | if the agent's own API is reachable, so is everything that goes through it |
| the hook is text-based and evadable | on purpose. What escapes it goes **unexplained, not unblocked** — but attribution is not a control |

And three things that outweigh all of the above:

1. **It is days old and has one author.** Around three thousand lines that nobody has
   audited except its writer and one field report. "Secure" is not a word earned that fast.
2. **The enforcement is someone else's beta.** `sandbox-runtime` describes itself as a
   research preview with an evolving API. A hole there is a hole here.
3. **Two platforms tested, by one person, on one machine each.**

For several of your own agents, on your own machine, getting in each other's way — that is
what this is for, and it is a great deal better than nothing. For putting an agent you do
not control in front of data you care about, it is not.

## Install

```bash
npm install -g seisin
```

That pulls in [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), which does the enforcing: Seatbelt on macOS, bubblewrap on Linux. No containers, no VMs, no daemon. seisin has **no other dependencies**.

**On Linux you also need three system packages** — the runtime refuses to start without
them rather than running unconfined, which is the right failure and an unhelpful message:

```bash
apt install bubblewrap ripgrep socat      # or your distro's equivalent
```

**On Ubuntu 24.04 and newer**, unprivileged user namespaces are off by default and
bubblewrap needs one. Every run dies with `bwrap: No permissions to create new
namespace`:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

Worth knowing what this looks like when you hit it: seisin appears to deny
*everything*, because the sandbox never starts. It is not a policy problem and
no amount of editing `seisin.toml` will move it.

**Inside a container** bubblewrap needs to create namespaces and mount `/proc`, which a
default Docker container forbids. `--cap-add SYS_ADMIN --security-opt seccomp=unconfined`
gets namespaces; mounting `/proc` needs `--privileged`. If you cannot grant that, run
seisin on the host and let the container be what it sandboxes.

## Use

```bash
seisin init                              # proposes a seisin.toml for this repo
seisin check                             # print the map, run nothing
seisin run frontend -- claude -p "…"     # run an agent as that role
seisin explain frontend write src/api/x  # ask one question, exit 0 or 1
seisin ui                                # a console for editing the map
```

## Configure

One file at the root of your repo. Anything not listed is denied — there is no permissive default.

```toml
[keys]
dir = ".secrets"          # every key lives here; roles name the files they may read

[network]
allow = ["github.com", "*.github.com"]

[roles.frontend]
writes = ["src/web/**", "public/**"]
keys   = ["netlify-token.txt"]

[roles.backend]
writes = ["src/api/**", "migrations/**"]
keys   = ["database-url.txt", "sentry-dsn.txt"]
```

`seisin init` will propose this from whatever your repo already says: `.claude/agents/`, then `CODEOWNERS`, then a blank start. It **proposes** — a generated policy you did not read is not a policy.

## Which agents it has been run with

seisin wraps a process, so in principle it works with any CLI. In practice "in principle" is
not a claim worth making about a permission tool, so here is what has actually been exercised:

| agent | version | result |
|---|---|---|
| **Claude Code** (`claude -p`) | 2.1.x | Territory and keys enforced; network egress refused an undeclared domain by name |
| **opencode** (`opencode run`) | **1.18.30** | Same, **on a free model with no API key at all** |

Both on macOS 15 (Seatbelt). The suite also passes on **Linux x86_64** — Debian 12,
node 22, bubblewrap 0.8.0 — 73 of 73.

The opencode run is the interesting one, because **opencode has no per-path sandbox flag** —
its only permission control is `--auto`, "auto-approve permissions that are not explicitly
denied". Asked to write into another role's territory it failed twice: once through its own
`FileSystem.writeFile`, and again through the shell redirect it fell back to.

```
Error: Unknown: FileSystem.writeFile (.../qa/informe.md)
$ echo "revisado" > .../qa/informe.md
zsh:1: operation not permitted
```

That is the point of putting the boundary in the kernel instead of in the agent: **an agent
that cannot confine itself is confined anyway**, and adding a new one costs no adapter.

It also found a real bug. The scratch list named `~/.claude` and `~/.codex` and stopped there,
so the first agent that was neither did not fail a task — it failed to start, on its own log
file. A boundary that only fits the agents its author happened to use is a coincidence, not a
boundary. The XDG directories are in the list now.

**Re-verified without an agent in the loop**, which is better evidence: an agent in the middle
makes a permission test non-deterministic — in that first run the agent reported the opposite
of what it had actually done. Wrapping a plain shell and a plain interpreter instead:

| as `dev`, with `qa/**` owned by `qa` | result |
|---|---|
| `sh -c 'echo x > proyecto/FILE.txt'` (own territory) | rc=0, created |
| `sh -c 'echo x > qa/report.md'` (shell redirect) | `Operation not permitted`, rc=1 |
| `python3 -c "open('qa/report.md','w')"` (the program's own syscall) | `PermissionError: [Errno 1]` |
| `rm -f proyecto/FILE.txt` (**destructive, inside** own territory) | **rc=0, file gone** |

The last row is not a bug, it is the shape of the tool: seisin answers *where*, not *what*.
A team running this in front of an agent fleet measured how often it matters: across ~330
rounds, sixty-six times a role reached for a command that would have destroyed its own
uncommitted work, and the kernel boundary permitted every one. The ask that would close it
is written up in [docs/upstream/denyUnlink.md](docs/upstream/denyUnlink.md), filed against
the sandbox runtime rather than worked around here.

## Where the first policy comes from

Every permission tool dodges this question. Written by hand, the first policy is a guess, and
the first unjustified denial is when the tool gets uninstalled. So don't write it — watch, then
write:

```bash
seisin run frontend --observe -- claude -p "…"   # records, denies nothing
seisin init --from-observations                  # writes seisin.toml.observed
```

It lands as `.observed`, not as your config. A policy generated behind your back is not a
policy: diff it, then move it.

## When it says no, it leaves a request behind

A permission tool that can only say no is a tool people uninstall. The loop —
denied, stop, go edit a config, run again — is three context switches for one
line of policy, and the cheapest way to make it stop is to widen the policy
generously and never look again. That is how a permission file becomes seven
hundred entries nobody can read.

So a denial leaves something you can act on:

```
  frontend  write  src/api/orders.ts
  denied — src/api/orders.ts belongs to backend

  1 pending request(s)

    #1  frontend wants write on src/api/** (owned by backend) · asked 3×
        first refused on src/api/orders.ts

    seisin grant 1 --reason "…"   ·   seisin deny 1 --reason "…"
```

Many refusals in one directory are **one** request, not many — an agent denied
on `a.ts` and then on `b.ts` is not asking two questions. And the grant records
where it came from, next to the line it adds:

```toml
[roles.frontend]
writes = [
  "src/web/**",
  "src/api/**"   # granted 2026-09-12 · asked 3× · "frontend owns checkout now"
]
```

Without that, a policy is a list of permissions with no history, and the only
safe thing to do with a line nobody remembers is leave it there.

**Approving is deliberately not a tool call.** An agent — or an MCP server on
your behalf — can read the queue and draft the change. Turning it into policy
takes a person in a channel the agent does not have. The public API reflects
that: `pendingRequests` is exported, the functions that approve are not.
[The reasoning is written down](docs/permission-requests.md).

![the console: a pending request, a reason, and the territory changing when it is approved](docs/img/console.gif)

Two places, both human: `seisin grant <n>` in a terminal, or the console, where
the queue is a panel with a reason field and two buttons. Approving there edits
your `seisin.toml` in place and the territory on screen changes with it.

The console is allowed to hold that half and the MCP server is not, and the
reason is measured rather than asserted: a confined role curling the console's
own port gets the same nothing it gets from a domain outside its allowlist. The
MCP server, by contrast, speaks on the agent's own stdio.

The notice rides on what you are already looking at: `seisin run` prints the
queue when the run ends, in the same terminal that just showed you the denial.
There is no daemon and nothing to leave running.

## Ask your own assistant

```jsonc
{ "mcpServers": { "seisin": { "command": "seisin", "args": ["mcp"] } } }
```

> *who owns src/api, and what is frontend waiting on?*

Read-only **by construction** — the server opens nothing for writing, and a test
asserts that no tool in it mutates anything. It can draft the exact change a
request would make; applying it is a command a person runs. Zero dependencies:
the official SDK wanted 91 packages for a server that speaks JSON on two file
descriptors.

## Seeing what happened

```bash
seisin log --verdict denied      # what the agents tried and could not do
seisin watch                     # follow it live
```

```
04:13:26  allowed  frontend write src/web/app.ts
04:13:26  denied   frontend write src/api/server.ts  → backend
04:13:27  denied   frontend read .secrets/database.txt  → backend
```

One append-only JSONL under `.seisin/`, and that is the whole storage design — no daemon, no
socket, no database. `watch` is a tail. The file is the shared state, so anything that can read
it can watch it.

That log is also what makes the sandbox legible at all. When the kernel refuses a write, the
only thing that surfaces is `Operation not permitted` on the child's stderr: no path, no
reason, nothing to read afterwards. Correct for an enforcer, useless as an instrument. The
hook runs one layer up and sees the attempt before it happens.

## How it holds

| layer | what it does | can it be talked around? |
|---|---|---|
| your agent's `allow`/`deny` rules | match the command string before it runs | yes — `/bin/rm`, a heredoc, a child process |
| **seisin** | decides what to ask for, and names the owner | it doesn't enforce, it explains |
| **sandbox-runtime → Seatbelt / bubblewrap** | the OS refuses the syscall | no |

That split is deliberate, and it is why seisin is small. Because the kernel is the boundary, seisin never has to be airtight — it only has to be *legible*. A leaky explainer costs you a confusing log line. A leaky enforcer costs you the repo.

Verified by the test suite, which runs real commands in a real sandbox:

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

## How it protects secrets

Four ways out of a process, and seisin closes three of them. The fourth is named below,
because a security tool that lists only its wins is not one.

| way out | closed by | how |
|---|---|---|
| reading another role's key file | the kernel | the key directory is denied, each declared key re-allowed. Survives a grandchild process and an absolute path |
| a key riding in the environment | the launcher | the child's environment is **built, not inherited**. Measured before this existed: 93 variables crossed into every turn, a planted token among them |
| spilling a key the role does hold | the launcher | the value is masked on stdout and stderr, including when it lands split across two buffers |
| sending it somewhere | the kernel | egress is allow-only. `curl` to a domain you did not list gets nothing |
| **a key stored outside the declared directories** | **nothing** | `seisin scan` finds them so you know what is not covered |

```toml
[keys]
dir = [".secrets", "config/credentials"]   # one directory or several

[roles.frontend]
keys = ["netlify-token.txt"]   # everything else in those directories is denied
env  = ["BUILD_ID"]            # everything else in the environment is dropped
```

**Two things this deliberately does not claim.** Redaction masks a literal value on the way
through the launcher — a key written straight to a file never passes through it, and neither
does one the agent base64'd first. It narrows a careless print; it is not a containment
boundary. And to mask a value seisin must read it, so a role's own keys pass through this
process in memory. `[runtime] redact = false` turns that off.

## Scratch space, and what it costs

Territory alone is correct and unusable. An agent writes session state under its own config
directory and its tools write to the temp dir, so a policy of *your folders and nothing else*
stops the agent before it starts. Every role therefore also gets:

```toml
[runtime]
writes = ["~/.claude", "~/.codex", "~/.cache", "$TMPDIR", "/tmp"]   # the default
```

Two things follow, and both are the kind of thing you want to hear from the tool rather than
discover:

- **Scratch is shared.** Every role can write it, so two agents can reach each other's temp
  files. If your repo lives inside the temp dir, territory does not hold at all — `seisin check`
  says so out loud when it detects that.
- **The home directory itself is never granted.** Only those named subdirectories. A grant that
  reached `~` would hand over the shell profile, the ssh config, and every dotfile with a token
  in it. There is a test that fails if that ever changes.

Set `writes = []` to opt out and find out why it is there.

## What it is not

- **Not a sandbox.** [`sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) is the sandbox, and it is Anthropic's. seisin writes its settings and explains its refusals.
- **Not an orchestrator.** It does not run your agents, schedule them, or merge their work. It runs one command as one role.
- **Not a secret manager.** It scopes *reads* of files you already have. Where those files come from is your problem.
- **Not useful for a single agent.** If only one agent ever touches the repo, "whose file is this" has one answer and you don't need this.

## Prior art

This space already has good work, and seisin is not the first thing here:

- [`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) — the enforcement. seisin is a thin thing on top of a serious one.
- [`kornysietsma/claude-code-permissions-hook`](https://github.com/kornysietsma/claude-code-permissions-hook) — granular `PreToolUse` rules, one global policy.
- [`XuebinMa/agent-guard`](https://github.com/XuebinMa/agent-guard) — a permission-enforcement SDK, also one global policy.
- *Directory ownership* is recommended in half the multi-agent write-ups. As far as I could find, nobody enforces it, and nobody names the owner in the refusal. That gap is the reason for this repo.

## Status

`0.1.0`, 89 tests, all 89 passing on both macOS and Linux against the real
sandbox and real commands, on Node 18/20/22 — and CI fails if the sandbox half *skips*,
because a green run that quietly tested nothing looks exactly like a real one.
The config format may still move before `1.0` — if it does, `seisin check` will
tell you what changed.

**What is genuinely open**, so nobody spends an afternoon on something that is
already done:

| | |
|---|---|
| **Windows** | the runtime has a backend. seisin has never been pointed at it, and no CI runner covers it |
| **Deleting inside your own territory** | not covered, and not coverable here — [the ask is upstream](docs/upstream/denyUnlink.md), with the measurement behind it |
| **`init` heuristics** | it reads `.claude/agents/` then `CODEOWNERS`. Every other convention is a guess nobody has made yet |

Issues and pull requests welcome. If you are reporting something that got past
the boundary, `seisin log --verdict denied` and the `seisin.toml` are the two
things that make it reproducible.

## The name

A deed says who owns land. **Seisin** is the older idea underneath: who is actually standing on it.

That is the question this tool answers. Not *may this be written* — the kernel settles that — but
*whose is it*, which is the one that tells an agent what to do next.

## License

MIT
