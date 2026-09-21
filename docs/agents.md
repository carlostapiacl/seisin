# Agents this has been run with

Which coding agents have actually been run under seisin, what each one needed, and the
one that has to be told to stop sandboxing itself.

*Part of [seisin](../README.md).*

seisin wraps a process, so in principle it works with any agent that runs as one — CLI or not. In
practice "in principle" is not a claim worth making about a permission tool, so here is what has
actually been exercised:

| agent | version | result |
|---|---|---|
| **Claude Code** (`claude -p`) | 2.1.x | Territory and keys enforced; HTTP(S) egress denied an undeclared domain by name |
| **opencode** (`opencode run`) | **1.18.30** | Same, **on a free model with no API key at all** |
| **LangGraph** (`python graph.py`) | **1.2.11** | Same, **enforced against the interpreter's own `open()`** — in-process tools, no child command to match |
| **codex** (`codex exec`) | **0.150.1** | Same, with its own sandbox off — see below. Refused twice: its patch tool, then the shell redirect it fell back to |

**seisin now says this before it starts one.** The error you get otherwise —
`sandbox-exec: sandbox_apply: Operation not permitted` — names neither seisin, nor the agent,
nor the fix, which in a tool whose claim is that a refusal explains itself is the worst message
available. It is a short closed list, checked before the spawn, and it only warns about an
agent whose own sandbox is actually on.

The codex run is the one that needed a flag. **An agent that sandboxes itself has to stop.** `codex` confines each command it runs with its
own `sandbox-exec` profile, and macOS refuses to apply a second Seatbelt profile to a process
that already has one — `sandbox_apply: Operation not permitted`, with the most permissive
profile that can be written, on both layers. So an agent like that runs under seisin with its
own sandbox turned off — `codex exec --dangerously-bypass-approvals-and-sandbox`, whose own
help says it is "intended solely for running in environments that are externally sandboxed".
It starts fine either way (`codex 0.150.1`, `gemini 0.57.0`, both verified), which is why this
is worth saying out loud: the failure arrives later, on the first command the agent tries to
confine.

Asked to write into another role's territory, codex failed through its patch tool, went looking
for a file ACL with `ls -le@` and `stat`, found nothing, and fell back to a shell redirect that
failed too:

```
/bin/zsh -lc "printf 'pisado\n' > qa/informe.md"
  exited 1: zsh:1: operation not permitted
```

Same shape as opencode, including the wrong diagnosis — it reasoned about file permissions,
not about ownership. That is the case for the hook: the boundary holds either way, but only the
hook can say *whose* it was.

All four on macOS 15 (Seatbelt). Linux is no longer a one-off measurement on one machine:
[CI](../.github/workflows/test.yml) runs the whole suite on Ubuntu and macOS, Node 18/20/22,
on every push — and fails if the sandbox half *skips*.

The opencode run is the interesting one, because **opencode has no per-path sandbox flag** —
its only permission control is `--auto`, "auto-approve permissions that are not explicitly
denied". Asked to write into another role's territory it failed twice: once through its own
`FileSystem.writeFile`, and again through the shell redirect it fell back to.

```
Error: Unknown: FileSystem.writeFile (.../qa/informe.md)
$ echo "revisado" > .../qa/informe.md
zsh:1: operation not permitted
```

That is the point of putting the boundary in the kernel instead of in the agent: **an agent
that cannot confine itself is confined anyway**, and adding a new one costs no adapter.

It also found a real bug. The scratch list named `~/.claude` and `~/.codex` and stopped there,
so the first agent that was neither did not fail a task — it failed to start, on its own log
file. A boundary that only fits the agents its author happened to use is a coincidence, not a
boundary. The XDG directories are in the list now.

The LangGraph run answers a different question: **an agent framework is not a CLI.** Its tools
are Python calls inside the same process, so there is no child command for a rule to match and no
argv to inspect — the write is the interpreter's own `open()`. A six-node graph asked to write into
another role's territory was denied there, denied again through the shell redirect it fell back
to, denied the other role's key, and denied an undeclared domain. Run as the other role, the same
graph gave the mirror image — every territory and key answer flipped, the undeclared domain denied
for both — and its SQLite checkpointer persisted normally inside whichever territory was its own.

One caveat belongs beside that row rather than after it: **a role is scoped to a process, and a
graph is one process.** Every node of one graph shares one territory and one set of keys. Per-node
territory means per-node subprocess, which is the thing an in-process framework exists to avoid.
seisin fits a multi-agent framework at the boundary of the whole graph, not between its agents.

And one failure mode worth meeting here rather than at 2am: SQLite reports a denied write as
`attempt to write a readonly database`, not as a permission error. That reads like a misconfigured
database, and you will debug the database. The hook names the owner instead — it is the case
`seisin wire` is for.

**Re-verified without an agent in the loop**, which is better evidence: an agent in the middle
makes a permission test non-deterministic — in that first run the agent reported the opposite
of what it had actually done. Wrapping a plain shell and a plain interpreter instead:

| as `dev`, with `qa/**` owned by `qa` | result |
|---|---|
| `sh -c 'echo x > proyecto/FILE.txt'` (own territory) | rc=0, created |
| `sh -c 'echo x > qa/report.md'` (shell redirect) | `Operation not permitted`, rc=1 |
| `python3 -c "open('qa/report.md','w')"` (the program's own syscall) | `PermissionError: [Errno 1]` |
| `rm -f proyecto/FILE.txt` (**destructive, inside** own territory) | **rc=0, file gone** |

The last row is not a bug, it is the shape of the tool: seisin answers *where*, not *what*.
A team running this in front of an agent fleet measured how often it matters: across ~330
rounds, sixty-six times a role reached for a command that would have destroyed its own
uncommitted work, and the kernel boundary permitted every one. The ask that would close it
is written up in [docs/upstream/denyUnlink.md](upstream/denyUnlink.md), filed against
the sandbox runtime rather than worked around here.

If you would rather see it than read it, [thirty seconds in a temp
directory](demo/) — an agent confined to its own project deletes the git history of the
repo it is working in, and the `.git/` left behind looks intact. Nothing installed, seisin not
used, because the gap is the runtime's and every tool on top of it inherits the same one.
