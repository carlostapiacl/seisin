# Upstream ask · surface violations to CLI callers

Issue for [anthropics/sandbox-runtime][repo]. Split out of
[denyUnlink.md](denyUnlink.md) on 2026-09-13 — different ask, different answer,
no platform debate, and it was diluting the other one.

Verified against **0.0.76**, re-verified against **0.0.77** on 2026-09-20.

[repo]: https://github.com/anthropics/sandbox-runtime

**Filed 2026-09-20 as [anthropics/sandbox-runtime#582][582].** Re-verified
against **0.0.77** on the day it went up — both call sites unchanged from 0.0.76,
only the line number in `dist/cli.js` moved (189 → 335), and the filed text cites
the current one. The other ask, [denyUnlink](denyUnlink.md) — [issue #545][545] —
has been open since 2026-09-13 with no response.

[582]: https://github.com/anthropics/sandbox-runtime/issues/582

[545]: https://github.com/anthropics/sandbox-runtime/issues/545

---

## The issue, as filed

> **Title:** `cli`: filesystem violations are never collected, and collected ones never reach a caller that runs the binary

````markdown
## Summary

A caller that runs `srt` sees no violations at all, and the two halves fail for
different reasons.

**Network denies** are recorded and attributed, and simply never read.
`dist/cli.js` imports `SandboxManager` and never touches the store — no flag, no
annotation, no file. `grep -c violation dist/cli.js` → 0.

**Filesystem denies** are not even recorded on this path. `initialize()` takes
`enableLogMonitor = false` and `cli.js:335` omits the argument, so neither
`startMacOSSandboxLogMonitor` nor `startLinuxSandboxViolationMonitor` is ever
constructed. The child gets `Operation not permitted` on its stderr; nothing
upstream of it learns a path was refused.

Library caller: `SandboxViolationStore` (exported from `dist/index.d.ts`) with
`getViolations` / `getViolationsForCommand` / `subscribe`, plus
`SandboxManager.annotateStderrWithSandboxFailures()` — and, for the filesystem
half, `initialize(config, undefined, true)`.

## What is already collected

```js
// sandbox-manager.js
function recordOutboundDeny(host, port, reason, encodedCommand) {
  recordProxyViolation(`deny network-outbound ${host}:${port} (${reason})`, encodedCommand);
}
// -> shouldIgnoreViolation(...) -> sandboxViolationStore.addViolation({ line, command, timestamp })
```

Host, port, reason and the command that reached for it.

## What is NOT collected on this path

Filesystem denies, and not because they are unrecordable — because the
collectors never start.

```js
// sandbox-manager.js
async function initialize(runtimeConfig, sandboxAskCallback, enableLogMonitor = false) {
  ...
  if (enableLogMonitor && getPlatform() === 'macos')  startMacOSSandboxLogMonitor(...)
  if (enableLogMonitor && getPlatform() === 'linux')  startLinuxSandboxViolationMonitor(...)
}

// cli.js:335 (0.0.77)
await SandboxManager.initialize(runtimeConfig);   // third argument omitted -> false
```

So on the CLI path the store holds proxy violations only. The seatbelt log
monitor and the seccomp observer — the two producers that see a refused write —
are never constructed, and `getViolationsForCommand` would return nothing for
them no matter who called it.

The data itself is there for the taking. `log stream` on macOS carries the deny
with its path, its operation and the runtime's own `CMD64_…_END_…_SBX`
attribution tag already attached:

```
Sandbox: bash(54251) deny(1) file-write-create /path/it/was/refused.txt
CMD64_ZWNobyBub3BlID4gL3ByaXZhdGUvdG1wL2NsYXVkZS01MDEv…_END__wg5uw9adw_SBX
```

Measured 2026-09-14 on macOS 15 (Darwin 24.6.0), 0.0.76, against a config whose
`allowWrite` held one directory and a write aimed one directory over. The child
saw `Operation not permitted` and nothing else; the kernel had already written
the line above.

## Ask

Three, smallest first. **The first two do nothing for filesystem denies on their
own** — without the third the store is empty of them:

- Pass `enableLogMonitor: true` from `cli.js`, or expose it as a flag. This is
  the one that matters; the collectors exist and are simply not switched on.
- `--violations <path>`: append each `line` as it is recorded.
- Or apply `annotateStderrWithSandboxFailures` on the CLI path — the behaviour
  embedders already get, no new surface.

## Notes

- Motivation is discovering an allowlist rather than guessing one. For an agent
  whose endpoints are not published, the list is not in its config, not in
  `strings`, not documented; the only way to find it is to watch the agent get
  refused. A CLI caller cannot watch, so the practical move is to drop the
  network restriction for that agent, which is how allowlists get long.
- `allowAllDomains: true` would also solve it. Asking for the report instead:
  a permissive mode is a thing that gets left on, a report is not.
````

---

## Longer rationale · not part of the issue

An earlier draft of this asked them to *record* blocked connections, on the
assumption that a refusal existed only inside the confined process's own
output. That was wrong — they already record it, and had done so before the
draft was written. Sending it would have told a maintainer they were missing
something they had already built, which is how a whole issue gets dismissed
including the part that was right.

The correction is what makes the ask small: it went from "build this" to "three
lines so it leaves the process".

Verified by reading `dist/`, not by inference: `recordOutboundDeny` →
`recordProxyViolation` → `sandboxViolationStore.addViolation`, the store
exported in `dist/index.d.ts`, and the only consumer at
`sandbox-manager.js:1793` (`annotateStderrWithSandboxFailures`), which the CLI
never calls.

**Amended 2026-09-14, and the amendment is the same lesson a second time.** The
draft above was written from the network path, where the violation really is
recorded and merely unread — so the ask was "three lines so it leaves the
process". For filesystem denies that ask is not enough and would have been
answered with a patch that changed nothing: `enableLogMonitor` defaults to
`false` and `cli.js` omits the argument, so there is nothing in the store to
leave the process. Asking for the reader before the writer is how a whole issue
gets closed as "already works for me".

The correction cuts the other way from the first one. That time the ask was too
big — they had built it. This time it was too small — they had built it and left
it switched off on this path.

---

## Field evidence since filing · 2026-09-23

Not posted to #582 yet; ready as a comment if it helps the issue move.

An agent ran a Flutter Web end-to-end suite under `srt`, with the app's API and front
reachable through the proxy (listed `localhost:<port>` entries). Two refusals the proxy made
never reached anyone who could act on them:

- **The page fetched its renderer from a CDN** — `www.gstatic.com/flutter-canvaskit/…` and
  `fonts.gstatic.com` — and the proxy refused both. The agent learned the host names only from
  the browser's console output, several steps later.
- **The same agent then blamed that refusal for an unrelated failure.** A test that failed
  because the browser process had died (the Mach registration in
  [mach-register.md](mach-register.md)) was reported as "gstatic is outside the allowlist". With
  the proxy's refusals invisible, the one it had found by hand became the explanation for
  everything nearby. A list of what the proxy refused during the run would have shown the
  refusal and, just as usefully, its timing — not at the moment the test died.

The fix on the app side was to bundle the renderer, after which the only outbound request left
was an error-reporting CDN, refused and correctly so. Finding that out also took reading a
browser console: the kernel-side refusals of the same run were in the wrapper's log within
milliseconds, the proxy's were not there at all.
