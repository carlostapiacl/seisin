# Changelog

Versions that were published. What changed in the repository between them is in the git
history; what changed for someone who installs it is here.

The config format may still move before `1.0`. When it does, `seisin check` says what
changed rather than failing on the old spelling.

## Unreleased

- **Security: the console no longer hands its token to whoever asks.** `seisin ui` used to inline
  the token that approves requests into the page, and `/api/state` answered with no token at all
  — both resting on "an agent cannot reach loopback". `local_binding = true` makes that false on
  macOS, and a read-only review reproduced a role reading the token off `GET /` and approving its
  own request into another role's territory. The token now travels only in the fragment of the
  link `ui` opens (`#t=…`, never sent to any server), the page keeps it for the tab and wipes it
  from the address bar and history, every `/api/` route requires it, and the server only answers
  to its own `Host`. Found before release; no published version had `local_binding`.
- **Paths are read the same way everywhere.** `seisin_explain` over MCP answered "no owner" for an
  absolute path the CLI called allowed, and no surface resolved symlinks, so a path under `/tmp`
  on macOS was refused by the sentence and allowed by the kernel. One function now serves the
  CLI, the hook, `run`, `whose` and the MCP server, with a test that asks all three the same thing.

- **`never_writes`: a role can give back part of its own territory.** `writes = ["repo/**"]`
  cannot say "the whole repo except its `.git/index.lock`", and that is exactly what a role
  working in a worktree needs: it has its own index and no use for the canonical one. The
  alternative was enumerating every top-level entry of the repo but `.git` — a list that goes
  stale the day somebody adds a directory.

  - **Additive.** Absent, or an empty list, means exactly what it meant before. Nobody who
    upgrades without writing the key sees a change, and `check` says nothing about its absence.
  - **Per role, never global.** A global deny on a lock file breaks every role that commits
    there legitimately.
  - **It wins.** Its entries go to the kernel profile's `denyWrite`, which beats `allowWrite`
    however wide — the same property the config file and the key directories already rely on.
  - **A refusal names it and queues nothing.** "denied by never_writes of backend", not "belongs
    to nobody": said the second way, the agent asks, a person approves, and the subtraction is
    undone from the other side without anyone deciding to.
  - **`check` catches the ways it can look written and not be.** An unknown key in a role table
    used to be ignored in silence; for `never_write` that is failing open. It is now named, with
    the key it most likely meant. So is an entry no `writes` of the same role covers, which
    subtracts from nothing. An absolute path or a `..` refuses to load.
  - **On Linux, only paths that exist when the role starts.** bubblewrap denies by mounting over
    a path and creates it on the host if it is missing — for `.git/index.lock` that locks every
    other user out, and for good if the role is killed (measured). seisin skips those there;
    `explain` says so and `check` names them. A symlink on the way is resolved, and a database's
    sidecars (`-wal`, `-shm`, `-journal`) are subtracted with it.

- **`local_binding = true`: a role can listen on a local port.** Until now the profile set
  `allowLocalBinding: false` for everyone, so no role could start a dev server or the backend
  an end-to-end test drives — `php -S 127.0.0.1:…` and `node`'s `listen()` both died with
  `Operation not permitted`. Off by default and per role, because most roles never need it.

  **It is wider than its name**, and `check` says so. The runtime turns it into three rules:
  listen on *any* interface (`0.0.0.0` included, so a server can be reachable from the LAN),
  accept inbound, and connect to *every* port on localhost. That last one means the role can
  reach whatever else is listening on the machine — found the same day it was written, against
  a local control API with no authentication. Grant it to a role only where nothing on
  localhost would act on an unauthenticated request.

  **That is macOS.** On Linux the runtime drops the network namespace, so every role already
  has a loopback of its own: it can serve and reach its own server without the key, and reaches
  nothing on the host with it — measured in Docker (Debian 12, bubblewrap 0.8.0). `check` only
  warns on macOS.

