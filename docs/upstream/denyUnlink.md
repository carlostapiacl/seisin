# Upstream ask · `denyUnlink`

Issue for [anthropics/sandbox-runtime][repo]. Kept here because
`seisin check` reports this gap to users, and a documented gap should say what
is being done about it.

Verified against **0.0.76** on 2026-09-13; every command below was run.
(`srt --version` reports `1.0.0`, which does not match `package.json` — trust
the package version when reproducing.)

[repo]: https://github.com/anthropics/sandbox-runtime

---

## The issue

**Filed 2026-09-13 as [anthropics/sandbox-runtime#545][issue]** —
*filesystem: allow unlink/rename to be denied inside write-allowed paths*.

That is where it lives now. This file keeps only what the issue deliberately
left out, plus the reproducer, so a reader here does not have to leave to see
what the ask is about.

[issue]: https://github.com/anthropics/sandbox-runtime/issues/545

## Reproducer

`proj/` is a git repo with one commit; writes are allowed in the project and
nowhere else.

```bash
D=$(mktemp -d); cd "$D"; R=$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$D")
mkdir -p proj && cd proj && git init -q . && echo hi > a.txt && git add -A \
  && git -c user.email=t@t -c user.name=t commit -qm "the history that matters" && cd "$D"

cat > settings.json <<EOF
{ "network": { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": [], "allowLocalBinding": false },
  "filesystem": { "allowRead": ["$R/proj"], "denyRead": [], "allowWrite": ["$R/proj"], "denyWrite": [] } }
EOF

srt --settings settings.json -- sh -c "rm -rf $R/proj/.git"

ls proj/.git          # config  hooks                  <- the directory survives
git -C proj log       # fatal: not a git repository    <- the history does not
```

`objects`, `refs`, `HEAD` and `index` are gone. `rm` stopped only when it
reached the denied `.git/hooks` and could not remove a non-empty directory, so
what is left on disk looks like an intact `.git`.

Verified against **0.0.76** on 2026-09-13, as were the three line numbers the
issue cites — unchanged from 0.0.75.

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
