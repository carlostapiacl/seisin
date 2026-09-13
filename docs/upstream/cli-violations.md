# Upstream ask · surface violations to CLI callers

Issue for [anthropic-experimental/sandbox-runtime][repo]. Split out of
[denyUnlink.md](denyUnlink.md) on 2026-09-13 — different ask, different answer,
no platform debate, and it was diluting the other one.

Verified against **0.0.76**.

[repo]: https://github.com/anthropic-experimental/sandbox-runtime

---

## The issue, as posted

> **Title:** `cli`: sandbox violations are collected but never reach a caller that runs the binary

````markdown
## Summary

Violations are recorded and attributed, including network denies, but only a
caller that embeds the library can read them. `dist/cli.js` imports
`SandboxManager` and never touches them — no flag, no annotation, no file.

Library caller: `SandboxViolationStore` (exported from `dist/index.d.ts`) with
`getViolations` / `getViolationsForCommand` / `subscribe`, plus
`SandboxManager.annotateStderrWithSandboxFailures()`.

CLI caller: nothing. `grep -c violation dist/cli.js` → 0.

## What is already collected

```js
// sandbox-manager.js
function recordOutboundDeny(host, port, reason, encodedCommand) {
  recordProxyViolation(`deny network-outbound ${host}:${port} (${reason})`, encodedCommand);
}
// -> shouldIgnoreViolation(...) -> sandboxViolationStore.addViolation({ line, command, timestamp })
```

Host, port, reason and the command that reached for it.

## Ask

Either of these, smallest first:

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
