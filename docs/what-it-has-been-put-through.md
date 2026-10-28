# What it has been put through

Every claim in the README comes from something on this page: the test suite, five reviews, and
the defects I found myself. Open findings are listed as open.

## The suite

[CI](../.github/workflows/test.yml) runs the suite on macOS and `ubuntu-latest` (bubblewrap),
Node 18/20/22/24, on every pull request and every push to `main`. A release is published only
from CI, after that passes ([publish.yml](../.github/workflows/publish.yml)), with npm provenance.

Last run on `main`, 2026-10-27, 0.6.4, all eight jobs green. On Node 24:

| | tests | pass | skipped |
|---|---|---|---|
| macOS | 1120 | 1111 | 9 |
| `ubuntu-latest` | 1119 | 1090 | 29 |

The skips are platform tests. Some tests run real commands through the real sandbox and check
what the kernel did; 26 of them are the core boundary file, `test/sandbox.test.js`, and the job
**fails if those skip**, because a run that tested nothing looks green too. A few:

```
✔ a role reads the key it declares
✔ a role cannot read another role's key
✔ each role reads its own, so the deny is not just blanket
✔ a role writes inside its territory
✔ a role cannot write outside it
✔ reading another role's code still works
✔ the boundary survives a grandchild process
✔ an absolute path does not walk around the rule
✔ CR-1 · a missing boundary refuses to run, and the child never starts
✔ CR-2 · ownership does not depend on which role is asking
✔ seisin refuses to run inside seisin, by name
✔ an isolated role starts, and loses the credentials the ordinary mode leaves open
```

The [2026-10-02 review](reviews/2026-10-02.md) and its [follow-up](reviews/2026-10-02-followup.md)
record the portable checks apart from the kernel ones.

### Where each claim was actually run

macOS enforces with Seatbelt and Linux with bubblewrap, so "it works" is a claim per platform.

| | macOS 15 · Seatbelt | Linux · bubblewrap |
|---|---|---|
| the suite | CI, every push | CI, every push; also Debian 12 locally (bwrap 0.8.0, Docker `--privileged`) |
| `isolate = "home"` | yes (did not start at all before the socket fix, below) | yes |
| `isolate = "credentials"` | yes | yes |
| Claude Code 2.1.270 | yes | not run |
| opencode 1.18.30 | yes | not run |
| codex 0.150.1 | yes, with its own sandbox off | not run |
| LangGraph 1.2.11 | yes | not run |
| gemini 0.57.0 | started only, not run against a policy | not run |
| Windows | not run | not run |

The suite is what asserts the boundary holds, on both. The agent runs show that real tools work
inside it, and they have only been done on macOS.

## Prompt-injection attacks, turned into tests

GitHub Security Lab showed a prompt injection rewriting `.vscode/settings.json` to turn on tool
auto-approval. VS Code reloads that file at once, so asking a person to keep or undo the change
afterwards is too late.

