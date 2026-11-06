# Configure

The whole of `seisin.toml`. The README has the short version.


One file at the root of your repo. Anything not listed is denied; there is no permissive default.

```toml
[keys]
dir = ".secrets"          # every key lives here; roles name the files they may read

[network]
allow = ["github.com", "*.github.com"]

[roles.frontend]
writes = ["src/web/**", "public/**"]
keys   = ["netlify-token.txt"]

[roles.backend]
writes   = ["src/api/**", "migrations/**"]
keys     = ["database-url.txt", "sentry-dsn.txt"]
network  = ["api.stripe.com"]   # this role only — it replaces [network] rather than adding
```

An allowed name is only as safe as its DNS: one whose records somebody else controls can be
pointed at a host on your network. The sandbox already denies loopback, link-local and
cloud-metadata addresses. Private ranges are left to you, because allowing an intranet name is
legitimate; to close them, list them:

```toml
[network]
allow          = ["github.com", "*.github.com"]
deny_addresses = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"]
```

`[runtime] read = "all"` is the default. The opt-in `"territory"` mode keeps homes,
temporary directories and mounted data roots shut, while retaining the repository and the
paths each role names:

```toml
[runtime]
read = "territory"

[roles.backend]
writes    = ["src/api/**"]
reads     = ["../shared-schemas/**"]  # data needed read-only
toolchain = ["~/.venvs/api"]          # program stack under a data root; bin/ goes first on PATH
verify    = ["python", "-m", "pytest"] # run by seisin check --verify inside this role
```

`seisin check --verify --parallel` is an experimental speed option: role checks run at the same
time. Use it only when those commands do not share mutable build outputs, caches, ports, or other
resources; concurrent checks can race and produce misleading failures. Plain `--verify` remains
serial and is the recommended default. `--parallel` requires `--verify`.