- **TLS on macOS: Go and Node work inside the box, and `trustd = true` for what still cannot.**
  Go and Dart verify certificates by asking `com.apple.trustd.agent`, which the sandbox closes,
  so `gh`, `go get` and `flutter pub get` failed with the domain allowed — with a plain tunnel,
  no interception. seisin now sets `SSL_CERT_FILE` to the system bundle (only where it exists,
  and never over one the parent set), which Go 1.27+ uses instead of the system verifier, and
  `NODE_USE_ENV_PROXY=1` so `fetch()` uses the proxy. For Dart and for Go built before 1.27,
  `trustd = true` opens that one service for that one role, and `check` says what it costs.
  Measured: Go 1.27 and Node pass by default; `gh` (Go 1.26) and Dart pass only with the key.
  [Why, and how the other sandboxes answered it →](docs/decisions.md#trustd-every-sandbox-chose-a-side)

## 0.2.0 — 2026-09-21

- **Written down: HTTP(S) works and SSH does not, and the reason is not the one anybody
  guessed.** A field report found it and called it a design boundary; the first version of
  the docs agreed and said there is no TCP egress. Reading the runtime settled it: there is.
  It ships a SOCKS5 proxy, starts it by default, filters it by `(port, host)`, and even sets
  `GIT_SSH_COMMAND` with a `ProxyCommand` pointing at it.

  It breaks at the last link. That proxy requires SOCKS5 authentication so a denial can be
  attributed, and the helper in the `ProxyCommand` cannot send credentials — the runtime's
  own source names it: *"BSD `nc -X 5`, the stock macOS ssh ProxyCommand. Such a connection
  is NEVER tunnelled."*

  The ask that would close it is [written and verified](docs/upstream/ssh-proxycommand.md)
  against both versions, and deliberately **not filed**: two earlier asks are open and
  unanswered, and a third in ten days reads as volume rather than signal.

  Measured three ways, and the differences are the diagnosis: `curl https://…` returns 200;
  bare `ssh` cannot resolve the hostname because it never looks at a proxy; `git ls-remote`
  over SSH reaches the proxy and dies at the handshake. Use an HTTPS remote, run SSH deploys
  outside the turn, and [the write-up](docs/decisions.md#ssh-does-not-work-and-it-is-not-seisin-that-decided-that)
  says whose gap it is rather than calling it a decision.

- **The README is 1,151 lines shorter by about a third**, with the long material moved to
  `docs/` rather than cut: [keys](docs/keys.md), [agents](docs/agents.md),
  [day one](docs/first-day.md) and [scratch](docs/scratch.md) are their own pages now, and
  the front page keeps the diagram, the two GIFs and a paragraph pointing at each.

- **Written down: seisin is read through three surfaces, and a change lands in all of them.**
  The CLI, the console and the MCP server are not layers of one another — they have different
  readers and neither can do the other's work. Both halves of that rule broke on the day it
  was written: `causes` and `walls` shipped in the console and not over MCP, and a rename from
  *refuse* to *decline* reached everything except a button. A test now holds the first shape:
  anything the console derives must have an MCP tool.

- **The MCP server exposes what it had only been computing for the console.** `seisin_causes`
  returns the window grouped by path and by name, with how many causes are on paths no role
  owns; `seisin_walls` returns what a role keeps being denied and would still be denied
  today, with the calls it spent retrying. Both recompute against the policy.

  Until now an assistant got `seisin_activity` — the raw log — and had to re-derive the
  grouping without the policy, which is the half that makes the grouping mean anything. A
  person opens the console; an agent calls these; neither can do the other's work.

- **`seisin_draft_grant` now says it is read-only**, which it always was. Found by a test
  asserting every tool says so: that one did not, and it is the one where it matters, because
  the name says grant and it does not grant.

- **The console's Refuse button says Decline**, which is the word a person's action has had
  since earlier in this release. Found while re-recording the GIF.

- **The console's headline says something the log does not contain.** It led with *"74% of
  the denials is one name"*, and a field review applied this project's own test to it: did
  the number tell you anything you did not know? For somebody who reads the raw log, no —
  they had already counted it, and the console was reading the log back to them. It now also
  says how many causes are on paths **no role owns**, which needs the policy and which no
  grant settles until a person decides who owns them. On the deployment that prompted it:
  28 of 159.

- **The missing-key-floor warning reads content, not just names.** It looked for `.env`,
  `*.pem` and friends, so a credential in `notas.txt` produced nothing. Root-level small
  files are now checked against the same shapes `seisin scan` uses — root only, first hit
  only, because the full walk is `scan`'s job and this runs on every `check`.

- **`file://…#NAME` reads a JSON object as well as an env file**, sniffed from the content
  because the name lies: the file that prompted this was JSON-shaped data in a `.txt`. `#a.b`
  reaches a nested key, a literal `a.b` beats that reading, and an object or array is refused
  rather than stringified into a variable that says `[object Object]` and is called a token.

  **Those two, and no more.** A secret inside a document — a runbook, a table, a page of notes
  — is not reachable by a fragment and should not be. Extracting from prose is guessing, and a
  tool that guesses at credentials hands over the wrong one instead of failing. The error now
  distinguishes *"this file has no `TOKEN=`"* from *"nothing in this file looks like
  `NAME=value`"*, and the second says the fix is to move the secret out of the document.

- **The "no delivery mode" error no longer sends you into a second error.** It offered
  `[keys.providers.file] mode = "env"` as an alternative to `key_mode`, and that is refused —
  a built-in scheme cannot be redefined. Found in the field, on the first wall somebody hit
  trying the feature.

- **The counter's effect is not claimed.** `denied N times` ships; whether it makes an agent
  stop is not shown and will not be for a while, because 86% of the repeats it would reduce
  were one lock file that the previous release deleted outright. Both landed days apart and
  the larger cause ate the other's test case. Said in the README and in the field notes rather
  than smoothed over.

- **A policy with no credential floor, in a repo that has credentials, is now warned about.**
  `[keys] dir` is what produces `denyRead`; without it the emitted settings deny no reads at
  all, so every role reads every secret in the repository — and nothing said so. Verified
  before the fix: `keyDirs []`, `denyRead []`, and four warnings fired, none of them this one.

  The dangerous shape is a policy a script generates, which is not hypothetical. A shallow
  look at the repository root, one `readdir`, conventional names only — a project with no
  secrets is not nagged, because that is the noise that teaches people to skip warnings.

  Credit: this is `L-01` of an outside code review, which observed that the file path was
  protected and only the object path was exposed. Checking that turned out to be generous —
  the file path had the same hole.

- **`scratch` announces its path under both conventions.** It set `<NAME>_FILE`, which is the
  Docker-secrets shape — and a large family of tools already expects a path in the plain
  variable: `KUBECONFIG`, `GOOGLE_APPLICATION_CREDENTIALS`, `AWS_SHARED_CREDENTIALS_FILE`. For
  those, `KUBECONFIG_FILE` is a name nothing reads.

  Found by running `kubectl` against it instead of reasoning about it: the file was there, was
  correct, was parsed — and the variable it had been announced under was one kubectl has never
  heard of. Both are set now, both hold the path, and in this mode neither holds the value.

- **An agent that sandboxes itself is named before it starts.** `codex` confines every command
  it runs with its own Seatbelt profile, and the OS will not apply a second one to a process
  that already has one. Inside `seisin run` that is
  `sandbox-exec: sandbox_apply: Operation not permitted` — a message that names neither seisin,
  nor the agent, nor the fix.

  Worse, it does not fail at the start: the agent launches, reads, thinks, and dies on the
  first command it tries to confine, so the operator sees a turn that did nothing, which looks
  exactly like an agent with nothing to do. Re-measured while adding this: exit 71, and the
  inner command produced no output at all.

  A short **closed** list — codex on by default, gemini only with `-s` — checked before the
  spawn. It warns only when the agent's own sandbox is actually on, and it says the flag rather
  than passing it: handing somebody a bypass flag they did not write is the quiet widening this
  tool exists to refuse.

- **Every KPI is a link to its own page.** The console had five numbers on one screen and they
  pointed at two; now *waiting on you*, *unsandboxed*, *denied*, *one cause* and *spent
  retrying* each open the detail of exactly that number. A number you cannot click is
  decoration.

  **Denied, by name** is the new one worth having: `index.lock` — 1,081 denials, 74%, across
  eight paths and six roles, with every path and its count. That is the cut that says whether a
  day was a tooling problem or a territory one, and by path alone it reads backwards.
  **Walls** lists it per role with what retrying cost.

  The row itself sits outside the views, so the same five numbers are on every screen. Four of
  the five it replaces were constants — 31 roles, 31 sandboxed, 0 unsandboxed, 31 with no keys
  — and the only live one was last and the same size. Emphasis is now conditional: at zero a
  card goes quiet and says so in words.

- **A view that throws no longer takes the rest of the page with it.** Found while building the
  above: one renderer kept a reference to a box that had moved to its own page, threw on its
  first line, and every number on the screen rendered as `0` — including the ones that had
  nothing to do with it. A console whose KPIs read zero because of a typo is worse than one
  that is down, because zero is a plausible answer.

- **The console serves `/?anything`.** It matched `req.url` exactly, so any query string got a
  404 on the one page it has.

- **One word per actor, and there is a glossary now.** The tool's product is the sentence you
  read when something is stopped, and it had four words for one event — `block`, `denial`,
  `refusal`, `deny` — with `deny` naming both what the boundary does and what a person does
  about it.

  **The boundary denies. A person declines. seisin refuses a configuration it will not
  accept.** Three actors that were sharing two verbs now have three.

  `seisin decline <n>` replaces `seisin deny <n>`; the old spelling still works and is no
  longer documented. Nothing else moved: `verdict: "denied"` stays in the log and in the MCP
  schema, because that is 1,452 stored lines and a published enum against one line of command
  dispatch — the earlier attempt at this distinction renamed the expensive side.

  In the console, the panel that groups denials is `causes`, not `friction`: `seisin review`
  already had a `friction` that counts something narrower, and two screens reporting different
  numbers under one label is a thing nobody notices until they compare them.

  [docs/glossary.md](docs/glossary.md) is new and is the point — every term drifted because
  there was nowhere for a new one to collide. `CONTRIBUTING.md` now says a term reaches the
  CLI, the console, the log or the README with its line in the glossary or it does not arrive.

- ⚠️ **For embedders: `loadConfig().roles[x].writes` now includes the sidecar expansion.** A
  role declaring `["data/x.sqlite", "src/**"]` comes back with five entries, not two. That is
  deliberate — the grant and the sentence have to agree, so `ownersOf` and `explain` see them
  too — but a caller that renders `writes` as "what the user typed" wants the new
  **`writesDeclared`**, which is the unexpanded list. Nothing else on the public surface
  changed shape; the rest of this release is additive.

- **A SQLite database is declared once, not four times.** `writes = ["x.sqlite"]` now also
  grants `-wal`, `-shm` and `-journal`. Measured on one real policy: **744 of 1,248 write
  lines — 60% — were sidecars**, every one of them beside its own `.sqlite`. Verified against
  that policy after the change: **31 of 31 roles receive exactly the same paths from the
  kernel**, and the file is 504 lines instead of 1,248.

  It grants nothing new — the `-wal` is that database's pending transactions, so whoever can
  write the database can already empty it. The expansion happens when the policy loads, so
  `whose` and `explain` see it too: the owner of a database owns its `-wal`, or the boundary
  and the sentence would disagree. Closed suffix list, and only after `.sqlite` / `.sqlite3`;
  `.db` is excluded on purpose.

- **`seisin check` prints them back collapsed**, as `x.sqlite+wal+shm+journal`, and the
  "claimed by more than one role" list counts a shared database once. That list was already
  counting each sidecar separately before any of this: 77 entries where 53 was the honest
  number.

- **The README says in one sentence how this differs from a sandbox runtime**, now that there
  are good ones: they isolate the agent from your machine, seisin separates roles from each
  other inside one repository and names the owner when it blocks. They compose.

- **The console opens on what needs you, not on the policy.** It landed on Roles — a wall of
  paths rendered before anybody asked a question — while the queue of decisions sat behind a
  nav item. Reference is looked up; decisions are shown.

- **Refusals are grouped by what was refused, not by who asked**, in a new *Where the day
  went* panel, with a bar per cause and a sentence that says what the shape means. Per role
  the same list appears a hundred times: on one deployment 1,081 of 1,452 refusals were a
  single lock file across eight paths.

  **The grouping goes one level coarser than the path, and that changes the answer.** By
  path, no single cause passed 17% and the page concluded "no cause dominates" — right
  arithmetic, backwards reading. By name, 74% was one thing. One kind of thing at that scale
  is a tooling problem with a mechanical fix; the same volume spread across unrelated paths
  is a territory question that needs a person. The page now says which of the two it is
  looking at.

  A cause is greyed when the policy no longer refuses it — recomputed, not read out of the
  log — so a grant retires its row instead of leaving somebody to fix what is fixed.

- **"Retried anyway"** lists the roles still hitting walls they have already been refused,
  with the calls each one spent retrying.

- **`file://` ships built in**, because a secret in a plain file is the case this exists for
  and making it declare a provider that runs `cat` was a papercut on the only path most people
  take. `keys = ["TOKEN=file://.secrets/netlify.txt"]`, or one variable out of a file that
  holds a dozen: `"RESEND_KEY=file://.secrets/all.env#RESEND_KEY"`. Paths resolve against the
  policy's directory, not the current one. `export` and quotes come off. A fragment naming a
  key the file does not have is an error, never an empty value.

  **It grants no read**, which is the thing `keys = ["all.env"]` cannot do: a file grant is a
  file grant, so that form hands the role every variable in the file. Verified against the
  kernel. It is the only builtin and cannot be redefined — one scheme meaning two things in
  two repos is the failure this feature removes.

- **The provider contract is written down**, so a third party can add one without reading the
  source: `{ref}` substituted into an `argv` (no shell), exit 0 with the value on stdout,
  stderr passed through to the human and stdout never, any failure stops the run. With
  recipes for 1Password, Bitwarden, sops, pass, Vault, AWS and gcloud — marked for which were
  measured here and which follow the tool's documented CLI.

- **A provider script inside the repo is denied to every role**, exactly as `seisin.toml` is.
  The parent executes the provider command, unsandboxed — so a role that could rewrite
  `bin/open-vault.sh` would decide what runs outside the box. Verified against the kernel: the
  owning role writes its siblings and is refused that one file. A command found on `PATH`
  (`security`, `op`, `gpg`) is left alone; that is a machine, not a repo.

  Found by writing the documentation, which is the part worth saying: every worked example
  ended up being a script, because the config format has no escapes and a one-line shell
  pipeline cannot be spelled. The shape this protects is the shape the tool pushes you into.

- **An escaped quote says so.** `command = ["sh", "-c", "… \"$(…)\" …"]` used to fail with
  `missing comma` pointing into the middle of a pipeline. It now names the cause and the way
  out — put it in a script.

- **A key's delivered name cannot collide with one the child already needs.** Found reviewing
  the feature above as a stranger would install it: `keys = ["keychain://path"]` derived `PATH`,
  overwrote it with the secret, and the sandbox died with `env: node: No such file or directory`
  — a config mistake shaped exactly like a broken installation. Worse, `SEISIN_ROLE` is how the
  hook inside the box learns which role it is, and a key could set it. Both refused when the
  config loads, along with one name claimed by two keys, which used to deliver the second and
  drop the first in silence.

- **`seisin check` prints the provider commands**, because `[keys.providers] command` is the one
  thing in a `seisin.toml` that *executes* — in the parent, unsandboxed, as you. A config that
  arrived with a cloned repository is code you are about to run. Now named in the README and in
  `docs/decisions.md`, and `check` still runs nothing.

- **The refusal counter reads the tail of the log, not all of it.** It runs inside the hook, and
  the log never rotates: 3 ms at 372 KB, 300 ms at 37 MB, on every refusal forever.

- **A refusal remembers that it has been given before.** From the second time a role is refused
  the same thing, the sentence says so: *"you have been refused this 3 times now; it is not
  going to work on the fourth try."* Measured on a real team, **88 of 345 blocks (25%) were a
  repeat** — one role hit the same wall nineteen times. Every refusal was correct; none was a
  false positive; it still cost the calls, because correct and heard are different properties.

  **`seisin walls <role>`** prints the standing list with what retrying cost. A wall is
  **recomputed against the current policy**, not read out of the log: if the role would be
  allowed today it is not a wall, so a grant clears it on the next turn rather than when a time
  window expires. Silent on the first refusal — a counter reading `1×` every time is noise.

- **A key can be a reference instead of a file.** `keys = ["keychain://netlify-token"]`,
  resolved by a provider declared in the same file — a command with a `{ref}` placeholder, so
  adding 1Password, Bitwarden, `sops` or Vault is TOML and not code. Path keys are unchanged
  and the two forms coexist in one list.

  The parent resolves, never the confined process: the provider command holds the vault's own
  credential, and running it inside the box would put that credential in there too. An unknown
  scheme is **refused**, not ignored. A provider that fails **does not degrade** — not to
  empty, not to the file of the same name, not to a skipped key.

  **What it does not do:** it resolves the secret *at rest*, not in the agent's context. The
  value still reaches the process. That is `inject`, and `inject` is declarable but refused by
  name, because the runtime only masks a credential when the role's TLS is terminated with a CA
  of seisin's own — MITM over all of that role's traffic.

- **How a key is delivered is declared beside the permission.** `key_mode` on the role, `mode`
  on the provider, role wins. `env` passes the value as a variable; `scratch` writes it to a
  file in the run's scratch space, hands over the path as `<NAME>_FILE`, and removes it when
  the turn ends. There is **no default** — a reference with no mode is an error, because the
  two answers differ in what the agent can walk away with.

  It is called `scratch` and not `file` deliberately: the runtime has a `credentials.files`
  that takes paths and, on macOS, makes them unreadable instead of masking — failing as though
  the feature did not exist. Two names that close together, one of which fails silently, is a
  trap with a date on it.

- **`seisin check` validates references without resolving them** — the scheme, the provider,
  the mode, and whether the provider's command is on `PATH`. A broken key policy is visible
  without asking anyone's keychain for a password.

## 0.1.1 — 2026-09-20

- **`git status` in a repo you do not own stops filing permission requests.** The sandbox
  now sets `GIT_OPTIONAL_LOCKS=0`, which turns off the index refresh that `status` and
  `diff` perform as a courtesy — and it is that refresh, not the read, that takes
  `.git/index.lock`. Measured on a live portfolio before the change: of the last 60
  refusals **58 were `.git/index.lock`**, and most carried no owner at all, so not one of
  them was a territory question. A human approving those is arbitrating a mutex.

  This **removes the need for a grant rather than widening one** — the boundary does not
  move. Writing git still works: `add`, `commit` and `checkout -b` take the locks they
  require, verified against a real repo, not read from the manual. A role that wants the
  old behaviour names `GIT_OPTIONAL_LOCKS` in its `env` and sets it in the parent.

## 0.1.0 — 2026-09-17

First published version. What it is at this point:

- **`seisin run <role> -- <cmd>`** — runs any command as that role, with the boundary in the
  kernel via [`@anthropic-ai/sandbox-runtime`][srt]: Seatbelt on macOS, bubblewrap on Linux.
  Territory, keys and network egress, all deny-by-default.
- **`whose` / `explain`** — the question the boundary cannot answer on its own. When a write
  is refused, these name the role that owns the path, from inside or outside the box, and
  across a worktree and its canonical checkout.
- **The hook** (`seisin wire`) — turns a refusal into a message the agent can act on instead
  of an `EPERM` it has to guess about.
- **Requests** — a refusal leaves a queued ask behind; `seisin grant <n>` rewrites the policy
  with its provenance, and `seisin deny <n>` records why not. Approving is a terminal
  command on purpose, never a tool call.
- **`init`**, **`check`**, **`review`**, **`scan`**, **`log`**, **`ui`**, and an MCP server
  (`seisin mcp`) that is read-only by construction.
- **`[runtime] isolate`** — a role can run with its own home directory, losing the
  credentials the ordinary mode leaves reachable.

Measured, not asserted: 225 tests, 18 of which run real commands through the real kernel and
fail the build if they *skip*. Green on macOS 15 and on Debian 12.15 with bubblewrap 0.8.0,
and on Node 18/20/22 in CI at every push. What has been run against which platform, what
broke on the way, and what is still open is in
[docs/what-it-has-been-put-through.md](docs/what-it-has-been-put-through.md).

Known and documented rather than fixed: deleting inside your own territory is permitted (the
ask is [upstream](https://github.com/anthropics/sandbox-runtime/issues/545)), Windows has
never been pointed at, and `init` only reads `.claude/agents/` and `CODEOWNERS`.

[srt]: https://github.com/anthropics/sandbox-runtime