seisin already protected `.mcp.json`, `.claude/`, git hooks and Codex's config: files that make
a program outside the sandbox act. `.vscode/` was not on that list. `sandbox-runtime` protects it,
but only in the directory the run starts in ([#432](https://github.com/anthropics/sandbox-runtime/issues/432)),
so a nested project's `.vscode` was open. Since 0.5.0, `.vscode/`, `.cursor/` and `.windsurf/` are
protected by default, and `CLAUDE.md`, `AGENTS.md` and similar when the policy turns that on. A
policy can hand either family to the role that maintains them.

The first version denied every `CLAUDE.md` a team edits several times a week, and had three more
problems (npm dropping the files, a `git checkout` leaving them stale, `check` listing paths that
did not exist). That is why the protection is by exact pattern at each project's root, and only
where the files exist.

Each test fails with the protection switched off:

| id | tries | result |
|---|---|---|
| ATTACK-009 | rewrite a nested project's `.vscode/settings.json`, move it aside, create a `.cursor/` | denied |
| ATTACK-009b | the same, by a role handed `control_files = ["ide"]` | written |
| ATTACK-010 | rewrite a nested `AGENTS.md`, create a `CLAUDE.md` | denied |
| ATTACK-011 | append to `~/.npm/_logs` and `~/.claude/debug` | denied |

ATTACK-011 was a separate finding: the pinned runtime makes those two directories writable on its
own, outside the territory seisin prints. Both are denied now.

Not covered: terminal escape sequences in output pass through as they are, and allowing an MCP
server decides whether it can be called, not whether its output steers the model.

Source: [GitHub Security Lab, *Safeguarding VS Code against prompt injections*](https://github.blog/security/vulnerability-research/safeguarding-vs-code-against-prompt-injections/).

## Five reviews

Reviews 1 and 2 came from outside and were not commissioned. 3 is the second reviewer again, on
the fixed version. 4 went through the config parser. 5 is the team that runs seisin, testing the
npm package before it was published.

### Review 1, architecture

Four findings, all reproduced before the fix.

| | what it was | now |
|---|---|---|
| **Policy and enforcement disagreed** | `ownersOf` read `src/*` as one level; the kernel got the whole subtree. `explain` said *denied* and the write landed | seisin refuses a pattern the kernel cannot express exactly, instead of widening it |
| **The audit trail was writable by what it audits** | `.seisin/` was in every role's write list | it left the territory; the hook sends lines over a socket and the parent writes the file |
| **Paths were not canonical** | `src/web/../api/orders.ts` matched frontend's `src/web/**`. The kernel still denied, but `whose` named the wrong owner | paths are resolved before any decision |
| **The README contradicted itself on Linux** | one section said the suite passed on Debian 12, another that it had never run there | CI runs both platforms on every push |

### Review 2, security

Ten findings; seven held up, each reproduced against the kernel before the fix and measured after.

| | what it was |
|---|---|
| **A full-repo role owned its own policy** | `writes = ["**"]` let the role rewrite `seisin.toml` and come back wider |
| **A grant could land in the wrong role** | granting to a role with only `keys` wrote the permission into the next role |
| **A reason could become configuration** | the typed reason went into a comment unescaped, and a newline ends a comment |
| **A key could point outside the key directories** | `keys = ["../.ssh/id_rsa"]` was a read grant |
| **`--observe` was read from the whole command line** | an agent's flag could change seisin's mode |
| **The audit socket sat in writable scratch** | it could be unlinked |
| **Every role shared the real home** | `~/.claude`, `~/.cache`, `/tmp` |

Also: the MCP server's input buffer was unbounded, and its schemas were not enforced. The finding
that did not hold, reason injection, had already been stopped by the strict parser; the reason is
sanitised anyway.

What the fixes look like, run against the real kernel:

```
a role with the whole repo        the audit trail, from inside
seisin.toml          denied       rm .seisin/log.jsonl              denied
.secrets/            denied       echo WIPED > .seisin/log.jsonl    denied
.seisin/log.jsonl    denied       echo x >> .seisin/requests.jsonl  denied
src/ok.txt           written      unlink the audit socket           denied
```

Isolated mode, two roles: `a` cannot see the real `~/.claude`, write `b`'s home, or read it. That
last one was **wrong on this page for a day**: only the write had been measured, and `a` could read
the session token `b` had just written. A reviewer found it by reading the generated settings.

### Review 3, the same reviewer on the fixed version

Confirmed the seven closed and found eight more.

| | what it was |
|---|---|
| **A policy could be cancelled further down the file** | duplicate tables and keys parsed, last one wins |
| **A key that is a symlink escaped its directory** | `.secrets/github-token.txt -> ~/.ssh/id_rsa` was a read grant on the ssh key, measured |
| **`check` mislabelled what it could not enforce** | and exited 0 on a config `run` would refuse |
| **The audit socket was at a guessable path** | any process of the same user could add lines |
| **Territory outside the repo was silent** | it is supported, and it is a different promise |
| **`env = ["GITHUB_TOKEN"]` was silent** | a secret reaching a role without being a declared key |
| **Reading was wide open** | `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.config/gh` readable to every role |
| **Isolated mode was off by default** | so the shared-home fix only helped people who turned it on |

The last two are a threat-model question. The first answer was "`isolate` closes it, and stays
opt-in", but opting in signed the agent out of its CLI. Since 2026-09-14 there are two levels:
`isolate = "credentials"` closes those reads and the agent stays logged in; `isolate = "home"` is
stronger and costs the login. The default is still `read = "all"`.

### Review 4, the config parser

`[roles.__proto__]` does not show up in `Object.keys(roles)`, so `check` listed the visible roles
while every one of them inherited what that table declared. A `frontend` with `keys = []` came out
owning the whole repo and holding `GITHUB_TOKEN`. The parser now refuses the three reserved names
and builds every table with a null prototype, and `loadConfig` reads only declared properties;
each fix was tested on its own.

The same review moved config output to one rule instead of three, validated log entries like queue
entries (a confined process could write `allowed` lines, which feed `review` and
`init --from-observations`), and corrected the README's count of sandbox tests.

### Review 5, the npm package before publishing

The team installed the tarball globally and ran it end to end: the denial, the request in the
queue, the grant rewriting `seisin.toml` with its comments intact, and the same run passing after.
Two defects, both in `init --from-observations`:

| | what it was |
|---|---|
| **A file became a directory** | a write to `NOTAS.md` proposed `NOTAS.md/**`, which grants nothing over the file |
| **Idle roles were deleted** | it emitted only the roles seen in the log, so moving the file into place removed every idle role's territory. It adds now, and marks what came from where |

Open from that run: the agent knew whose file it was, but found out by reading `seisin.toml` itself;
what it was handed was `EPERM`. The hook does return the owner's name for `Write` and `Edit`.
Whether that reached the agent's context in that run is not known yet.

## Found without a reviewer

### `isolate` never started on macOS

Turning it on to measure its cost showed it failed for every role:

```
Error: listen EINVAL: invalid argument
  /var/folders/.../T/seisin-home-<16 chars>/dev/tmp/srt-mux-34547-0.sock    106 bytes
```

The runtime puts a socket inside the role's home, and a unix socket path is capped near 104 bytes.
The name went from `seisin-home-` plus 16 characters to `sn-` plus 8, and `settingsFor` now refuses
with its own message. Shortening it showed the id was the tail of the path's base64:
`/Users/ana/dev/proyecto` and `/Users/bob/dev/proyecto` got the same home, session token included.
It is a hash of the whole path now. No test had turned the feature on; three do now, one of them
end to end. Verified on macOS 15 and on Debian with bubblewrap 0.8.0: 148 of 148.

### `seisin run` was broken on Linux

Every run died with `denials.attributeTo is not a function`: the inert watcher Linux gets was
missing a method. The sandbox tests did not catch it because they looked for the runtime with
`command -v srt` and missed the bundled copy, so they skipped. Now the inert watcher has the same
methods as the live one (tested for `linux`, `win32` and `freebsd`), and the tests find the runtime
the same way `seisin run` does. Verified on Debian 12.15 with bubblewrap 0.8.0: 225 of 225, plus a
real run.

## Still open

- **Deleting inside your own territory.** Write includes delete for the kernel. Asked upstream
  ([measurement](upstream/denyUnlink.md): 66 times in about 330 runs of real agent work).
- **Forged lines in the audit trail.** An agent can send lines, so it can pad its history. It cannot
  erase or alter what is there, and the log is tamper-evident.
- **Reading is wide by default.** With `read = "all"` and no `isolate`, every role reads `~/.ssh`,
  `~/.aws`, `~/.npmrc` and `~/.config`. `isolate = "credentials"` or `read = "territory"` close them.
  Whether one role may read another's session is the remaining choice; see `decisions.md`.
- **No resource limits.** CPU, memory, PIDs and disk are not bounded.
- **Windows.** Never run.
- **No fuzzing.** The parser has a property test over a fixed corpus.
- **Processes an agent leaves running.** That is the sandbox's call. On macOS (measured 2026-10-16),
  under `srt` a double-fork, `nohup` or `setsid` outlives the run, still confined but unwatched;
  under `tartaros` only `setsid` does. On Linux both end with the run (read from source, not
  measured). If `seisin run` is killed, `tartaros` on Linux dies with it and `srt` keeps going.
- **`explain` on case-insensitive or normalising disks** can be stricter than the kernel, never looser.
  `check` shows what the kernel is given.
- **Private LAN addresses.** Loopback, link-local and cloud metadata are denied by default; RFC1918,
  CGNAT and ULA only with `[network] deny_addresses`. An allowed domain gets every port.
- **A hard link placed from outside.** A role cannot create one across territories (measured), but
  one placed inside its territory by someone else lets it write that file. Do not hard-link a
  sensitive file into an agent's territory.
- **A planted repository under another name.** A role can write a git repository not named `.git`
  plus a `.git` file pointing at it; a `git status` outside the sandbox then runs its config. Asked
  upstream.
- **A hash chain stripped whole, with its start record deleted**, reads like a log from before the
  chain existed; `log verify` says the start is not recorded. The record lives in `.seisin/`, which
  no role can write.

## The claim this supports

seisin confines the mistakes of agents you run yourself, using the operating system rather than
pattern-matching, with per-role write isolation and isolation of the keys you declare. Against a
hostile agent, the guarantee is the one of the sandbox you run it under.
