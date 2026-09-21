# Keys

How a role reaches a credential: key directories, references, providers, delivery modes,
and the four ways a secret leaves a process.

*Part of [seisin](../README.md).*

Four ways out of a process, and seisin closes three of them. The fourth is named below,
because a security tool that lists only its wins is not one.

| way out | closed by | how |
|---|---|---|
| reading another role's key file | the kernel | the key directory is denied, each declared key re-allowed. Survives a grandchild process and an absolute path |
| a key riding in the environment | the launcher | the child's environment is **built, not inherited**. Measured before this existed: 93 variables crossed into every turn, a planted token among them |
| spilling a key the role does hold | the launcher | the value is masked on stdout and stderr, including when it lands split across two buffers |
| sending it somewhere | the kernel | egress is allow-only. `curl` to a domain you did not list gets nothing |
| **a key stored outside the declared directories** | **nothing** | `seisin scan` finds them so you know what is not covered — or keep it in a vault and name it by [reference](#a-key-can-be-a-reference-instead-of-a-file) instead of by path |

```toml
[keys]
dir = [".secrets", "config/credentials"]   # one directory or several

[roles.frontend]
keys = ["netlify-token.txt"]   # everything else in those directories is denied
env  = ["BUILD_ID"]            # everything else in the environment is dropped
```

### A key can be a reference instead of a file

A path only reaches a secret that is already on your disk in the clear. Most secrets that
are looked after at all are not: they are in a keychain, in 1Password, in Bitwarden, in
`sops`. So a key may also be a **reference with a scheme**, resolved by a provider you
declare in the same file:

```toml
[keys.providers.keychain]
command = ["security", "find-generic-password", "-w", "-s", "{ref}"]
mode    = "env"                       # how every key of this provider is delivered

[keys.providers.op]
command = ["op", "read", "{ref}"]

[roles.frontend]
keys      = ["keychain://netlify-token", "netlify-token.txt"]   # both forms coexist
key_mode  = "env"                     # per role, and it wins over the provider's
```

A provider is **a command with a placeholder**, on purpose: adding Vault or `sops` is three
lines of TOML and no code. The value arrives as `NETLIFY_TOKEN` — last segment, uppercased —
or under a name you give it: `keys = ["NETLIFY_AUTH_TOKEN=keychain://netlify-token"]`.

#### `file://` ships with it, because a secret in a file is the common case

```toml
[roles.frontend]
key_mode = "env"
keys = [
  "TOKEN=file://.secrets/netlify.txt",            # the whole file
  "RESEND_KEY=file://.secrets/all.env#RESEND_KEY" # one KEY out of a file of many
]
```

No provider to declare. The path resolves against the policy file's directory — not the
current one, because a key that resolves differently depending on where you were standing
works in your shell and fails in the agent's.

A fragment reads one value out of **an env file or a JSON object**, whichever the file turns
out to be — sniffed from the content, because the name lies often enough to matter. In an env
file, `export` and surrounding quotes come off; in JSON, `#a.b` reaches a nested key and a
literal `a.b` beats that reading. An object or an array is not a credential and is refused
rather than stringified. A fragment naming something the file does not have is an error,
never an empty value.

**Those two formats, and no more.** A secret sitting inside a document — a runbook, a table,
a page of notes — is not reachable by a fragment and should not be: extracting from prose is
guessing, and a tool that guesses at credentials hands over the wrong one instead of failing.
The error says so, and says the fix is to move the secret out of the document.

**This is the thing `keys = ["all.env"]` cannot do.** A file grant is a file grant: that form
hands the role every variable in the file and lets it read them. `file://…#ONE` hands over one
value and grants no read at all. Verified against the kernel.

`file://` is the only built-in and it cannot be redefined — one scheme meaning two things in
two repos is the failure this feature exists to remove.

#### The provider contract

Anything that can print a secret to stdout is a provider. That is the whole interface, and it
is stable:

| | |
|---|---|
| **input** | your `command`, with every `{ref}` replaced by the text after `://`. No shell: the array is the `argv`, so a reference cannot inject one |
| **success** | exit `0`, the value on **stdout**. Exactly one trailing newline is stripped |
| **failure** | any non-zero exit, or empty output. The run stops; nothing is substituted |
| **diagnostics** | **stderr** is passed through to the human. `stdout` never is, so a provider that prints the secret and then fails does not leak it into the terminal or the log |
| **where it runs** | the parent, unsandboxed, before the child starts — it holds your vault's credential and the confined side must not reach it |
| **what it must not do** | prompt on a tty an agent does not have. Cache your session first (`op signin`, `gpg-agent`, an unlocked keychain) |

#### Recipes

Three of these were run against the real thing on macOS 15; the rest follow each tool's
documented CLI and are **not measured here** — the contract above is what they have to meet.

```toml
[keys.providers.keychain]   # ✅ measured
command = ["security", "find-generic-password", "-w", "-s", "{ref}"]

[keys.providers.gpg]        # ✅ measured — see the script note below
command = ["./bin/open.sh", "{ref}"]

[keys.providers.op]         # 1Password — not measured here
command = ["op", "read", "{ref}"]

[keys.providers.bw]         # Bitwarden
command = ["bw", "get", "password", "{ref}"]

[keys.providers.sops]
command = ["sops", "-d", "--extract", "{ref}", "secrets.enc.yaml"]

[keys.providers.pass]       # the standard unix password manager
command = ["pass", "show", "{ref}"]

[keys.providers.vault]      # HashiCorp
command = ["vault", "kv", "get", "-field=value", "{ref}"]

[keys.providers.aws]
command = ["aws", "secretsmanager", "get-secret-value", "--secret-id", "{ref}", "--query", "SecretString", "--output", "text"]

[keys.providers.gcloud]
command = ["gcloud", "secrets", "versions", "access", "latest", "--secret={ref}"]
```

If one of these is wrong, a pull request fixing it is worth more than an issue: the table is
the part of this that ages.

**Put anything with a pipe or a quote in a script.** The config format has no escapes, so a
command cannot contain a `"` — and a shell pipeline inside a TOML array is unreadable in a
diff, which is what this feature exists to fix. A script is also how you compose:

```sh
#!/bin/sh
# encrypted file, password in the keychain. Nothing in the clear on disk.
gpg --batch --quiet --passphrase "$(security find-generic-password -w -s master)" -d "$1"
```

Scripts named by a provider are **denied to every role**, the same way `seisin.toml` is — the
parent executes them, so a role that could rewrite one would decide what runs outside the box.

| | |
|---|---|
| **`mode = "env"`** | resolved and passed as a variable |
| **`mode = "scratch"`** | written to a file in the run's scratch space, removed when the turn ends. The path arrives **both** as `NETLIFY_TOKEN` and as `NETLIFY_TOKEN_FILE` — `_FILE` is the Docker-secrets convention, while `KUBECONFIG` and `GOOGLE_APPLICATION_CREDENTIALS` already expect a path in the plain name. Neither holds the value |
| **`mode = "inject"`** | the agent never sees the value — **not implemented**, and refused by name rather than left looking available. It needs the runtime's credential masking, which does not load without terminating that role's TLS with a CA of seisin's own. That is MITM over all of the role's traffic, and it is a decision to take deliberately |

There is **no default mode**. A reference with none declared anywhere is an error, because
the answers differ in what the agent can walk away with and picking one for you is picking
how much a leak costs you.

**Four rules, each of which is the feature rather than a precaution around it:**

- **The value never enters the `.toml`, the log or the console.** What is written, recorded
  and approved is the reference. That is what makes a key policy reviewable in a diff.
- **An unknown scheme is refused, not ignored.** `keys = ["vault://x"]` with no
  `[keys.providers.vault]` is a configuration error, never a key that quietly never arrives.
- **The parent runs the provider, never the confined process.** The provider command holds
  the vault's own credential; running it inside the box would put that credential in there
  too, which is the thing this is for.
- **A provider that fails does not degrade.** Not to empty, not to a file of the same name,
  not to a skipped key. The run stops and says so.

`seisin check` validates all of this **without resolving anything** — the scheme, the
provider, the mode, and whether the provider's command is even on `PATH` — so a broken
policy is visible without asking anyone's keychain for a password. It also **prints the
provider commands**, because of the next paragraph.

> ⚠️ **A provider command is the one thing in a `seisin.toml` that executes.** Everything
> else in the file describes a boundary; this runs, in the parent, unsandboxed, as you. So
> a `seisin.toml` that came with a repository you cloned is code you are about to run —
> the same trust you already extend to a `Makefile` or a `package.json` script, and worth
> saying out loud precisely because the rest of this tool invites the opposite assumption.
> `seisin check` runs nothing and lists them; read it first on a config you did not write.

**A provider that is a script in your repo is denied to every role**, the same way
`seisin.toml` is. The parent executes it, so a role that could rewrite it would decide what
runs outside the box — not a wider boundary, no boundary, arriving disguised as an ordinary
file in somebody's territory. A provider found on `PATH` (`security`, `op`, `gpg`) is left
alone: that is a machine, not a repo.

**The config format has no escapes, so a command cannot contain a `"`.** Put a shell
pipeline in a script and name the script — which is also how it stops being unreadable, and
is why the examples below are scripts:

```sh
#!/bin/sh
# the file is encrypted; its password lives in the keychain. Nothing in the clear on disk.
gpg --batch --quiet --passphrase "$(security find-generic-password -w -s master)" -d "$1"
```

```sh
#!/bin/sh
# one key out of a key=value file: ref is "<file>#<KEY>"
f=${1%%#*}; k=${1#*#}
sed -n "s/^$k=//p" "$f" | head -1
```

Measured with both: the role receives the one value, does **not** receive the other keys in
the same file, and cannot read the file.

**A key's name may not collide with one the child already needs.** `keys =
["keychain://path"]` would arrive as `PATH`, and `SEISIN_ROLE` is how the hook inside the
box learns which role it is — a policy that could set it could tell the hook it is somebody
else. Both are refused when the config loads, as is one name claimed by two keys.

**And what it does not do, in the same breath:** this resolves the secret **at rest**, not
in the agent's context. The value still reaches the process and the agent can still read it.
The secret stops living on your disk and the policy holds a reference you can review — a
strict improvement — but "the agent never sees it" is `inject`, and `inject` is not built.

### A database is four files, and you declare it once

`bitacora/team.sqlite` is not a database — it is one of the files a database is made of.
Writing to it also writes `-wal` and `-shm`, or `-journal`, so *"this role writes this
database"* used to take four lines. Measured on one real policy: **744 of 1,248 write lines,
60%, were sidecars**, and every single one had its `.sqlite` declared beside it.

Now the database is enough:

```toml
[roles.dev]
writes = ["bitacora/team.sqlite"]     # -wal, -shm and -journal come with it
```

**It grants nothing that was not already granted**, which is why it is safe to do without
asking: the `-wal` holds that database's pending transactions, so whoever can write the
database can already empty it. The sidecar is not a second resource, it is the same one.

The expansion is visible to `whose` and `explain`, not just to the kernel — the owner of a
database is the owner of its `-wal` everywhere, or the boundary and the sentence would
disagree. `seisin check` prints it back collapsed, because four lines of one name is what
this removed.

**The suffix list is closed on purpose:** `-wal`, `-shm`, `-journal`, and only after a name
ending in `.sqlite` or `.sqlite3`. `.db` is not included — plenty of things are called that,
and a grant to create `whatever.db-wal` inside somebody else's directory would be new
authority arriving quietly. A database with another name declares its sidecars by hand.

**If your agent runs hooks of its own, they need a line here too.** Whatever a hook reads to learn which role it is gets dropped with everything else, and the symptom is two layers disagreeing about one file — your hook refusing a write that seisin just allowed, and the lower one is the one that is right — until the variable is named in `env`.

**What this bought, measured rather than argued.** Over the same production window — four
agent cells, ~370 confined turns, three days — **every denied read was a read of something
the policy had declared a key.** 148 of them, no exceptions, from five different roles, and
not one was doing anything unusual: they were running searches that swept a repository root.
That is how a key gets read without anyone deciding it should, and it is the whole case for
declaring the key directory rather than trusting the instruction not to look.

Refused *writes* were a different story, and both halves are worth reading: those were
ordinary collisions between roles, the boundary keeping two agents out of each other's work.
It is the reads where the policy was the only thing there.

**Two things this deliberately does not claim.** Redaction masks a literal value on the way
through the launcher — a key written straight to a file never passes through it, and neither
does one the agent base64'd first. It narrows a careless print; it is not a containment
boundary. And to mask a value seisin must read it, so a role's own keys pass through this
process in memory. `[runtime] redact = false` turns that off.
