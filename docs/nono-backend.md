# nono backend: the contract, before there is one

seisin has no backend selection today: every role runs under
`@anthropic-ai/sandbox-runtime`. This page is the contract a `nono` backend
would have to meet before it could be offered, written down now so that the
first implementation is held to it rather than the other way round.

The rule it follows is the one in [decisions.md](decisions.md): the backend is
a capability choice. A role may run under `nono` only when `nono` can enforce
every capability its policy declares, **and nothing more**. Falling back to
`sandbox-runtime` is acceptable; a translation that widens the policy is not.

## Ports: `open_port` is connect *and* bind

In seisin the two local-network permissions are separate:

- `local_ports = [5173]` lets the role **connect** to those ports on localhost;
- `local_binding = true` lets the role **listen**.

`nono`'s `network.open_port` does not separate them. Measured with
`nono 0.78.0` on macOS, `open_port = [5173]` permitted a process inside the
sandbox both to connect to 5173 and to bind a server on it; an undeclared port
stayed closed.

So `local_ports` must **not** be translated to `open_port` on its own: a role
that may only connect would gain the right to listen. The translation that
holds is:

| the role declares | under `nono` |
|---|---|
| `local_ports`, no `local_binding` | not expressible — stays on `sandbox-runtime` |
| `local_binding = true` and serves on fixed ports listed in `local_ports` | `open_port` for those ports: narrower than "may listen", never wider |
| `local_binding = true` with a dynamic port (`listen(0)`, a dev server that falls back to the next free port) | not expressible — stays on `sandbox-runtime` |

For the second row the command must refuse automatic port fallback — Vite's
`--strictPort`, for example — or a busy port moves the server outside the
grant and the failure reads as a mystery:

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

`network.listen_port` is not an alternative in that build: its profile passes
strict schema validation, and a real bind is still denied with
`Operation not permitted`.

## Network translation

The two `nono` network modes are distinct:

- no domains: `network.block = true`;
- one or more domains: `network.allow_domain = [...]` and proxy mode, without
  `network.block`.

`nono` rejects combining `block` and `allow_domain`.

## Platform: macOS only, for now

Everything above was measured on macOS. On Linux the question is settled before
any port is considered:

- **Landlock cannot deny a path inside one it allows.** A seisin profile nearly
  always needs exactly that — the policy file, `.seisin/`, key directories and
  the control files of every project inside a role's territory are denied
  within territories the role may write. `nono` refuses to start such a profile
  rather than drop the deny, which is the right refusal and means the role
  cannot run under it.
- This is the same wall that rules out OpenShell ([openshell.md](openshell.md)).

So on Linux `nono` is not eligible for any role whose territory contains a
protected path, which in practice is every role. Nothing on this page should be
read as a Linux result.

| role needs | macOS | Linux |
|---|---|---|
| territory writes, keys, a domain allow list | eligible | not eligible when a deny sits inside the territory |
| fixed ports it serves on (`local_binding` + `local_ports`) | eligible, via `open_port` | not eligible |
| `local_ports` to connect only | stays on `sandbox-runtime` | stays on `sandbox-runtime` |
| a dynamic port | stays on `sandbox-runtime` | stays on `sandbox-runtime` |

## What the macOS checks covered

Territory writes, read-wide/write-narrow policy, explicit denies, keys,
symlinks, descendants, Unix sockets, blocked networking, HTTPS domains, fixed
ports, SIGTERM and denial diagnostics.

## Before it can be selectable

1. a profile compiler with unit tests for every seisin policy field, including
   the rows above that must fall back;
2. its kernel suite passing on every platform it is offered on, and refusing on
   the others;
3. denial diagnostics that feed the same ownership and request pipeline as the
   current Seatbelt watcher;
4. `seisin check` naming, per role, which backend it would get and why — before
   anything starts;
5. fallback decisions visible and covered by tests.
