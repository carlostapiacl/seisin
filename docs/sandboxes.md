# Sandboxes: who enforces the policy

seisin decides what each role may do; a sandbox enforces it. Three can do that:

| sandbox | what it is | how seisin talks to it |
|---|---|---|
| `srt` (built in, the default) | `@anthropic-ai/sandbox-runtime`: Seatbelt on macOS, bubblewrap on Linux | the settings file, as is |
| `tartaros` (built in) | Seatbelt on macOS; Landlock, seccomp and cgroups on Linux | the settings translated to its flags |
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
recorded. A single name means exactly that sandbox: a role it cannot hold does
not start, and the error names what was missing:

```
seisin: no sandbox in [sandbox] provider can hold role backend as its policy is written, so it was not started:
  - tartaros cannot enforce all of it:
      a write denied inside a writable path (/repo/.git in /repo): tartaros cannot deny a path inside one it lets the role write
```

`seisin check` says which sandbox each role would get, and why the others were
passed over, before anything runs. It exits 1 if a role has none.

The rule is the one in [decisions.md](decisions.md#a-second-sandbox-only-where-it-enforces-the-policy-exactly):
choosing a sandbox is a question of what it can enforce, not a preference
toggle. Falling back is allowed; enforcing less than the policy says never is.

Whichever sandbox is chosen, every run starts with the canary ([src/canary.js](../src/canary.js))
under that sandbox and the same settings. If the boundary does not hold, no
agent starts (exit 86).

## tartaros: what translates and what does not

| the settings ask for | under tartaros |
|---|---|
| writes inside the role's paths | `--write <path>`, per path that exists |
| reads denied by path | `--read-deny <path>` |
| loopback ports (`local_ports`) | `--port <n>` |
| no network | the default |
| no unix sockets (Linux) | `--deny-unix` |
| a write denied **inside** a writable path (`.git`, `.claude`, `never_writes`, the agent's own files) | not expressible: passed over |
| a read re-opened **inside** a denied path (this run's directory inside the runs root, a key inside its directory) | not expressible: passed over |
| a path pattern (`**/.git/hooks/**`) | not expressible: passed over |
| network by domain (`network = ["github.com"]`) | not expressible: passed over |
| listening (`local_binding`) | not expressible: passed over |
| one unix socket, the audit channel (macOS) | not expressible: passed over |

Today, every role seisin generates needs at least the first two "not
expressible" rows: each run's directory is re-opened inside the runs root it
denies. So tartaros is passed over for every role until it can say both. That
is the rule working: running a role under a sandbox that would let it read
other runs' policies and keys would be enforcing less than the policy says.
`seisin check` lists exactly what is missing, role by role.

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

What seisin cannot do through a declared command: read the kernel's denials
with the sandbox's own attribution. On macOS they are still attributed by
process tree, so a denial is recorded when the refused process is still alive
when its line arrives, and missed otherwise. Under `srt` the runtime's tag
covers that gap.
