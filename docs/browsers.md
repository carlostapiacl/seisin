# Browsers: a headless Chromium inside the sandbox

```toml
[network]
allow = ["example.com"]

[roles.reviewer]
writes   = ["reports/**"]
browsers = ["chromium"]
```

`browsers = ["chromium"]` lets a role start Playwright's Chromium headless
shell on macOS. It grants two Mach rules, by one prefix, and nothing else. The
network is still `[network] allow`, through the sandbox's proxy.

## What the kernel saw

Measured on macOS 15 with Playwright's `chromium_headless_shell-1208`, under the
profile every role gets:

| step | denied by the kernel | effect |
|---|---|---|
| the browser process starts | `mach-register org.chromium.Chromium.MachPortRendezvousServer.<pid>` | FATAL in `base/apple/mach_port_rendezvous_mac.cc`: `bootstrap_check_in … Permission denied (1100)`; the browser exits |
| with that allowed, its children start | `mach-lookup org.chromium.Chromium.MachPortRendezvousServer.<parent pid>`, over a thousand times in forty seconds | GPU, network and renderer processes restart in a loop; no page |
| with both allowed | `mach-lookup` of configd, the window server, analyticsd, tccd…; `sysctl-read hw.product`; reads of `~/Library/Preferences/*.plist` | none: the browser carries on and the page loads |

So the preset is those two, with that prefix:

```
(allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
(allow mach-lookup   (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
```

The browser registers its rendezvous service; its own children look it up to
receive their ports. Nothing else on the list was needed, so nothing else is
granted. Never a bare `mach-register`: a registered name lives in the
bootstrap namespace other processes look names up in, and an open grant would
let a role stand up a service under any name.

## Why it is opt-in, per role

A browser is the only thing measured so far that needs a Mach service
registered, and most roles never start one. Granted to every run, the rule
would sit in profiles that have no use for it; per role, it is written next to
the role that needs it, `seisin check` and `seisin explain` read it there, and
every other role keeps the profile it had. The same reasoning as `trustd` and
`local_binding`.

## How the rule gets into the profile

sandbox-runtime takes the lookup half as `allowMachLookup` in its settings,
and seisin passes it that way. It has no field for registering a service. So
for a role with `browsers`, and only for one, seisin starts the runtime with a
preload ([src/sandboxes/srt-mach.mjs](../src/sandboxes/srt-mach.mjs)) that
appends the register rule to the profile the runtime generates, before the
runtime runs it.

It fails closed. The profile has to be where and what it was when this was
written: one `/usr/bin/sandbox-exec -p '(version 1)…'`. If a later runtime
builds its command another way, the preload throws, the runtime does not run
the command, and the canary reports a sandbox that did not start (exit 86). A
role that asked for a browser gets no browser; it never gets less sandbox.

tartaros ([sandboxes.md](sandboxes.md)) takes the names in its own settings
field, `network.allowMachRegister`, with the same trailing `*` for a prefix, and
turns them into the same `global-name-prefix` rule. seisin writes that field
only into the file a tartaros run is handed — srt's schema is strict and never
sees it. Any other sandbox is given the names neither way, so for a role with
`browsers` it is passed over with that reason.

Measured under tartaros 99b0117: the register rule holds (no rendezvous
FATAL), but Chromium then exits on a segmentation fault, with the kernel
denying what srt's profile allows — `ipc-posix-shm-read-data` of
`apple.cfprefs.*` and `apple.shm.notification_center`, `sysctl-read
kern.proc.pid.<pid>`, `iokit-open-user-client RootDomainUserClient`. Until
tartaros allows those, a browser role is better served by srt:
`provider = ["tartaros", "srt"]` does not fall back on its own here, because
the sandbox accepts the policy and the browser dies after.

## The proxy

Inside the sandbox `HTTP_PROXY` is `http://<user>:<token>@localhost:<port>`.
The token is the run's own: it is what ties a request to the run, and the proxy
answers a request without it with `407` (measured with curl: `CONNECT 407`
without, `200` with, `403` for a host off the list). Playwright passes Chromium
`--proxy-server` without the credentials in the URL, so they have to be given
apart:

```js
const u = new URL(process.env.HTTP_PROXY);
const browser = await chromium.launch({ proxy: {
  server: `${u.protocol}//${u.host}`,
  username: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
} });
```

With that the page loads (`200`). With `{ server: process.env.HTTP_PROXY }`
the navigation times out.

## What is not covered yet

- **`@playwright/mcp`.** Its `--proxy-server` has the same gap as above, which
  a `--config` file with `browser.launchOptions.proxy` would answer; but it also
  always publishes the browser on a unix socket of its own (version 0.0.83:
  `$TMPDIR/pw-<hash>/browser/<id>.sock`), and the sandbox denies the listen.
  Granting it needs a socket directory of the run's own, never the whole
  temp directory, which holds other runs' audit sockets.
- **Chrome and Chrome for Testing.** Their rendezvous prefixes are their own
  bundle ids (`com.google.Chrome.`, `com.google.chrome.for.testing.`), and they
  also open a unix socket for their process singleton, which is denied. Not
  presets until that is measured through.
- **Linux.** bubblewrap has no Mach and no such denial; nothing to grant.

## When it is missing

A role that starts Chromium without the preset gets a browser that exits at
once. `seisin log` shows the denial by operation and name:

```
denied   reviewer mach-register org.chromium.Chromium.MachPortRendezvousServer.7354  [kernel]
```

and `seisin run` ends by naming the preset that answers it.
