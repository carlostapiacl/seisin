# seisin

> **seisin** *(n.)* — the legal possession of a piece of land. Not who owns it on paper: who holds it now.

**Give each AI agent its own folders and its own keys.** The kernel enforces it, and when it blocks something it tells you *whose* file it was.

```
$ seisin run frontend -- claude -p "fix the cart"

  frontend  write  src/api/orders.ts
  denied — src/api/orders.ts belongs to backend
```

That second line is the whole point. Every other permission layer in this space answers *yes* or *no*. Answering **"no, and it belongs to `backend`"** turns a block into a handoff.

---

## Why this exists

Two things are true about agent permissions today, and both are in the official docs.

**1. Permission rules match text, not behaviour.** From the Claude Code documentation:

> Calls matching `rm *` **as written** are denied […] Other `Bash` calls, **including `/bin/rm`**, fall through to the permission mode.

A rule is a string comparison against a command someone might not spell that way. A child process does not spell it at all.

**2. The tools that *do* ask the OS don't know who anyone is.** They take one global policy. That is fine for one agent. The moment you run two — separate worktrees, a frontend agent and a backend agent, a hotfix agent and a sprint agent — "may this be written?" is the wrong question. The right one is **"whose is it?"**

`seisin` answers the second question and hands the first one to the operating system.

## Install

```bash
npm install -g seisin
```

That pulls in [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), which does the enforcing: Seatbelt on macOS, bubblewrap on Linux. No containers, no VMs, no daemon. seisin has **no other dependencies**.

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

`0.1.0`. The mechanism is tested end to end on macOS. Linux support comes from the runtime, and is not yet covered by the suite. The config format may still move before `1.0` — if it does, `seisin check` will tell you what changed.

Issues and pull requests welcome, particularly: Linux, the `PreToolUse` hook that carries the owner into the agent's own context, and better `init` heuristics.

## The name

A deed says who owns land. **Seisin** is the older idea underneath: who is actually standing on it.

That is the question this tool answers. Not *may this be written* — the kernel settles that — but
*whose is it*, which is the one that tells an agent what to do next.

## License

MIT