`reads` and `toolchain` take literal paths or a subtree ending in `/**`; interior globs,
`*` and `?` are refused. `verify` is an argv array and may not be empty. Each data root is
denied whole and what the role keeps is allowed back, so what appears there during the run is
shut as well. On Linux a kept directory holding a write path is allowed back entry by entry;
one with more than 1,000 entries is refused, and the error names whether the repo or a `reads`
path must move or narrow. Details and platform costs are in [Scratch and read territory](https://github.com/carlostapiacl/seisin/blob/main/docs/scratch.md).

`[network] allow` is the fallback for roles that do not name their own. A role that needs one
extra host should say so on its own line: a domain in the global list is reachable by every
role, including the ones whose whole job is to have nothing to reach.

> ⚠️ **HTTP(S) works on both platforms. SSH does not work on macOS.** The allow list is
> enforced by proxies the runtime starts, and although one of them is a SOCKS5 proxy that could
> carry SSH, on macOS the chain breaks at its last link: it requires authentication and the
> `ProxyCommand` the runtime wires up cannot send any. Measured on macOS: `curl
> https://github.com` returns `200`, `ssh -T git@github.com` cannot resolve the hostname, and
> `git ls-remote git@github.com:…` reaches the proxy and dies at the handshake. **On Linux** the
> runtime routes git's SSH through its HTTP proxy with credentials instead, so it is expected to
> pass (read from the runtime's source, not measured here).
>
> **Use an HTTPS remote for git**, and on macOS run SSH deploys outside the confined run.
> [Why, exactly, and whose gap it is →](https://github.com/carlostapiacl/seisin/blob/main/docs/decisions.md#ssh-does-not-work-and-it-is-not-seisin-that-decided-that)

A role can also give something back. `never_writes` subtracts from its own `writes`, and it
wins however wide the grant is:

```toml
[roles.backend]
writes       = ["services/api/**"]
never_writes = ["services/api/.git/index.lock"]   # works in a worktree; the canonical index is not its business
```

It is per role on purpose; there is no global version, because a global deny on a lock file
breaks every role that legitimately commits there. A denial it causes says so by name and
leaves **no request** in the queue: granting one would undo a subtraction somebody wrote. An
entry that no `writes` of the same role covers, or a misspelling like `never_write`, is named
by `seisin check` instead of being ignored.

A folder only one role may see is `private`. The role reads and writes it; every other role is
denied both, whatever its `writes` say, in either read mode and under `isolate`:

```toml
[roles.legal]
writes  = ["contracts/drafts/**"]
private = ["contracts/signed/**"]     # part of legal's territory, and no other role reads it

[roles.dev]
writes = ["**"]                       # still cannot read or write contracts/signed
```

An entry is one folder inside the repo, `dir` or `dir/**`: no patterns, no absolute path, no
`..`, not the repo itself. Two roles naming the same folder, or one inside the other, is refused
at load, because each would be denied its own. `seisin check` shows it under the role and says
when it sits inside another role's territory, since that role loses it. `seisin explain dev read
contracts/signed/x` answers denied and names the owner, and a denial there leaves **no request**:
no grant opens it. On Linux a missing private folder is created empty by `seisin run` (never by `check`), because
bubblewrap cannot deny a path that does not exist without placing something there; and another
role sees an empty folder in its place, where a write succeeds into memory that is discarded with
the run and never reaches the real one. On macOS the write is denied.

A role that starts a server (a dev server, the backend an end-to-end test drives) needs
`local_binding = true`. Listening is off by default and per role: most roles never start one.
It is wider than the name: the role can also listen on every interface and **connect to every
port on localhost**, so anything listening there without authentication is within its reach.
`seisin check` says this next to the role. That is macOS: on Linux each role already has a
private loopback, serves without the key, and reaches nothing on the host either way.
The canary therefore omits its loopback probe for a role with `local_binding = true`: reaching
the decoy is allowed by that policy, not evidence that confinement failed.

If a role only needs to *reach* a local service, name the ports instead:
`local_ports = [8001, 8081]`. The role reaches those and nothing else on localhost, on macOS
and Linux. Under srt the sandbox's proxy enforces the list, so the client has to use the proxy.
curl, Node's `fetch` and Python's `urllib` do. A database driver or a raw socket don't, and are
denied. Under tartaros the kernel profile holds the list itself, so any client reaches a listed
port directly, and loopback stays off its proxy. For a headless browser, see `browsers` below. A listed port is open to anything that
speaks `CONNECT`, not just HTTP, so list the service, not the protocol.

`mcp = ["playwright"]` lists the MCP servers a role may load; `mcp = []` means none, and no
key means the policy doesn't say. seisin declares this and `explain` answers it
(`seisin explain qa mcp tradingview`), but the servers are started by the agent's CLI, so the
launcher has to apply it. With Claude Code: `--mcp-config` holding only those servers, plus
`--strict-mcp-config`.

A role that drives a headless Chromium (Playwright, `@playwright/mcp`) needs
`browsers = ["chromium"]` on macOS. Without it the browser exits as it starts: its first act
is to register a Mach service (`org.chromium.Chromium.MachPortRendezvousServer.<pid>`) that its
own child processes look up, and the sandbox denies both. The preset allows exactly those two,
by that prefix, and nothing else; every other role keeps the profile it had. The network is
still `[network] allow`, through the sandbox's proxy, which takes credentials Playwright has to
be handed apart from the URL:

```js
const u = new URL(process.env.HTTP_PROXY);   // http://<user>:<token>@localhost:<port>
const browser = await chromium.launch({ proxy: {
  server: `${u.protocol}//${u.host}`,
  username: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
} });
```

Passing `HTTP_PROXY` as `server` alone does not work: Playwright gives Chromium the address
without the credentials and the proxy answers `407`. The token is the run's own, so the traffic
stays tied to the run. `@playwright/mcp` runs under `[sandbox] provider = "tartaros"`, which
gives the role a temp directory of its own for the unix socket the server always opens; under
srt it does not yet. [docs/browsers.md](https://github.com/carlostapiacl/seisin/blob/main/docs/browsers.md) has the measurements, the MCP config,
and what Chrome and Chrome for Testing still lack.

Some files are not code but still make something happen outside the sandbox, and no territory
reaches them: git hooks and config, a project's `.claude/`, `.mcp.json`, `.envrc`. Two softer
families sit beside those, and a policy can hand them to one role:

```toml
[roles.frontend]
writes        = ["apps/web/**"]
control_files = ["ide"]           # keeps apps/web/.vscode/launch.json current

[protect]
instructions = true               # CLAUDE.md, AGENTS.md… only for roles handed "instructions"
```

- **`ide`**: `.vscode/`, `.cursor/`, `.windsurf/`. Your editor applies them as soon as they
  change, which is how an injected agent turns on tool auto-approval. **Protected by default.**
- **`instructions`**: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, Cursor and Windsurf rules, Copilot
  instructions. Nothing runs them; the next agent session reads them as its instructions, so
  one role writing them reaches another role's context. **Off unless `[protect]` turns it on**:
  keeping them current is ordinary work for most teams.

A role handed a family writes it only inside its own `writes`, and `seisin check` names it on
every run. A denial says which setting would change it, and leaves no request: it is a decision
about the policy, not a grant. Inside `node_modules` neither family is touched, so npm still
unpacks a package's own `.vscode` or `AGENTS.md`. On Linux only the files that already exist are
protected: bubblewrap would have to create a missing one to deny it.

Denied connections are logged too: `connect tcp:<port>` (the kernel gives the port, not the
host) or the socket path, once per target per run. `seisin walls` says whether the port is
missing from `local_ports`, listed but dialled directly, or a socket. No request is filed: a
port isn't anyone's territory. macOS only.

So are the denials that are neither a file nor a connection: a Mach service, a `sysctl`, as
`mach-register org.chromium.Chromium.MachPortRendezvousServer.7354`, once per operation and
name per run, and never as a request. Most are the sandbox doing its job and the program
carrying on; one of them is how a browser dies at start, and `seisin run` names the preset
that answers it. macOS only.

## The console

```toml
[console]
runs = ".wapentake/seisin/runs"   # a directory of runs, relative to this file
launcher = "wapentake"            # who lends the territory: nothing is granted from the console
```

Both are optional. Without them `seisin ui` lists the runs in this repository's log and grants
from its queue. **[The console's runs →](runs.md)**

## Notifications

`[notify]` sends one message per new request (the role, the path, whose it is, and
`seisin grant '<id>'`) from the parent process, never from the role.

```toml
[notify]
url_file = ".secrets/notify-url.txt"   # e.g. https://ntfy.sh/<your-topic>
format   = "text"                      # or "slack", "json"
```

The URL is a credential: whoever reads it can send you a fake "grant this". So `url = "…"` in
`seisin.toml`, which every role can read, is refused. `url_file` has to sit inside a `[keys] dir`
and no role may declare it as a key. Or leave `url_file` out and set `SEISIN_NOTIFY_URL` in the
environment that starts seisin (`SEISIN_NOTIFY_FORMAT` for the format). The URL never reaches a
role's environment, not even when the role names it.

`seisin init` will propose this from whatever your repo already says: `.claude/agents/`, then `CODEOWNERS` (one role per owner, with all of that owner's paths), then one role per top-level folder that holds code. It declares `[keys] dir` when `.secrets/`, `secrets/` or `.keys/` is there, and adds `.seisin/` to an existing `.gitignore`. It **proposes** (a generated policy you did not read is not a policy) and a second `init` changes nothing without `--force`, which keeps the old one as `seisin.toml.bak`.

