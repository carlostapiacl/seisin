# Upstream ask · `denyUnlink`

> The ask this project takes to [anthropic-experimental/sandbox-runtime][repo].
> Kept here because
> `seisin check` reports this gap to users, and a documented gap should say what
> is being done about it.
>
> Everything below was verified against the installed package, **0.0.75**. Note
> that `srt --version` reports `1.0.0`, which does not match `package.json` — so
> when reproducing, trust the package version, not the binary.

[repo]: https://github.com/anthropic-experimental/sandbox-runtime

---

## Title

`filesystem`: let `unlink`/`rename` be denied inside write-allowed paths

## The gap

A path that is write-allowed can be deleted, and there is no way to ask for
anything narrower. For a tool confining an agent, "may edit the file" and "may
destroy the file" are not the same permission, and today the schema cannot tell
them apart.

What makes this worth a schema change rather than a workaround: **the profile
already enforces the distinction**, just never in the direction a caller can
request.

```
policy: this role may WRITE in proj/src. Nothing else.

  append  src/app.ts         → permitted   (correct — it is its territory)
  rm      src/app.ts         → DELETED     (same permission, different act)
  rm      .env (read-denied) → blocked     ← the mechanism already exists
```

<details><summary>full repro</summary>

```bash
D=$(mktemp -d); cd "$D"; R=$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$D")
mkdir -p proj/src; echo hi > proj/src/app.ts; echo secret > proj/.env

cat > settings.json <<EOF
{ "network": { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": [], "allowLocalBinding": false },
  "filesystem": { "allowRead": ["$R/proj"], "denyRead": ["$R/proj/.env"],
                  "allowWrite": ["$R/proj/src"], "denyWrite": [] } }
EOF

srt --settings settings.json -- sh -c "rm -f $R/proj/src/app.ts"   # succeeds
srt --settings settings.json -- sh -c "rm -f $R/proj/.env"         # blocked
```

</details>

## Where it is, in your code

`dist/sandbox/macos-sandbox-utils.js` already has the whole mechanism, and it is
parameterised by an arbitrary path list:

```js
// :433 — takes any patterns, denies both ops
function generateMoveBlockingRules(pathPatterns, logTag) {
  return renderRule('deny', ['file-write-unlink', 'file-write-create'], …);
}

// :522 — but it is only ever fed the denies
rules.push(...generateMoveBlockingRules(resolved.denies.map(d => d.path), logTag));

// :542 — and then this takes it back for every write root, unconditionally
rules.push(...renderRule('allow', ['file-write-unlink', 'file-write-create'], writeAllowFilters, logTag));
```

The comment above `:542` explains exactly why it is there — a specific
`(deny file-write-unlink)` is not overridden by a later `(allow file-write*)`
wildcard, so without the re-allow, deletes break everywhere inside the project
directory. That reasoning is right. The ask is only that the re-allow gain an
exception list.

## Proposed surface

One field, same shape as its neighbours:

```jsonc
"filesystem": {
  "allowWrite":  ["/repo/src"],
  "denyUnlink":  ["/repo/src/**/*.py"]   // may edit, may not delete or move
}
```

Implementation, as far as I can see it from the outside: subtract `denyUnlink`
from `writeAllowFilters` at `:542`, and add it to the patterns passed at `:522`.
Seatbelt is last-match-wins and the write section is emitted after the read
section, which is the property the existing `denyWithinAllow` comment already
relies on.

**`rename` has to be in scope.** A guard that covers `unlink` and forgets
`rename` leaves the same file destroyed by a different syscall. Your existing
rule pairs `file-write-unlink` with `file-write-create` for precisely that
reason, so the fix inherits it for free — which is an argument for reusing this
path rather than adding a second one.

## The objection, stated first: Linux

This is where I would expect pushback, so: on macOS this looks like a few lines.
On Linux I do not think it is reachable today.

- bubblewrap is mount-based. `--ro-bind` gives read-only subtrees, not "writable
  but not deletable".
- `vendor/seccomp/{x64,arm64}/apply-seccomp` is a pre-built BPF filter aimed at
  `socket(AF_UNIX, …)`, and seccomp cannot filter on path arguments at all —
  BPF cannot safely dereference the pointer.

So the honest options are a macOS-only field, or nothing. A field that silently
does nothing on Linux would be worse than the gap it closes: a policy someone
believes is enforced is more dangerous than one they know is not. If it ships
macOS-only, I would want it to **fail loudly** on other platforms — refuse to
start, the same way an invalid config already does — rather than warn.

## Why this is being asked for

Downstream ([seisin][s]) gives each agent in a multi-agent setup its own
directories and its own keys, and delegates all enforcement here — deliberately,
because a tool like that has no business owning the correctness of a sandbox
profile.

The one thing it cannot express is this one, and the cost of that is measured
rather than assumed. An agent team running in production kept a text-inspecting
guard in front of the same work for ~330 rounds. It blocked 913 actions, of
which 112 were destructive — but that is the wrong number to bring here:

```
913  blocked actions, ~330 rounds
112  destructive
 46  ...aimed at ANOTHER role's paths   → a path boundary already refuses these
 66  ...inside the role's OWN territory → permitted by the box, every one
```

Sixty-six times, a role reached for a command that would have destroyed its own
uncommitted work — thirty-four recursive deletes, eleven `reset --hard` over a
shared tree, the rest git mutating the working copy — and the only thing that
stopped it was a program guessing at intent from the text of a command.

That is the ask stated as cost. The 46 are excluded on purpose: counting them
would inflate it with cases a path boundary already covers.

Note what the 34 recursive deletes imply for scope. The guard catches them by
path; `mv` of the same directory is one syscall away and ends with the same
files gone. Covering `unlink` and forgetting `rename` moves the accident rather
than preventing it.

So the choice today is to keep parsing commands to guess at intent, or to accept
the gap. `denyUnlink` is what would let it be neither.

[s]: https://github.com/carlostapiaolguin3-stack/seisin
