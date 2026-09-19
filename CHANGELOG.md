# Changelog

Versions that were published. What changed in the repository between them is in the git
history; what changed for someone who installs it is here.

The config format may still move before `1.0`. When it does, `seisin check` says what
changed rather than failing on the old spelling.

## Unreleased

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
