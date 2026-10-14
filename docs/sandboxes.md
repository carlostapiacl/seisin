# Sandboxes: who enforces the policy

seisin decides what each role may do; a sandbox enforces it. Three can do that:

| sandbox | what it is | how seisin talks to it |
|---|---|---|
| `srt` (built in, the default) | `@anthropic-ai/sandbox-runtime`: Seatbelt on macOS, bubblewrap on Linux | the settings file, as is |
| `tartaros` (built in) | Seatbelt on macOS; Landlock, seccomp and cgroups on Linux | the settings file, as is (`--settings`) |
| any name you declare | a command of yours | the settings file, through the contract below |

Without a `[sandbox]` table every role runs under `srt`, as it always has.

## Choosing one

```toml
[sandbox]
provider = ["tartaros", "srt"]
```

`provider` is one name, or several in order of preference. Each role gets the
**first one that is installed and enforces every part of that role's
settings**. A sandbox that would enforce less is passed over, and the reason is
recorded. Whether a sandbox can hold a role is the sandbox's own answer when it
gives one (tartaros does, and a declared one can with `check`); seisin does
not keep a list of its own of what each sandbox can do. A single name means exactly that sandbox: a role it cannot hold does
not start, and the error names what was missing:

```
seisin: no sandbox in [sandbox] provider can hold role backend as its policy is written, so it was not started:
  - tartaros cannot enforce all of it:
      tartaros says it cannot hold this policy: --settings: cannot guarantee a specific AF_UNIX socket …
```

`seisin check` says which sandbox each role would get, and why the others were
passed over, before anything runs. It exits 1 if a role has none.

The rule is the one in [decisions.md](decisions.md#a-second-sandbox-only-where-it-enforces-the-policy-exactly):
choosing a sandbox is a question of what it can enforce, not a preference
toggle. Falling back is allowed; enforcing less than the policy says never is.

Whichever sandbox is chosen, every run starts with the canary ([src/canary.js](../src/canary.js))
under that sandbox and the same settings. If the boundary does not hold, no
agent starts (exit 86).

## tartaros

seisin runs it as

```
tartaros run --role <role> --settings <settings file> -- <the command>
```

and, before that, asks it about the same file:

```
tartaros explain --settings <settings file>
```

which reads the file through the same code as `run` and exits 2, with the
reason, on a field it cannot guarantee. That reason is what `seisin check`
and a refused run print. tartaros needs to be on PATH (`cargo build --release
-p tartaros-cli`, then its `target/release`).

What decides whether it can hold a role is tartaros, not this page: as it
learns a field, roles that needed it start being given to it, with nothing to
change in seisin. What `explain` prints as `warning:` while saying yes,
`seisin check` shows under the role — on Linux without mount privileges, for
one, that a role given a whole repo cannot create new entries at its root.

tartaros tags every Seatbelt denial the way sandbox-runtime does, so on macOS
the kernel's refusals under it are recorded and attributed exactly as under
`srt`.

## The contract for a sandbox of your own

```toml
[sandbox]
provider = "mybox"

[sandbox.providers.mybox]
command = ["mybox", "run", "--policy", "{policy}", "--"]
```

For each run, seisin starts:

```
mybox run --policy <settings file> -- <the command>
```

`{policy}` may appear inside an argument (`--policy={policy}`). The command must
contain it: a sandbox that never sees the policy cannot be enforcing it.

Optionally, a command that answers before anything runs whether the sandbox
can hold a policy:

```toml
[sandbox.providers.mybox]
command = ["mybox", "run", "--policy", "{policy}", "--"]
check = ["mybox", "check", "--policy", "{policy}"]
```

Exit 0 is yes. Anything else is no, and the last line it prints is the reason
seisin shows; a check that cannot be run, or does not answer in 15 seconds, is
a no too. With a check, a sandbox that says no is passed over like any other,
so `provider = ["mybox", "srt"]` runs a role `mybox` cannot hold under `srt`.
Without one, seisin only finds out at the canary, which stops the run (exit 86).
The check is asked; it is not trusted: a yes still goes through the canary.

What the sandbox takes on:

1. **The file is seisin's settings for this run**, in the schema of
   `@anthropic-ai/sandbox-runtime`: top-level `network` (`allowedDomains`,
   `deniedDomains`, `allowUnixSockets`, `allowLocalBinding`) and `filesystem`
   (`denyRead`, `allowRead`, `allowWrite`, `denyWrite`). In `filesystem`, a deny
   wins over an allow, except that `allowRead` re-opens a path inside a
   `denyRead`. Entries may be globs.
2. **Enforce every field, or refuse to start.** If any part of the file cannot
   be enforced, exit non-zero before running anything. Never run the command
   with less.
3. **The file itself is not readable from inside.** It is in the run's
   directory; deny it like the rest of what the file denies.
4. **Pass the exit status through**, 128 + n for a signal.

`srt` meets this contract as it is:

```toml
[sandbox.providers.viacommand]
command = ["srt", "--settings", "{policy}", "--"]
```

The test suite runs exactly that, and runs a "sandbox" that ignores the file to
check that the canary stops it before anything of the agent's starts.

**The kernel's refusals, on macOS.** seisin reads them from the system log,
filtered by the tag sandbox-runtime adds to every Seatbelt denial
(`(with message "CMD64_<base64 of the command>_END__<suffix>_SBX")`, the
command being the first 100 characters of what follows `--`, as a shell line,
and the suffix nine `[a-z0-9]` drawn once per sandbox process). A sandbox that
adds the same tag says so:

```toml
[sandbox.providers.mybox]
command = ["mybox", "run", "--policy", "{policy}", "--"]
tags_denials = true
```

and its refusals are recorded like `srt`'s. One that does not still holds the
boundary, but none of its refusals reach the log: the filter drops them before
seisin sees them. `seisin run` and `seisin check` say so for such a sandbox,
rather than leave a log that looks like nothing was refused. On Linux there is
no stream to read under any sandbox.
