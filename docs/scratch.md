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
  `~/.config/gh/hosts.yml`. That is the deliberate trade in the table above — an agent that
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
**every CLI in the box sees an empty home and asks you to log in again.** That is not this
sandbox being strict — on macOS the agent's credential is in the login keychain, the keychain is
found through `$HOME`, and `HOME=/empty claude -p` reproduces the same message with no sandbox
involved at all.

Which of the two you want is your threat model, so neither is a default. `"credentials"` is the
one you can turn on today on a machine you are already working on.
