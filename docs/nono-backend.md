# nono backend: fixed ports first

This is the compatibility contract for the experimental `nono` backend. It is
not the default backend yet. The current release still runs
`@anthropic-ai/sandbox-runtime`.

## Recommendation

Use a fixed, declared port for every server an agent starts. Under `nono`,
Seisin should compile that declaration to `network.open_port`:

```toml
[roles.frontend]
writes = ["src/**"]
local_ports = [5173, 4173]
```

`open_port` is bidirectional. On macOS with `nono 0.78.0` it was exercised in
both directions: a process inside the sandbox connected to the declared port,
and a process inside the sandbox bound a server to it. An undeclared port stayed
closed.

This is the recommended shape for Vite, Next.js, Astro, local APIs and test
servers:

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

The fixed port and `--strictPort` matter. Silently choosing 5174 after 5173 is
busy would move the server outside the declared capability.

## When Seisin must keep sandbox-runtime

`local_binding = true` means that the role may choose a listening port at
runtime. There is no safe equivalent in the measured `nono 0.78.0` macOS
backend:

- `listen_port` is accepted by strict profile validation;
- a real bind still fails with `Operation not permitted`;
- dynamic port allocation (`listen(0)`) cannot be represented by a finite
  `open_port` list.

Therefore backend selection must be fail-closed:

| role needs | backend decision |
|---|---|
| filesystem, keys, domain allowlist | `nono` is eligible |
| fixed local ports | `nono`, using `open_port` |
| `local_binding = true` or a dynamic port | keep `sandbox-runtime` |
| a capability not proved on the current OS | keep `sandbox-runtime` or refuse |

Seisin must print the reason when it selects the fallback. It must never turn
`local_binding` into unrestricted network access or pretend that a failed
`listen_port` was enforced.

## Network translation

The two nono network modes are distinct:

- no domains: `network.block = true`;
- one or more domains: `network.allow_domain = [...]` and proxy mode, without
  `network.block`.

Combining `block` and `allow_domain` is rejected by nono. Fixed local ports are
added with `open_port` in either applicable profile.

## Platform status

The macOS checks exercise territory writes, read-wide/write-narrow policy,
explicit denies, keys, symlinks, descendants, Unix sockets, blocked networking,
HTTPS domains, fixed ports, SIGTERM and denial diagnostics.

Linux is not inferred from those results. Before enabling the backend there,
the same suite must run against a pinned Linux artifact and cover Landlock,
the FIFO audit channel, network namespace behaviour and process cleanup.

## Release gate

The backend is ready to become selectable only when:

1. its profile compiler has unit tests for every Seisin policy field;
2. its native kernel suite passes on macOS and Linux;
3. denial diagnostics feed the same ownership/request pipeline as the current
   Seatbelt watcher;
4. `seisin check` rejects unsupported combinations before starting an agent;
5. fallback decisions are visible and covered by tests.

