# Upstream · `mach-register` for Chromium

**Already tracked, don't file again:** issue [#210][210] (open since 2026-04-06) and
[PR #598][598] (opened 2026-09-22, awaiting review), which adds `network.allowMachRegister`.
Not in 0.0.76 or 0.0.77 as of 2026-09-23.

This page keeps our measurement. The PR reproduces with a small C probe; this is Playwright's
Chromium end to end, and it shows `mach-register` alone isn't enough.

[210]: https://github.com/anthropics/sandbox-runtime/issues/210
[598]: https://github.com/anthropics/sandbox-runtime/pull/598

## The error

Chromium registers `org.chromium.Chromium.MachPortRendezvousServer.<pid>` at startup and its
child processes look it up. The runtime's macOS profile allows `mach-lookup` for a list of names
and has no `mach-register` rule, so the browser aborts:

```
FATAL:base/apple/mach_port_rendezvous_mac.cc:155] Check failed: kr == KERN_SUCCESS.
bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.79341: Permission denied (1100)
```

Playwright shows it as `browserType.launch: Target page, context or browser has been closed`.

## The workaround

| Playwright's Chromium, inside the sandbox | result |
|---|---|
| defaults | aborts |
| `chromiumSandbox: false` | aborts |
| `args: ["--single-process"]` | starts |

`--single-process` works because there are no child processes. It isn't reliable: with 4
workers one browser dies (`browser.newContext: … has been closed`), and even with 1 worker the
test after a failed one can hit the same error. Outside the sandbox those tests pass.

## Measured with the runtime alone

Profile from the runtime's `wrapCommandWithSandboxMacOS` (0.0.76, macOS 15.7, no seisin), with
lines added, launching Chromium with its defaults and opening three contexts:

| profile | result |
|---|---|
| as generated | aborts with the error above |
| + `mach-register` for the prefix | starts, then `newPage` fails |
| + `mach-register` and `mach-lookup` for the prefix | works |

```scheme
(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
(allow mach-lookup   (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
```

Both rules are needed. The lookup half can already be set with `allowMachLookup`; the register
half is what PR #598 adds. Once it ships, seisin can offer it per role instead of
`--single-process`.
