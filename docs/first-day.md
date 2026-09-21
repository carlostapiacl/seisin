# What will look like a bug on the first day

Four shapes a correct policy still produces, that read as breakage. Every one of them cost
somebody an afternoon before it cost a paragraph.

*Part of [seisin](../README.md).*

Four shapes that a correct policy still produces, and that a reader reads as breakage. All
four come out of one production window — four agent cells, ~370 confined turns over three
days, 1,409 kernel denials — where none of them was the boundary misbehaving. They are here
because every one of them cost someone an afternoon before it cost this paragraph.

**1 · Granting a file does not grant its neighbours.** The kernel grants exactly the path you
wrote. Anything a tool creates *beside* it — a database journal, a lock file, the temporary
file of an atomic write — is a sibling, and a sibling is outside the grant. The failure then
arrives in the tool's own words rather than as a permission error, which is why it survives a
policy review: the policy looks right because it *is* right about the file you named.

`seisin check` says so before you hit it:

```
N role(s) grant individual files rather than folders: reviewer (3 of 11)
```

Grant the folder where the tool needs neighbours. `seisin check <role>` names the paths.

**The Claude Code case is worth stating outright**, because it is the agent most people will
point this at first: `Write` and `Edit` do not write the file you named. They write
`<name>.tmp.<pid>.<random>` next to it and rename over the target. So a grant on a literal
file path is both correct and useless — `seisin explain` answers *allowed* about the
destination, the kernel answers `Operation not permitted` about the temporary, and neither is
lying. Grant the directory.

**2 · `.git/index.lock`, in a repo the role does not own.** In that window this single
filename was **1,071 of the 1,409 denials** — three quarters of everything the kernel said no
to. A role runs `git status`, git tries to refresh the index of a checkout that belongs to
another role, and the lock write is denied.

Measured again six days later on the same deployment, with thirty-two times the volume:
**1,080 of 1,422**, the same three quarters, and by then it was one filename across eight
paths. Two windows, one shape — [the second one is in the field
notes](field-notes.md#1--three-quarters-of-everything-the-kernel-refused-was-one-lock-file),
with what it cost and what removed it.

It is noise, not a wall, and the distinction is measurable: inside the box
`git status --short --branch` and `git log` still exit 0. Git cannot refresh its index cache
and carries on without it. If a role genuinely needs to commit, give it **its own worktree**
rather than a share of the main index — two agents staging into one index corrupt each other
regardless of who is allowed to write it.

**3 · Worktrees are two paths for one repo.** A policy names the canonical checkout; the
process is running in a linked worktree somewhere else entirely, and to the kernel that is a
different place. seisin resolves the pair rather than making you write both — `seisin whose`
and `seisin explain` answer the same thing from either side, and say which checkout they are
talking about. Worth knowing it is handled, because the symptom when a tool does *not* handle
it is a role denied inside its own territory.

**4 · SQLite reports a denied write as `attempt to write a readonly database`** — see
[below](agents.md); it is the one that sends you to debug the
database instead of the policy, and the reason `seisin wire` exists.

Where these stand: the sibling case is a `check` warning instead of a surprise, the worktree
case is resolved in the tool, the SQLite case is named by the hook, and the git one is
friction that gets logged rather than silenced — a boundary that hides what it denied is the
thing this project exists to argue against.
