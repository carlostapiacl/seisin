# Upstream ask · `mach-register` for a named prefix (Chromium)

**Already tracked upstream — do not file a new issue.**
[#210][210] (open since 2026-04-06) asks for exactly this, and [PR #598][598] (opened
2026-09-22, awaiting review) implements it as `network.allowMachRegister`, the counterpart of
`allowMachLookup`, with the same trailing-wildcard spelling. Checked 2026-09-23: neither 0.0.76
nor 0.0.77 (the latest) has it. Kept here because `seisin hook` tells an agent that Chromium
needs `--single-process`, and a workaround the tool recommends should say what the real fix is
and where it stands.

What this note adds to the PR, if it is worth a comment there: the PR reproduces with a small C
probe that calls `bootstrap_check_in`; the table below is Playwright's Chromium end to end, and
it shows that `mach-register` alone is not enough — the children also need `mach-lookup` for
the same prefix, which the PR's own example sets but does not say is required.

When it ships, seisin can offer it per role (Chromium's prefixes, both operations) instead of
`--single-process`.

[210]: https://github.com/anthropics/sandbox-runtime/issues/210
[598]: https://github.com/anthropics/sandbox-runtime/pull/598

Verified against **0.0.76** on macOS 15, 2026-09-23.

[repo]: https://github.com/anthropics/sandbox-runtime

---

## What happens

Chromium's parent process registers a Mach service, `org.chromium.Chromium.MachPortRendezvousServer.<pid>`,
with `bootstrap_check_in`, and its children look it up to receive their ports. The macOS
profile the runtime generates has an allowlist for `mach-lookup` — fixed names plus
`allowMachLookup` from the settings — and no `mach-register` rule at all, so the check-in is
refused and the browser aborts before it opens a page:

```
[pid=79341][err] [0923/043620.365155:FATAL:base/apple/mach_port_rendezvous_mac.cc:155]
Check failed: kr == KERN_SUCCESS. bootstrap_check_in
org.chromium.Chromium.MachPortRendezvousServer.79341: Permission denied (1100)
```

Playwright reports it as `browserType.launch: Target page, context or browser has been closed`.
Nothing about it names a file or a port, and the violation is not a path, so a wrapper that
records path and port refusals (seisin does) has nothing to show for it.

## The workaround, and why it is not enough

| launch (Playwright's Chromium, inside the box) | result |
|---|---|
| defaults | aborts, the line above |
| `chromiumSandbox: false` | aborts, same line |
| `args: ["--single-process"]` | starts; pages load |

`--single-process` avoids the rendezvous because there are no child processes to hand ports
to. Chromium documents it as unsupported, and it shows:

- **Several at once:** a suite with 4 workers, each a single-process browser, loses one of them
  (`browser.newContext: Target page, context or browser has been closed`). With 1 worker that
  test passes. Measured in a real end-to-end run, 2026-09-23.
- **After a failure, even with 1 worker:** the test that runs right after a failed one can hit
  the same `newContext … has been closed`. Outside the sandbox, with 1 worker, the same test
  passes every time.

So the workaround gives a browser that starts, not one a test suite can rely on.

## The ask

A settings option to allow `mach-register` for named services, the counterpart of
`allowMachLookup`. For Chromium the rule it would emit is:

```scheme
(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
(allow mach-lookup   (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
```

A prefix, because the name carries the parent's pid. Registering a service under a name
chosen by the application is narrow: it does not reach any existing system service, which
is what the `mach-lookup` allowlist protects.

**Measured, macOS 15.7, 0.0.76.** The profile came from the runtime's own
`wrapCommandWithSandboxMacOS` (writes restricted, network restricted — the shape seisin asks
for), run through `sh` unchanged except for the lines below, and Playwright's Chromium launched
with its defaults (multi-process), three contexts in a row:

| profile | result |
|---|---|
| as generated | aborts: `bootstrap_check_in … Permission denied (1100)` — no seisin involved |
| + the `mach-register` line only | starts, then `newPage` fails: `… has been closed` (the children cannot look the port up) |
| + both lines | starts, three contexts open and close, `MULTIPROCESS OK` |

So both rules are needed and, for this case, sufficient. The runtime has `allowMachLookup` in
its settings already; there is no setting that emits `mach-register`, so the second half cannot
be supplied from outside. That setting is what PR #598 adds.
