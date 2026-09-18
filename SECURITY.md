# Reporting a bypass

This is a permission tool, so the report that matters most is the one that says the
boundary did not hold. Those do not go in a public issue.

**Use [private vulnerability reporting][pvr]** on this repository — GitHub's own channel,
visible to the maintainer and to you, and nobody else until there is a fix to talk about.

[pvr]: https://github.com/carlostapiaolguin3-stack/seisin/security/advisories/new

## What counts

- A confined process **reading** a key, or any path, that the policy does not grant it.
- A confined process **writing** outside its territory.
- A confined process **reaching a host** that is not in its allow list.
- A role **answering as another role** — `whose`, `explain` or the hook naming the wrong
  owner in a way that would get a grant written for the wrong territory.
- Anything that makes `seisin run` start **without** the kernel boundary actually applied.
  A sandbox that silently did not start is the worst failure this tool has, because a green
  run and an unconfined one look identical from outside.

## What does not

These are documented limits, not vulnerabilities — they are in the README's Status table and
arguing them is welcome in a normal issue:

- **Deleting or renaming inside your own territory.** The kernel grants a path and everything
  under it; seisin answers *where*, not *what*. The ask that would close it is filed upstream
  against the runtime.
- **Redaction being defeated.** It masks a literal value passing through the launcher. A
  value written straight to a file, or transformed first, never passes through it. The README
  says so; it narrows a careless print and is not a containment boundary.
- **A key stored outside the declared key directories.** Nothing covers those. `seisin scan`
  exists to find them.

## What makes a report reproducible

The three things that turn a report into a fix:

```bash
seisin log --verdict denied     # what the kernel refused, and when
cat seisin.toml                 # the policy it was refusing against
seisin check                    # what the policy actually resolves to
```

Plus the platform and the enforcement backend — macOS/Seatbelt or Linux/bubblewrap — because
they refuse differently and a hole in one is not automatically a hole in the other.

## Scope

Enforcement is [`@anthropic-ai/sandbox-runtime`][srt] asking the operating system. A hole in
the kernel boundary itself belongs upstream, in that project; a hole in **what seisin asked
for**, or in **what it told you it asked for**, belongs here. If you are not sure which one
you have, report it here and it gets routed.

[srt]: https://github.com/anthropics/sandbox-runtime
