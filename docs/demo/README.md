# Your agent can delete the git history of the repo it is confined to

One agent. One project. One command.

The agent is confined to the project it is working in — it may write there and
nowhere else, which is the ordinary case a sandbox is for. Then it runs
`rm -rf .git`.

**macOS 15 · Seatbelt**

```
  BEFORE
    1 commit · a4b5980 the history that matters
    .git holds:   COMMIT_EDITMSG HEAD config description hooks index info logs objects refs

  $ srt --settings settings.json -- sh -c 'rm -rf proj/.git'
    rm was refused 17 time(s); every refusal was under .git/hooks or
    .git/config, the paths this runtime denies on purpose. Everything
    else it asked to delete, it deleted.

  AFTER
    .git exists:  yes
    .git holds:   config hooks
    git log:      fatal: not a git repository (or any of the parent directories): .git
```

**Debian · bubblewrap 0.8.0** — same script, different kernel mechanism:

```
  BEFORE
    1 commit · 35f7026 the history that matters
    .git holds:   COMMIT_EDITMSG HEAD branches config description hooks index info logs objects refs

  AFTER
    .git exists:  yes
    .git holds:   config
    git log:      fatal: not a git repository (or any of the parent directories): .git
```

The platforms differ in what survives — Seatbelt keeps `hooks`, bubblewrap does
not — and agree on the part that matters.

**The directory survives and the repository does not.** `objects`, `refs`,
`HEAD` and `index` are gone. What remains is whichever paths the runtime
protects on its own — and a `.git/` is still sitting there either way, which is
the part that makes the loss easy to miss.

## Why it happens, and why it is not a bug

A path that is write-allowed is also delete-allowed. "May edit this file" and
"may destroy this file" are one permission, and there is no way to ask for
anything narrower.

`.git` is the case that cannot be worked around by denying the path, because the
runtime deliberately keeps it writable — from its own source:

```js
export const DANGEROUS_DIRECTORIES = ['.git', '.vscode', '.idea'];
/** Excludes .git since we need it writable for git operations -
 *  instead we block specific paths within .git (hooks and config). */
```

So the shape already exists on the **path** axis, hardcoded. `.git` is where it
runs out: it has to stay writable for git to work, which means it also stays
deletable. The operation axis is the only one that reaches it.

## Run it yourself

Thirty seconds, nothing installed, nothing of yours touched — it works in a
temp directory and deletes it on the way out.

```bash
curl -fsSL https://raw.githubusercontent.com/carlostapiacl/seisin/main/docs/demo/writable-means-deletable.sh | bash
```

Or read [the script](writable-means-deletable.sh) first, which is the better
habit and takes about as long.

On Linux: `apt install bubblewrap ripgrep socat` first. On macOS it works as-is.

## What this is not

It is not a seisin demo — seisin is not installed and is not needed. It is the
enforcement runtime's model, and every tool built on it inherits the same gap.

## What was done about it

- **Filed upstream** as [anthropics/sandbox-runtime#545](https://github.com/anthropics/sandbox-runtime/issues/545),
  with the implementation, and the Linux objection answered before it was raised.
- **Measured**, because a principle is cheaper to argue with than a number. Over
  ~330 rounds of a multi-agent run, **66 destructive commands landed inside a
  role's own writable tree** — 34 recursive deletes, 11 `reset --hard` over a
  shared tree — every one permitted by the sandbox, and caught only by a program
  reading command strings and guessing at intent.

[seisin](../../README.md) is the tool that measured it: it gives each agent its
own folders and its own keys, and when it blocks, it tells you whose file it was.
This is the one policy it cannot express.
