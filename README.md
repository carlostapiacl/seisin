# keyward

**Give each AI agent its own folders and its own keys.** The kernel enforces it, and when it blocks something it tells you *whose* file it was.

```
$ keyward run frontend -- claude -p "fix the cart"

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

`keyward` answers the second question and hands the first one to the operating system.

## Install

```bash
npm install -g keyward
```

That pulls in [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), which does the enforcing: Seatbelt on macOS, bubblewrap on Linux. No containers, no VMs, no daemon. keyward has **no other dependencies**.

## Use

```bash
keyward init                              # proposes a keyward.toml for this repo
keyward check                             # print the map, run nothing
keyward run frontend -- claude -p "…"     # run an agent as that role
keyward explain frontend write src/api/x  # ask one question, exit 0 or 1
keyward ui                                # a console for editing the map
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

`keyward init` will propose this from whatever your repo already says: `.claude/agents/`, then `CODEOWNERS`, then a blank start. It **proposes** — a generated policy you did not read is not a policy.

## How it holds

| layer | what it does | can it be talked around? |
|---|---|---|
| your agent's `allow`/`deny` rules | match the command string before it runs | yes — `/bin/rm`, a heredoc, a child process |
| **keyward** | decides what to ask for, and names the owner | it doesn't enforce, it explains |
| **sandbox-runtime → Seatbelt / bubblewrap** | the OS refuses the syscall | no |

That split is deliberate, and it is why keyward is small. Because the kernel is the boundary, keyward never has to be airtight — it only has to be *legible*. A leaky explainer costs you a confusing log line. A leaky enforcer costs you the repo.

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

## What it is not

- **Not a sandbox.** [`sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) is the sandbox, and it is Anthropic's. keyward writes its settings and explains its refusals.
- **Not an orchestrator.** It does not run your agents, schedule them, or merge their work. It runs one command as one role.
- **Not a secret manager.** It scopes *reads* of files you already have. Where those files come from is your problem.
- **Not useful for a single agent.** If only one agent ever touches the repo, "whose file is this" has one answer and you don't need this.

## Prior art

This space already has good work, and keyward is not the first thing here:

- [`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) — the enforcement. keyward is a thin thing on top of a serious one.
- [`kornysietsma/claude-code-permissions-hook`](https://github.com/kornysietsma/claude-code-permissions-hook) — granular `PreToolUse` rules, one global policy.
- [`XuebinMa/agent-guard`](https://github.com/XuebinMa/agent-guard) — a permission-enforcement SDK, also one global policy.
- *Directory ownership* is recommended in half the multi-agent write-ups. As far as I could find, nobody enforces it, and nobody names the owner in the refusal. That gap is the reason for this repo.

## Status

`0.1.0`. The mechanism is tested end to end on macOS. Linux support comes from the runtime, and is not yet covered by the suite. The config format may still move before `1.0` — if it does, `keyward check` will tell you what changed.

Issues and pull requests welcome, particularly: Linux, the `PreToolUse` hook that carries the owner into the agent's own context, and better `init` heuristics.

## License

MIT
