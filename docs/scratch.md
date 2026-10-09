# Scratch space, and what it costs

Territory alone is correct and unusable. What every role can write no matter what, and the
hole that opens.

*Part of [seisin](../README.md).*

Territory alone is correct and unusable. An agent writes session state under its own config
directory and its tools write to the temp dir, so a policy of *your folders and nothing else*
stops the agent before it starts. Every role therefore also gets:

```toml
[runtime]
# the default, in full — `~/.local/{share,state}` is where an agent that is neither
# claude nor codex keeps its log, and one that cannot write it does not fail a task,
# it fails to start
writes = ["~/.claude", "~/.codex", "~/.local/share", "~/.local/state",
          "~/.cache", "$TMPDIR", "/tmp"]
```

`~/.claude` and `~/.codex` are each one agent's: a run gets the one whose agent its command
runs — `claude …` or `codex …`, through `env`, `node`/`npx` and `sh -c "…"` — and neither when
it runs something else. Every run is also denied the other agents' sign-in files, read and write
(`~/.codex/auth.json`, `~/.claude/.credentials.json`). Before 2026-09-30 every role got both
directories, and a `cat` run as any role read the ChatGPT tokens Codex keeps in `auth.json`. A
wrapper script is not followed; name the agent: `seisin run dev --agent codex -- ./run-codex.sh`.
What stays open is a run's own sign-in: Codex and every command Codex runs share one sandbox, so
they can read its `auth.json`. Codex keeps it in the macOS keychain instead with
`cli_auth_credentials_store = "keyring"` in `~/.codex/config.toml`.

**Writing this key replaces that list; it does not add to it.** So a `[runtime] writes` copied
from somewhere to grant one extra path silently drops the six it did not mention. Start from the
list above and append.

Two things follow, and both are the kind of thing you want to hear from the tool rather than
discover:

- **Scratch is shared.** Every role can write it, so two agents can reach each other's temp
  files. If your repo lives inside the temp dir, territory does not hold at all — `seisin check`
  says so out loud when it detects that.
- **The home directory itself is never granted.** Only those named subdirectories. A grant that
  reached `~` would hand over the shell profile, the ssh config, and every dotfile with a token
  in it. There is a test that fails if that ever changes.
- **Reading your home is a different question, and by default it is open.** None of the above
  stops a role from *reading* `~/.ssh`, `~/.aws/credentials`, `~/.npmrc` or
  `~/.config/gh/hosts.yml`. That is a deliberate trade — an agent that
  cannot read the machine cannot work — and `seisin check` now says it on every run rather than
  leaving you to find out.

Set `writes = []` to opt out and find out why it is there.

### Closing your credentials, without signing the agent out

```toml
[runtime]
isolate = "credentials"   # ~/.ssh, ~/.aws, ~/.npmrc, ~/.config and the rest go dark
```

Measured, on the same machine, same policy, same command:

| | `~/.ssh` `~/.aws` `~/.npmrc` `~/.config/gh` | `~/.claude` | `claude -p` |
|---|---|---|---|
| default | open | open | **OK** |
| `isolate = "credentials"` | **closed** | open | **OK** |
| `isolate = "home"` | **closed** | closed | `Not logged in` |

`"home"` also gives each role its own `HOME`, `TMPDIR` and XDG directories, so one role cannot
read the session another's CLI just wrote. It is the stronger claim and it has a real price:
**every CLI in the sandbox sees an empty home and asks you to log in again.** That is not this
sandbox being strict — on macOS the agent's credential is in the login keychain, the keychain is
found through `$HOME`, and `HOME=/empty claude -p` reproduces the same message with no sandbox
involved at all.

Which of the two you want is your threat model, so neither is a default. `"credentials"` is the
one you can turn on today on a machine you are already working on.

### Reading only what the role needs

`isolate` closes the places *credentials* live. That is a list, and a list of what not to read
loses by one every time a product leaves a folder of its own: measured on a role under
`isolate = "credentials"`, it could still list `~/.claude`, list the whole project tree of the
person running it, and read an evaluation check kept beside its worktree. None of the three is
a credential.

```toml
[runtime]
read = "territory"     # default "all"

[roles.backend]
writes    = ["api/**"]
toolchain = ["~/.venvs/api"]                       # under a home, so declared; its bin/ goes first on PATH
reads     = ["../shared-schemas"]                  # data outside the repo, read-only
verify    = ["python", "-m", "pytest", "--version"]
keys      = ["CLAUDE_CODE_OAUTH_TOKEN=op://dev/claude/token"]   # see below
```

The places data lives are denied — homes, temp directories, mounted volumes — and the role
reads its repo, what it writes, its `reads`, its `toolchain`, its run, and the program it was
started with. The system (`/usr`, `/bin`, `/opt/homebrew` but its `var`) stays readable: there is
nobody's data there, and every interpreter is.

| | `~/.claude` | `~/Desktop/proyectos` | a file beside the repo | the repo | the role's toolchain |
|---|---|---|---|---|---|
| `isolate = "credentials"` | open | open | open | open | open |
| `+ read = "territory"` | **closed** | **closed** | **closed** | open | open if declared |

Measured on macOS with wapentake's V-7 cases (14 of 14, positive controls included). Linux uses
the same carving through bubblewrap but has not been measured through seisin yet.

- **`seisin check`** names every PATH entry the mode shuts, a `toolchain` that does not exist, and
  a role with no `verify`. **`seisin check --verify`** runs each role's `verify` inside its sandbox
  — the one thing `check` executes. An agent asked to verify its work with nothing to verify
  with retries, installs and works around instead: measured at +80% cost per task, and no
  verification.
- **Claude Code is signed out on macOS.** Its sign-in is in the login keychain, under the home.
  Hand it a token as a key (`claude setup-token`, or `ANTHROPIC_API_KEY`). Putting
  `~/Library/Keychains` in `reads` signs it in and gives the role every password in the keychain.
- **What it does not close.** The names along the way to the repo stay listable (`ls ~/work`
  shows what is there; nothing in it opens). It is a photograph: an entry created during the run
  beside a kept path is not covered, so secrets belong in folders that hold no repo. A directory
  on the way with more than 1,000 entries is refused rather than carved — keep repos out of
  `$TMPDIR`.
