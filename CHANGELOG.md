# Changelog

Versions that were published. What changed in the repository between them is in the git
history; what changed for someone who installs it is here.

The config format may still move before `1.0`. When it does, `seisin check` says what
changed rather than failing on the old spelling.

## Unreleased

- **A refusal remembers that it has been given before.** From the second time a role is refused
  the same thing, the sentence says so: *"you have been refused this 3 times now; it is not
  going to work on the fourth try."* Measured on a real team, **88 of 345 blocks (25%) were a
  repeat** — one role hit the same wall nineteen times. Every refusal was correct; none was a
  false positive; it still cost the calls, because correct and heard are different properties.

  **`seisin walls <role>`** prints the standing list with what retrying cost. A wall is
  **recomputed against the current policy**, not read out of the log: if the role would be
  allowed today it is not a wall, so a grant clears it on the next turn rather than when a time
  window expires. Silent on the first refusal — a counter reading `1×` every time is noise.

- **A key can be a reference instead of a file.** `keys = ["keychain://netlify-token"]`,
  resolved by a provider declared in the same file — a command with a `{ref}` placeholder, so
  adding 1Password, Bitwarden, `sops` or Vault is TOML and not code. Path keys are unchanged
  and the two forms coexist in one list.

  The parent resolves, never the confined process: the provider command holds the vault's own
  credential, and running it inside the box would put that credential in there too. An unknown
  scheme is **refused**, not ignored. A provider that fails **does not degrade** — not to
  empty, not to the file of the same name, not to a skipped key.

  **What it does not do:** it resolves the secret *at rest*, not in the agent's context. The
  value still reaches the process. That is `inject`, and `inject` is declarable but refused by
  name, because the runtime only masks a credential when the role's TLS is terminated with a CA
  of seisin's own — MITM over all of that role's traffic.

- **How a key is delivered is declared beside the permission.** `key_mode` on the role, `mode`
  on the provider, role wins. `env` passes the value as a variable; `scratch` writes it to a
  file in the run's scratch space, hands over the path as `<NAME>_FILE`, and removes it when
  the turn ends. There is **no default** — a reference with no mode is an error, because the
  two answers differ in what the agent can walk away with.

  It is called `scratch` and not `file` deliberately: the runtime has a `credentials.files`
  that takes paths and, on macOS, makes them unreadable instead of masking — failing as though
  the feature did not exist. Two names that close together, one of which fails silently, is a
  trap with a date on it.

- **`seisin check` validates references without resolving them** — the scheme, the provider,
  the mode, and whether the provider's command is on `PATH`. A broken key policy is visible
  without asking anyone's keychain for a password.

## 0.1.1 — 2026-09-20

- **`git status` in a repo you do not own stops filing permission requests.** The sandbox
  now sets `GIT_OPTIONAL_LOCKS=0`, which turns off the index refresh that `status` and
  `diff` perform as a courtesy — and it is that refresh, not the read, that takes
  `.git/index.lock`. Measured on a live portfolio before the change: of the last 60
  refusals **58 were `.git/index.lock`**, and most carried no owner at all, so not one of
  them was a territory question. A human approving those is arbitrating a mutex.

  This **removes the need for a grant rather than widening one** — the boundary does not
  move. Writing git still works: `add`, `commit` and `checkout -b` take the locks they
  require, verified against a real repo, not read from the manual. A role that wants the
  old behaviour names `GIT_OPTIONAL_LOCKS` in its `env` and sets it in the parent.

## 0.1.0 — 2026-09-17

First published version. What it is at this point:

- **`seisin run <role> -- <cmd>`** — runs any command as that role, with the boundary in the
  kernel via [`@anthropic-ai/sandbox-runtime`][srt]: Seatbelt on macOS, bubblewrap on Linux.
  Territory, keys and network egress, all deny-by-default.
- **`whose` / `explain`** — the question the boundary cannot answer on its own. When a write
  is refused, these name the role that owns the path, from inside or outside the box, and
  across a worktree and its canonical checkout.
- **The hook** (`seisin wire`) — turns a refusal into a message the agent can act on instead
  of an `EPERM` it has to guess about.
- **Requests** — a refusal leaves a queued ask behind; `seisin grant <n>` rewrites the policy
  with its provenance, and `seisin deny <n>` records why not. Approving is a terminal
  command on purpose, never a tool call.
- **`init`**, **`check`**, **`review`**, **`scan`**, **`log`**, **`ui`**, and an MCP server
  (`seisin mcp`) that is read-only by construction.
- **`[runtime] isolate`** — a role can run with its own home directory, losing the
  credentials the ordinary mode leaves reachable.

Measured, not asserted: 225 tests, 18 of which run real commands through the real kernel and
fail the build if they *skip*. Green on macOS 15 and on Debian 12.15 with bubblewrap 0.8.0,
and on Node 18/20/22 in CI at every push. What has been run against which platform, what
broke on the way, and what is still open is in
[docs/what-it-has-been-put-through.md](docs/what-it-has-been-put-through.md).

Known and documented rather than fixed: deleting inside your own territory is permitted (the
ask is [upstream](https://github.com/anthropics/sandbox-runtime/issues/545)), Windows has
never been pointed at, and `init` only reads `.claude/agents/` and `CODEOWNERS`.

[srt]: https://github.com/anthropics/sandbox-runtime
