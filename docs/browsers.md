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

A tartaros run of such a role is also started with `--browser` — the shared
memory, IOKit classes and sysctls a headless Chromium dies without, the same
ones srt's profile allows every process — and `--private-tmp`, a TMPDIR of the
run's own and the only place the role may open a unix socket. Measured with
tartaros f7edae1: the probe loads `example.com` (`200`), a host off the list
fails, and `@playwright/mcp` runs (below).

It takes tartaros 0.1.0-alpha.5 or later. alpha.4 took `allowMachLookup` as
the whole list rather than as additions to its own, so a role with `browsers`
lost every other lookup, the keychain among them; and it made the private
TMPDIR as `tartaros-tmp-<pid>-<ns>` inside the TMPDIR it was started with.
`@playwright/mcp` opens its browser's socket there,
`pw-<hash>/browser/<16 hex>.sock`, capped at 103 bytes: under a Mac's
`/var/folders/…/T` the directory alone came to 107, and the server answered
every call with `Socket directory path is too long`. alpha.5 makes it as
`/private/tmp/tartaros-<uid>/tt-XXXXXX` wherever it is started, and the
keychain answers in a role with `browsers` as in one without (measured with
@playwright/mcp 0.0.83). A launcher that sets the agent's TMPDIR itself,
inside the sandbox, takes it out of the one place the role may open a socket:
the server fails with `listen EPERM`.

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

## `@playwright/mcp` (under tartaros)

```toml
[sandbox]
provider = "tartaros"
```

Two things in its `--config` file, written from the run's environment when the
role starts, since the proxy address is the run's own:

```js
const u = new URL(process.env.HTTP_PROXY);
const config = { browser: { launchOptions: {
  chromiumSandbox: false,
  proxy: { server: `${u.protocol}//${u.host}`,
    ...(u.username && { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }) },
} } };
```

`chromiumSandbox: false` because Chromium's renderer applies a Seatbelt
sandbox of its own, and macOS does not let a sandboxed process start another
(`forbidden-sandbox-reinit`): the renderer crashes on the first page. The
outer sandbox is the one that confines it. Playwright's own `launch()` already
passes `--no-sandbox`; the MCP server does not. tartaros's proxy carries no
credentials in the URL, hence the condition.

## What is not covered yet

- **`@playwright/mcp` under srt.** It always publishes the browser on a unix
  socket of its own (version 0.0.83: `$TMPDIR/pw-<hash>/browser/<id>.sock`),
  and srt can only be given a socket path, not a directory of the run's own:
  the temp directory holds other runs' audit sockets. Under tartaros it runs
  (`--private-tmp`), as below.
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
