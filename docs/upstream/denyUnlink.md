# Upstream ask · `denyUnlink`

Issue for [anthropic-experimental/sandbox-runtime][repo]. Kept here because
`seisin check` reports this gap to users, and a documented gap should say what
is being done about it.

Verified against **0.0.76** on 2026-09-13; every command below was run.
(`srt --version` reports `1.0.0`, which does not match `package.json` — trust
the package version when reproducing.)

[repo]: https://github.com/anthropic-experimental/sandbox-runtime

---

## The issue, as posted

> **Title:** `filesystem`: allow `unlink`/`rename` to be denied inside write-allowed paths

````markdown
## Summary

A write-allowed path can also be deleted or moved, and there is no opt-in path
to anything narrower. "May edit this file" and "may destroy this file" are one
permission today.

`.git` is the case that cannot be worked around with `denyWrite`, because the
runtime deliberately keeps it writable — `sandbox-utils.js`:

    export const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea'];
    /** Excludes .git since we need it writable for git operations -
     *  instead we block specific paths within .git (hooks and config). */

## Reproducer

settings.json — writes allowed in the project, nothing else:

```json
{ "network": { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": [], "allowLocalBinding": false },
  "filesystem": { "allowRead": ["/tmp/x/proj"], "denyRead": [], "allowWrite": ["/tmp/x/proj"], "denyWrite": [] } }
```

```bash
# proj/ is a git repo with one commit
srt --settings settings.json -- sh -c "rm -rf /tmp/x/proj/.git"

ls proj/.git          # config  hooks      <- directory survives
git -C proj log       # fatal: not a git repository   <- history does not
```

`objects`, `refs`, `HEAD` and `index` are gone. `rm` stopped only when it
reached the denied `.git/hooks` and could not remove a non-empty directory, so
what is left on disk looks like an intact `.git`.

## Notes

- The mechanism is already there, just never fed anything but denies:
  `generateMoveBlockingRules` (`macos-sandbox-utils.js:433`) denies
  `file-write-unlink` + `file-write-create` for any pattern list; `:522` passes
  it only `resolved.denies`; `:542` then re-allows both for every write root
  unconditionally. A `filesystem.denyUnlink` list subtracted from
  `writeAllowFilters` at `:542` and added at `:522` looks sufficient from
  outside.
- `rename` has to be in scope, or the same files are destroyed by a different
  syscall. The existing rule already pairs unlink with create for that reason.
- **Linux:** bubblewrap is mount-based (`--ro-bind` gives read-only, not
  "writable but not deletable") and seccomp cannot filter on path arguments, so
  this is probably macOS-only. Precedent: `allowMachLookup` (#83). A field that
  silently did nothing on Linux would be worse than the gap — better to refuse
  to start there, as an invalid config already does.
- Measured downstream: over ~330 rounds of a multi-agent run, 66 destructive
  commands landed inside a role's own writable tree (34 recursive deletes, 11
  `reset --hard`), each one permitted by the sandbox and caught only by a
  text-inspecting guard in front of it.
````

---

## Longer rationale · not part of the issue

Kept for this repo's own readers. The issue above is short on purpose: the
accepted issues in that repo run 83–592 words and are summary / reproducer /
notes, so anything past that is noise to the person reading it.

### Why the path axis cannot cover this

The runtime already accepts that a write-allowed tree needs exceptions inside
it: `.git/hooks` is always denied, `.git/config` is denied unless
`allowGitConfig`, and `.vscode` / `.idea` / `.claude/commands` /
`.claude/agents` are denied outright. One of those exceptions is already
caller-controlled.

So the shape exists on the **path** axis, hardcoded. `.git` is where it runs
out: it has to stay writable for git to work, which means it also stays
deletable. The operation axis is the only one that reaches it.

### Where the 66 came from

Counted from the run logs of a private multi-agent deployment — the same one the
`seisin check` guidance comes from. The breakdown, not the raw logs:

```
913  blocked actions, ~330 rounds
112  destructive
 46  ...aimed at ANOTHER role's paths   -> a path boundary already refuses these
 66  ...inside its OWN writable tree    -> permitted by the box, every one
```

The 46 are excluded deliberately; counting them would inflate the ask with
cases the existing path boundary already covers. The number in the issue is the
corrected, smaller one.

### Why this does not depend on seisin

The reproducer is `srt` and a settings file. The principle is quoted from the
runtime's own source. The exposure applies to any caller that lets a process
write the tree it is working in — one agent, one project, one command.
