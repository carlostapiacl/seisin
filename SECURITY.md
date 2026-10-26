# Reporting a bypass

This is a permission tool, so the report that matters most is the one that says the
boundary did not hold. Those do not go in a public issue.

**Use [private vulnerability reporting][pvr]** on this repository — GitHub's own channel,
visible to the maintainer and to you, and nobody else until there is a fix to talk about.

[pvr]: https://github.com/carlostapiacl/seisin/security/advisories/new

## What counts

- A confined process **reading** a key, or any path, that the policy does not grant it.
- A confined process **writing** outside its territory.
- A confined process **reaching a host** that is not in its allow list.
- A role **answering as another role** — `whose`, `explain` or the hook naming the wrong
  owner in a way that would get a grant written for the wrong territory.
- Anything that makes `seisin run` start **without** the kernel boundary actually applied.
  A sandbox that silently did not start is the worst failure this tool has, because a green
  run and an unconfined one look identical from outside.
- **A confined process reaching a key provider's value, command or script.** A provider is
  executed by the parent, outside the sandbox — so a way for the inside to influence what
  runs, or to read a resolved value it was not granted, is a bypass.
- **A resolved key's value appearing anywhere it is written down** — the log, the queue, the
  emitted settings, the console. The promise is that what gets recorded is the reference.

## The one surface worth understanding before you look

`[keys.providers] command` is the only thing in a `seisin.toml` that **executes**. Everything
else describes a boundary; this runs, in the parent, outside the sandbox, with your privileges — it
has to, because it holds the vault's credential and the confined side must not reach it.

The consequence is that **a `seisin.toml` arriving with a repository you cloned is code you
are about to run**, the same trust already extended to a `Makefile` or a `package.json`
script. `seisin check` executes nothing and prints those commands; read it first on a config
you did not write. A script named by a provider is denied to every role, the way the policy
file is, so the inside cannot rewrite what the outside executes.

That is a documented property, not a vulnerability. A way **around** it is one.

## What does not

These are documented limits, not vulnerabilities — they are in the README's Status table and
arguing them is welcome in a normal issue:

- **Deleting or renaming inside your own territory.** The kernel grants a path and everything
  under it; seisin answers *where*, not *what*. The ask that would close it is filed upstream
  against the runtime.
- **Redaction being defeated.** It masks a literal value passing through the launcher. A
  value written straight to a file, or transformed first, never passes through it. The README
  says so; it narrows a careless print and is not a containment boundary.
- **A hard link into a territory, made from outside the sandbox.** Ownership is by
  path; a second name for a sensitive inode, placed in a role's territory by
  something outside the sandbox, is writable by that role. Creating such a link from
  inside is denied. Do not hard-link a sensitive file into an agent's territory.
- **A key stored outside the declared key directories.** Nothing covers those. `seisin scan`
  exists to find them.

## What makes a report reproducible

The three things that turn a report into a fix:

```bash
seisin log --verdict denied     # what the kernel denied, and when
cat seisin.toml                 # the policy it was denying against
seisin check                    # what the policy actually resolves to
```

Plus the platform and the enforcement backend — macOS/Seatbelt or Linux/bubblewrap — because
they deny differently and a hole in one is not automatically a hole in the other.

## Scope

Enforcement is [`@anthropic-ai/sandbox-runtime`][srt] asking the operating system. A hole in
the kernel boundary itself belongs upstream, in that project; a hole in **what seisin asked
for**, or in **what it told you it asked for**, belongs here. If you are not sure which one
you have, report it here and it gets routed.

[srt]: https://github.com/anthropics/sandbox-runtime

## Dependency advisories: both are the sandbox runtime's

`npm audit` and Dependabot report two high-severity advisories on seisin. Neither is in seisin's
code: both are dependencies of the pinned sandbox runtime, [`@anthropic-ai/sandbox-runtime`][srt]
(0.0.81), which seisin runs as a command and does not import. seisin itself depends on nothing
else but the optional [tartaros][tt] package, which carries prebuilt binaries and no JavaScript
dependencies. Both were re-checked against the runtime 0.0.81 source on 2026-10-26, and neither
appears reachable through seisin's use. Each stays open until the runtime moves past it.

[tt]: https://github.com/carlostapiacl/tartaros

**`node-forge` — [GHSA-86w9-cpqp-85rv][forge].** RSA PKCS#1 v1.5 signature *verification*
accepts a malformed certificate structure. No version fixes it. The runtime uses forge only in
its TLS-terminating proxy (`mitm-ca.js`, `mitm-leaf.js`), and only to *build* certificates:
`pki.createCertificate`, `pki.rsa.generateKeyPair`, PEM encoding and parsing, and a comparison of
a configured CA's RSA modulus with its private key. The signature itself is made with Node's
native `crypto`. Nothing calls forge's certificate-signature verification, the vulnerable
operation. Downgrading to the runtime 0.0.50 that `npm audit fix` suggests would remove security
fixes and APIs seisin relies on, so it is not a remediation.

**`zod` — [GHSA-mrhx-c7xc-m3w5][zod].** Validating an oversized constrained collection can exhaust
memory. Fixed only in zod 4.6.6; the runtime pins `^3.25` (zod 3.25.76 installed) and imports
`zod/v3`, so it cannot be raised from here. The runtime validates two inputs with it. One is
its settings file (`sandbox-config.js`), and under seisin that file is the one seisin writes for
the run: the role cannot read it, let alone write it, and the canary checks that before every
run. The other is the wire protocol of an external request decider (`decider-client.js`, the
runtime's `proxy-only` mode), which seisin never starts. To exhaust memory through either, one
would already need to control what seisin hands the runtime.

[forge]: https://github.com/advisories/GHSA-86w9-cpqp-85rv
[zod]: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5
