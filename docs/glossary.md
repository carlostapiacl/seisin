# Glossary

The words this project uses, with one meaning each.

This page exists because the product *is* a sentence. seisin does not provide isolation — the
kernel does that, and other tools do it well. What it adds is the line you read when something
is denied, and a tool whose output is a sentence cannot afford four words for one thing.

**The rule, and it is in [CONTRIBUTING.md](../CONTRIBUTING.md) too:** a term that reaches the
CLI, the console, the MCP server, the hook's messages, the log or the README arrives with its
line here, or it does not arrive. `test/words.test.js` holds the list of words that do not.

**How to read an entry.** The definition is one sentence. *Next to* says how it relates to the
words around it. *Not:* lists the words that mean the same thing and are not used. *Where* is
where a user meets it. *Elsewhere* is what the same word means in the tools people already use —
numbers point to [the sources](#sources) at the end — and ⚠ marks a place where that meaning
differs from ours and a reader will bring the wrong one with them.

**Six contexts.** [Policy](#policy) is what you write. [Enforcement](#enforcement) is what holds
it. [Decisions](#decisions) is what happens when something is denied and a person answers.
[Audit](#audit) is what is written down. [Observation](#observation) is what the log says
about the policy. [Surfaces](#surfaces) are where you read all of it.

---

## Three actors, three verbs

This is the distinction the whole tool is built on, and it was blurred for a while because one
word was doing two opposite jobs.

| who | verb | what it produces |
|---|---|---|
| **the boundary** (the kernel, and the runtime's proxy for the network) | **denies** | a **denial** — recorded as `verdict: "denied"` |
| **a person** | **grants** or **declines** | a policy change, or a decision not to make one, with a reason |
| **seisin itself** | **refuses** | an error: a policy it will not load, or a command it will not run |

Each word belongs to exactly one of them.

- The boundary **denies**. It does not decline — it has no opinion, it has a rule. It does not
  *refuse* either, and it does not *block*.
- A person **declines** a request. They do not deny it, because "deny" is what already happened
  to the agent, and saying it twice for two different events is how a queue entry ends up
  meaning the opposite of what the reader thinks.
- seisin **refuses** — a glob it cannot enforce, a key name that collides, a provider with no
  `{ref}`, `seisin run` inside `seisin run`. Nothing was attempted and nobody was denied; the
  input is wrong.

*Why `deny` for the boundary and not `refuse`:* `denied` is the value in every log line ever
written, the enum in the MCP schema, and the word `allow`/`deny` used by IAM, Cedar, Claude
Code's permission rules and the sandbox runtime underneath [2, 6, 14, 15]. The distinction is
worth having; paying for it in stored evidence and a published schema is not, when renaming the
person's command cost one line.

---

## Policy

What you write, in one file, and what it means before anything runs.

**policy** — `seisin.toml`: the file that says which role writes where and reads which keys.
*Next to:* the file, not the model built from it; *settings* are derived from it. *Not:* config,
configuration, permission file (for ours). *Where:* `seisin init`, `seisin check`, the console's
**Config file** view, every "edit the policy" hint. *Elsewhere:* the same word in OPA, Cedar, IAM
and OpenShell — a declarative document of rules [13, 14, 15, 19]. Aligned.

**role** — a named identity a command runs as: `[roles.<name>]`, `seisin run <role> -- …`. The
unit everything else attaches to. *Next to:* an **agent** runs *as* a role; the same agent can
run as different roles on different runs, and a role can be run by different agents.
*Not:* cell, member, seat, profile. *Where:* every command that takes `<role>`, the console's
**Roles** view. *Elsewhere:* an IAM role is also an identity you run as [15] — aligned. ⚠ In
Kubernetes RBAC a Role is a *set of permissions* bound to subjects [18]; ours is the subject.
Claude Code's `.claude/agents/` files define **subagents** [5]; `seisin init` proposes roles from
those files, and that is the only link between the two words.

**agent** — the program doing the work: Claude Code, codex, opencode, gemini, a script.
*Next to:* not a policy object — seisin never names an agent, only the role it runs as. *Not:*
assistant (except for the one reading the MCP server), bot, worker. *Where:* README, `docs/agents.md`,
the hook's messages ("you are frontend"). *Elsewhere:* Claude Code: agent, subagent, agent team [4, 5].

**territory** — the paths a role may write: its `writes`, minus its `never_writes`. A path is in
one role's territory, in several (overlap — allowed, and reported), or in none (*unowned*).
*Next to:* ownership is computed from territory; keys are not territory. *Not:* folders (except in
the one-line pitch, "its own folders and its own keys"), writable roots, scope, workspace, zone.
*Where:* `seisin check`, `seisin explain`, `seisin whose`, the console's `writes` column.
*Elsewhere:* Codex calls the closest thing **writable roots**, Claude Code **working directories**
plus `sandbox.filesystem.allowWrite`, MCP **roots** [1, 2, 7, 22]. None of them is per identity;
that is why the word is ours.

**owner** — a role whose territory a path is in. *Owning* is about territory. A path can have
several owners. *Next to:* **whose** is the question, **belongs to** is the answer, **claim** is
what a role does when a line is added to its `writes`. *Not:* holder (that is keys), maintainer.
*Where:* `seisin whose`, every denial sentence ("belongs to backend"), MCP `owners`.
*Elsewhere:* GitHub CODEOWNERS names a *person or team* whose review a path needs [23]; ours is a
role, and it is enforced rather than requested. `seisin init` reads CODEOWNERS for that reason.

**unowned** — a path inside the repository that no role's territory covers. Nobody can write it
until one role claims it. *Not:* owned by nobody, no owner, orphan, unclaimed — say *unowned*,
or in a sentence to an agent, "no role owns this". *Where:* `seisin review`, the console, MCP `standing: "unowned"`.

**`never_writes`** — paths a role subtracts from its own territory; it wins however wide `writes`
is. A **subtraction**, never a grant. *Next to:* a denial it causes leaves no request, because
granting would undo what somebody wrote on purpose. *Not:* deny list, exclusion. *Where:*
`[roles.<name>]`, `seisin check`, the hook's message. *Elsewhere:* the sandbox runtime's
`denyWrite` inside an `allowWrite` [6] — this is what it compiles to.

**key** — a credential a role may read, declared in the policy: either a file inside a declared
`[keys] dir`, or a **reference** resolved by a **provider**. Only a credential the policy names is a
key. *Next to:* a *secret* is the value; a *credential* is anything secret-shaped wherever it lives
(what `seisin scan` finds); a key is a credential the policy has put a name on. *Not:* key for a
TOML setting (say **setting**), key for a request's id (say **id**), token, secret file. *Where:*
`keys = [...]`, `[keys] dir`, `seisin scan`, `seisin explain <role> read <key>`. *Elsewhere:*
Claude Code calls its equivalent `sandbox.credentials` [1]. ⚠ "key" is also a TOML key and a
cryptographic key; the first is why check says **setting** now.

**holder** — a role that may read a given key. *Holding* is about keys. The two are different
words on purpose: a key is carried, not possessed, which is also what the project's name means.
*Where:* the hook's session message ("Keys you hold"), `seisin explain`. *Elsewhere:* AWS KMS
calls the receiving identity of a grant the *grantee principal* [17].

**key directory** — a directory named in `[keys] dir`. Every role is denied reading it; each
declared key is allowed back to the roles that hold it. *Not:* secrets dir, vault.

**reference** — a key written as `scheme://something` instead of a path. What gets committed,
reviewed and granted; never the value. *Elsewhere:* 1Password's **secret reference**
(`op://vault/item/field`) is exactly this, and works as one here [27]. Aligned.

**provider** — the command that turns a reference into a value. Runs in the **parent**, outside
the sandbox. `file://` is the one that ships; its fragment reads an env file or a JSON object, and
nothing else, because those are formats and a document is not. *Where:* `[keys.providers.<scheme>]`,
`seisin check`. *Elsewhere:* the Secrets Store CSI driver's *provider* — a plugin that fetches from a
store [28] — is the same idea. ⚠ NVIDIA OpenShell uses **provider** for the credential record
itself [13]; if you come from there, our provider is the fetcher, not the credential.

**key mode** — how a role receives the value of a reference: `env` (an environment variable) or
`scratch` (a file in the **run directory**, removed when the run ends). `inject` is reserved and
refused until it can be built. *Where:* `key_mode`, `[keys.providers.*] mode`. *Elsewhere:* Claude
Code's credential **mask** [1] is what `inject` would be.

**protected** — a path no role writes even inside its territory, because something outside the
sandbox acts on it: git hooks and config, a project's `.claude/`, `.mcp.json`, `.envrc`, and two
**families** that a policy can hand out. *Next to:* a denial on a protected path leaves no request;
it is the boundary working. *Not:* locked, reserved, system file. *Where:* `seisin check`
("protected — inside a territory, denied anyway"), MCP `standing: "protected"`, the console.
*Elsewhere:* Claude Code's sandbox has **protected paths** with the same reason [1]; Codex keeps
`.git`, `.codex`, `.agents` read-only inside writable roots and calls them **protected paths** [7].
Aligned — the word was chosen for that.

**control file** — a protected file an editor or the next agent session acts on. *Next to:* the
general case of *protected*. *Where:* the console's **Control files** panel, `control_files = [...]`.

**family** — a named group of control files a policy can hand to one role: `ide` (`.vscode/`,
`.cursor/`, `.windsurf/`) and `instructions` (`CLAUDE.md`, `AGENTS.md`, …, protected only when
`[protect] instructions = true`). The rest of the control files belong to no family and are never
handed out. *Where:* `control_files`, `[protect]`, `seisin check`.

**isolate** — how much of your home a role stops reaching: off (`false`), `"credentials"` (the
places credentials live are denied; `HOME` untouched), or `"home"` / `true` (the above, plus a
`HOME`, `TMPDIR` and XDG set of the role's own — its **isolated home**). *Where:* `[runtime] isolate`.
*Elsewhere:* ⚠ Claude Code's *worktree isolation* is a separate checkout [4], and an *isolate* in
V8 and Cloudflare Workers is a JavaScript heap; ours is only ever this setting.

**scratch** — the space every role may write whatever its territory, because an agent that
cannot write a temp file cannot work: `[runtime] writes`, by default `~/.claude`, `~/.codex`,
`~/.cache`, `~/.local/{share,state}`, `$TMPDIR`, `/tmp`. **Shared** between roles, which is the
hole [docs/scratch.md](scratch.md) is about. *Next to:* not the run directory, which is private.
*Not:* temp space for a run, scratchpad, tmp. *Elsewhere:* ⚠ Claude Code's *scratchpad* is a
per-session, private directory; ours is neither — that is the point of naming it.

**map** — the policy as it resolves per role: what each role writes, what it reads, what it is
denied. What `seisin check` prints and `seisin_state` returns. *Not:* permission map. "Outside the
map" (console) is **standing: outside**.

**resource** — *(not built; the word is reserved so it cannot be used for anything else)* a
named set of paths that several roles may refer to. A resource is **not** owned — territory is
still what decides who the owner is. *Elsewhere:* ⚠ MCP **resources** [22] and Cedar's
**resource** [14] are unrelated; the reservation keeps a third meaning out.

---

## Enforcement

What holds the policy, and the process that sets it up.

**boundary** — the enforced limit: what the kernel (files) and the runtime's proxy (network) will
let a confined process do. Never seisin's: seisin writes the settings and explains the result.
*Not:* wall (that is a pattern of denials), guard, fence. *Where:* README, "the boundary holds
either way" in `seisin check`. *Elsewhere:* Claude Code: "the operating system enforces that
boundary" [1] — aligned. ⚠ An AWS **permissions boundary** is a *policy* that caps what a role can
be granted [15]; ours is the enforced result, not a document.

**kernel** — the operating system's enforcement: Seatbelt on macOS, bubblewrap (namespaces) on
Linux. What a log line with `source: "kernel"` came from. *Elsewhere:* Landlock calls the enforced
set a **domain** [10]; nono calls the same layer a capability sandbox [12].

**sandbox runtime** — `@anthropic-ai/sandbox-runtime`, the program that turns **settings** into a
kernel profile and runs the network proxy. seisin's only dependency. *Not:* "the runtime" when
you mean the kernel; the runtime makes no decisions a log line reports. *Elsewhere:* [6].

**sandbox** — the confined environment one run executes in. seisin is *not* one; it sets one up.
*Next to:* **confined** is the state of a process inside it. *Not:* box (say *sandbox*: "inside the
sandbox", "outside the sandbox"), jail, container. *Where:* `seisin run`, every "run it outside the
sandbox" hint. *Elsewhere:* Claude Code, Codex, Cursor, VS Code all use *sandbox* for this [1, 7, 8, 9].

**confined** — running inside a sandbox with a role's settings applied. *Opposite:* **unconfined**.
*Not:* sandboxed (acceptable in plain English, avoided in labels), jailed. *Elsewhere:* AppArmor
and nono both say a process is **confined** [12, 26]. Aligned.

**unconfined** — *(new, replaces the console's "unsandboxed" / "open")* a role run without a
sandbox. **`seisin.toml` cannot express it**: it exists only in the console's example-mode what-if.
*Why new:* the console had three words for a state the product does not have, and a live KPI card
counting it; one word, defined as "not expressible", ends that. *Elsewhere:* AppArmor calls a
process with no profile **unconfined** [26] — the same meaning, so no collision.

**settings** — the JSON the sandbox runtime is handed for one run, derived from the policy, never
written by hand. Always say **sandbox settings** where Claude Code's `settings.json` could be meant.
*Not:* profile (reserved for the OS-level thing), config. *Where:* the console's settings panel
("what seisin hands the runtime"), the "Save" preview. *Elsewhere:* ⚠ Claude Code's *settings*
(`.claude/settings.json`) are a protected control file here [1, 4]; the qualifier is what keeps the
two apart.

**profile** — only the OS-level artefact: a Seatbelt profile, a bubblewrap mount set. seisin never
writes one directly. *Where:* "the OS will not apply a second profile to a process that already has
one". *Elsewhere:* Seatbelt profiles in the runtime [6], nono profiles [12], OpenShell provider
profiles [13] — all different, which is why seisin keeps the word for the OS only.

**run** — one `seisin run <role> -- <command>` from start to exit: keys resolved, settings applied,
one audit socket, one run directory. seisin's unit of time. *Not:* round, turn, session,
invocation, job. *Where:* `seisin run`, "once per target per run", "not asked again in 3 runs",
"it applies on the next run". *Elsewhere:* ⚠ Claude Code's **session** (a conversation) and
**turn** (one response) belong to the agent inside the run [3, 4]. Use them only when you mean the
agent's — the hook's `SessionStart` message, "mid-turn".

**run directory** — *(new)* the private directory each run gets under `$TMPDIR/snr/`: its audit
socket, its sandbox settings, and its `scratch`-mode keys. Readable by that run only.
*Why new:* since the 2026-09-23 fix this is a different place from **scratch**, and the glossary
still said scratch-mode keys land in shared scratch — the leak that fix closed. Two places need
two names. *Where:* the `rundir` error ("is not a directory of yours … It holds each run's socket
and keys"), `docs/keys.md`. *Elsewhere:* no established meaning found.

**parent** — the seisin process that starts the sandbox and stays outside it: it resolves keys,
writes the log, files requests. What the confined side cannot reach. *Not:* host, launcher (the
launcher is the part of the parent that builds the environment; say *parent* unless that detail
matters), supervisor.

**observe mode** — `seisin run <role> --observe`: the filesystem is opened, the network stays
shut, and everything is recorded with `verdict: "observed"`, for `seisin init --from-observations`
to propose a policy from. Denies nothing it would otherwise deny on disk. *Not:* audit mode,
dry run, learning mode (for ours). *Elsewhere:* AppArmor's **complain mode** ("learning mode") and
nono's planned `nono learn` do the same job [12, 26].

**sidecar** — the files SQLite creates beside a database: `-wal`, `-shm`, `-journal`. Declaring
the database grants them, because they are the same database.

---

## Decisions

What happens after a denial, and who answers.

**denial** — one read, write or connection the boundary denied. The event. *Not:* block,
refusal, rejection, violation (for ours), "stopped". *Where:* `seisin run` ("1 kernel denial(s)
recorded"), the console's **Denied** view, `seisin log --verdict denied`. *Elsewhere:* the sandbox
runtime and Claude Code call the recorded event a **sandbox violation** and say the operation is
**blocked** [1, 6]; Claude Code's hook event is `PermissionDenied` [3]. When quoting their output,
quote it; in seisin's own voice it is a denial.

**verdict** — the outcome recorded on a log entry: `allowed`, `denied` or `observed`. *Not:*
decision (that is a person's), result, effect. *Where:* `seisin log --verdict`, MCP
`seisin_activity`. *Elsewhere:* Cedar calls it the *decision* (Allow/Deny), OPA a *decision* in its
decision log [14, 19]; ⚠ seisin uses **verdict** so that *decision* is free for the person.

**request** — access a role was denied (or asked for before reaching) and cannot have, waiting
on a person. Filed by the parent, recomputed against the policy, deduplicated per role, action and
directory. Says **asked**, not denied, because asking before reaching is allowed and reasonable.
*Not:* permission request, permission, ticket, approval request. *Where:* `seisin requests`, the
console's **Waiting on you**, MCP `seisin_requests`, the notification. *Elsewhere:* Microsoft Entra's
**access request** — asynchronous, answered by an approver with a justification — is the same
shape [24]. ⚠ Claude Code's `PermissionRequest` is a *synchronous prompt* for one tool call [3];
that is why ours is never called a "permission request".

**ask** — what an agent does that produces a request. *Elsewhere:* ⚠ `ask` is a Claude Code
permission-rule type and a `permissionDecision` value that prompts the user **now** [2, 3]. When
seisin says an agent *asked*, nothing is waiting on a prompt: the run already moved on.

**pending** — a request nobody has granted or declined yet. The **queue** is the list of pending
requests, oldest first.

**stale** — a pending request its role has not asked again in several runs: "likely no longer
needed". Marked, never settled on its own. Declining is still a person's decision.

**id** — the stable name of a request, printed under it by `seisin requests`. Use it rather
than the number, which moves when the queue does. *Not:* key (in any text a person reads).

**grant** — *verb:* what a person does to a request: add its path to the role's `writes` (or its
key to `keys`) in `seisin.toml`, with **provenance**. The only action that writes to your policy,
and it happens in a terminal or in the console, never through MCP. *Noun:* an entry in `writes` or
`keys` that gives access — whether it came from a request or was written by hand ("Granted,
never used"). *Next to:* takes effect on the **next run**; nothing running is widened.
*Not:* approve, accept, allow (a person does not *allow*; the policy allows). *Where:*
`seisin grant`, the console's **Grant** button, MCP `seisin_draft_grant`. *Elsewhere:* a grant in
AWS KMS and SQL is a standing permission given to someone [17, 18] — aligned. ⚠ In Claude Code,
Codex, Cursor, VS Code and Entra a person **approves** one action so it runs **now** [2, 7, 8, 9, 24];
a grant is a policy edit that applies next run, and calling it "approve" invites the wrong
expectation. *Approve* appears only when contrasting with those tools.

**provenance** — the comment a grant writes next to the line it adds: date, how many times it was
asked, the reason. `# granted 2026-09-12 · asked 3× · "…"`.

**decline** — what a person does to a request they will not grant. Recorded with a reason; the
policy is not touched. *Not:* deny, refuse, reject, turn down. *Where:* `seisin decline`, the
console's **Decline** button. `seisin deny` still works and is not documented. *Elsewhere:* Codex
uses **decline** for the same answer [7]; Entra uses *deny* [24] — ⚠ which is exactly the collision
ours avoids.

**revoke** — *(new to this page; the console already uses it)* remove an entry from a role's
`writes` or `keys`. There is no command for it: you edit `seisin.toml`, or preview it in the
console. *Why here:* the console's activity labels say "revoked folder / revoked key" and the word
had no line. *Elsewhere:* the standard opposite of *grant* — SQL `REVOKE`, "grant or revoke access"
in Claude Code's docs [2]. No collision.

**decision** — a person's answer to a request: a grant or a decline. *Not:* for a log line (that
is an **entry** with a **verdict**). *Where:* the console's **Pending decisions**, and the reason every decision there asks for. *Elsewhere:* ⚠ OPA and Cedar call a *policy's* result a decision [14, 19].

**refuse** — what seisin does to input it will not act on: a policy that would not hold as
written, a key name that collides, a nested `seisin run`, an ambiguous request id. Always says
what to do instead. *Not:* for the boundary, ever. *Elsewhere:* Claude Code's docs use the same
verb for the same thing — "Claude Code refuses per-command lists" [1].

**handoff** — routing a denied write to the role that owns it, decided from the policy as it
stands, never from a role name a model chose. `handed to backend`, `handoff held`, `handoff stopped`.
*Elsewhere:* the OpenAI Agents SDK's **handoff** is one agent delegating to another [25]. Aligned —
ours is decided by ownership, not by the model.

**handoff chain** — the sequence of roles one handoff has passed through, bounded in depth. Always
qualified: a bare *chain* is the log's hash chain.

---

## Audit

What is written down, and how you know it was not changed.

**log** — `.seisin/log.jsonl`: one append-only line per **entry**, written by the parent, in no
role's territory. `seisin log`, `seisin watch`, the console's **Activity**. *Not:* audit trail,
history, ledger (in labels — plain English is fine). *Elsewhere:* NIST's **audit log**, "a
chronological record of system activities" [20]. Aligned.

**entry** — one line of the log: role, action, target, **verdict**, owners, and where it came
from — written by the **hook** (the attempt, before it happened; the only way an *allowed* action
is recorded) or marked `source: "kernel"` (what the OS actually denied, shown as `[kernel]`).
*Not:* decision, event (except the `rotated` marker), record.

**hash chain** — every entry carries `prev`, the hash of the line before it, so an edited, removed
or reordered line shows. `seisin log verify`. *Not:* bare "chain" where a handoff chain could be
meant. *Elsewhere:* nono seals its audit record the same way [12].

**genesis record** — `.seisin/log.jsonl.genesis`: the first chained line's hash, written beside the
log, so a log rewritten from its first line does not verify. "Recorded late" when it was written
after chained lines already existed. *Elsewhere:* a blockchain's first entry is its
*genesis block* — the same idea.

**tamper-evident** — what the hash chain makes the log: a change is **detectable**, not
impossible. The agent can still append noise to its own history; it cannot change what is there
without `verify` saying so. *Not:* tamper-proof, immutable. *Elsewhere:* NIST: "makes alterations
to the data easily detectable" [20].

**audit socket** — the unix socket a run's parent listens on, granted to the sandbox by path; the
hook sends entries through it, so the only verb available from inside is *append one line*.

---

## Observation

What the log says about the policy. Everything here is recomputed against the policy as it stands,
never believed from the log.

**window** — the stretch of time a count or finding covers. Every number in `seisin review` and the
console carries one, because *never used* means nothing without *in how long*. *Elsewhere:* IAM
Access Analyzer's **usage window** for unused access [16]. Aligned.

**standing** — where a denied path stands **today**: `owned` (in some role's territory), `unowned`
(in the repository, ownable, nobody claims it), `protected` (closed on purpose, nothing to grant),
or `outside` (a port, a key directory, a path outside the repository — not a place in the map).
*Where:* MCP `seisin_causes`, the console's bars. *Why here:* a published MCP field with no line.

**kind** — for an unowned path, what sort of thing it is, and the move that fits: `credential`,
`git`, `temporary`, `build`, or `territory` (a normal path nobody claims — the only one that is a
question of ownership). In text a person reads, the last one is said **ownable**, because "kind:
territory" reads as its opposite. *Where:* `seisin review` "by kind", MCP `standing.unowned.kinds`.

**cause** — in the console and MCP, one path denials are grouped under, and the name several of
those paths share. A day where three quarters of the denials share one cause is a tooling problem;
the same volume spread across unrelated causes is a territory question.

**wall** — something a role has been denied at least twice **and would still be denied today**,
recomputed against the policy rather than read out of the log. A grant makes its wall disappear on
the next run. `seisin walls`, the console's **Walls**, MCP `seisin_walls`, the hook's session
message. *Not:* block, blocker, stuck path. *Elsewhere:* no established meaning; it needs this line
and nothing to reconcile.

**repeated denials** — *(replaces "friction" and "Stopped, repeatedly")* in `seisin review`, the
same role denied on the same place over and over, keys and connections excepted. A policy that is
wrong, not an agent misbehaving. *Why:* "friction" was defined here and printed nowhere; the
section said "Stopped", a sixth word for denied. (`friction` survives as an internal field name in
`src/review.js`; it reaches no reader.)

**unused grant** — an entry in `writes` nothing was written under during the window: "Granted,
never used". The only evidence anyone has for making a policy smaller. Cannot be computed without
the hook, because only the hook records what was allowed. *Elsewhere:* IAM Access Analyzer's
**unused access** findings [16].

---

## Surfaces

Where a person or an agent reads all of the above. A change to what one says lands in all of them.

**surface** — one of the places seisin is read through: the **CLI**, the **console**, the **MCP
server**, and the **hook**'s messages to the agent. *Elsewhere:* Claude Code: "any place you access
Claude Code" [4]. Aligned. (`src/surface.js` uses the word for what runs outside the sandbox; that
is an internal name and does not reach a reader.)

**CLI** — `seisin <command>`: what a person types, and what every agent runs under.

**console** — `seisin ui`: a local web page for a person deciding something. Opens on what is
waiting, not on the policy. A grant and a control-files change are the only two things it writes
to `seisin.toml`; a decline writes only to the queue.
*Not:* dashboard, panel, UI (in prose), admin.

**MCP server** — `seisin mcp`: read-only answers for an agent asking about its own situation.
Seven tools; none of them writes, and none of them grants. *Elsewhere:* its tools would carry MCP's
`readOnlyHint` [22].

**hook** — `seisin hook`, installed by `seisin wire` into the agent's own hook system: records
attempts before they happen, explains a denial it can see coming, reads the kernel's denials after
a command fails, and hands the agent its territory and walls when a session starts. Text-based and
evadable on purpose — it explains; the boundary enforces. *Elsewhere:* Claude Code **hooks**
(`PreToolUse`, `PostToolUse`, `SessionStart`) [3].

**notification** — one message per new request, sent by the parent to `[notify]`: role, path,
whose it is, and the `seisin grant` / `seisin decline` commands.

**a person** — whoever answers requests. *Not:* human, operator, user, admin, "you" (except in a
label addressed to the reader, like **Waiting on you**). The MCP server says *a person* too: the
agent reading it is not the one who grants.

---

## Words this project does not use

| don't say | say | why |
|---|---|---|
| **block**, blocked | deny, denied, denial | one event, one word; `block` is the runtime's word for it — quote it, don't adopt it |
| **refuse** (for the boundary) | deny | `refuse` is seisin rejecting input |
| **deny** (for a person) | decline | the agent was already denied; the person is doing something else |
| **reject**, rejected | deny (boundary) / decline (person) / refuse (seisin) | it would be a fourth verb |
| **stopped** (for a denial) | denied | same event |
| **approve** (for our grant) | grant | ours edits the policy for the next run; everyone else's *approve* lets one action run now |
| **permission** as a countable thing | territory, key, request, grant | there is no permission object. "Permission layer" is the product category and stays |
| **permission request** | request | Claude Code's `PermissionRequest` is a different, synchronous thing |
| **cell** | team (prose only; seisin has no such object) | the author's orchestrator's word |
| **round** | run | same |
| **turn**, **session** (for seisin's unit) | run | they are the agent's words |
| **box** | sandbox | informal, and it also named a UI panel |
| **unsandboxed**, open (a role) | unconfined | one word for a state the policy cannot express |
| **profile** (for our JSON) | sandbox settings | *profile* is the OS's |
| **friction** | repeated denials | printed nowhere |
| **operator**, **human** | a person | one approver, one word |
| **folders** (for a territory) | territory | "folders" survives only in the one-line pitch |
| **key** (for a TOML key or a request id) | setting / id | *key* is a credential |
| **chain** (for a handoff) | handoff chain | a bare chain is the log's |
| **decision** (for a log line) | entry, verdict | *decision* is the person's |
| **tamper-proof** | tamper-evident | the chain detects; it does not prevent |

---

## Sources

The numbers in *Elsewhere* notes, checked on 2026-09-30. Each line says what the page was
checked for.

1. [Claude Code — Sandboxing](https://code.claude.com/docs/en/sandboxing) — *sandbox*, *boundary*, *sandbox violations*, *blocked*, *unsandboxed*, *escape hatch* (`dangerouslyDisableSandbox`), `allowWrite`/`denyWrite`, **Protected paths**, *Protect credentials*, *mask*, per-user temp dir, "Claude Code **refuses** per-command lists"
2. [Claude Code — Configure permissions](https://code.claude.com/docs/en/permissions) — *permission rule* (allow / **ask** / deny, evaluated deny→ask→allow), *permission mode*, *approve*, "grant or revoke access", *working directories*, *additional directories*
3. [Claude Code — Hooks reference](https://code.claude.com/docs/en/hooks) — `PreToolUse` `permissionDecision` = allow / deny / ask / defer; hook event **`PermissionRequest`** ("when a tool needs permission"); `PermissionDenied`; `SessionStart`; *session* vs *turn*
4. [Claude Code — Glossary](https://code.claude.com/docs/en/glossary) — **Session**, **Turn**, **Surface** ("any place you access Claude Code"), **Subagent**, **Agent teams**/teammates, *Sandboxing* ("a boundary you define upfront"), *Worktree isolation*, *Permission rule*
5. [Claude Code — Subagents](https://code.claude.com/docs/en/sub-agents) — *subagent* = specialised assistant in its own context, defined in `.claude/agents/`
6. [`@anthropic-ai/sandbox-runtime` README](https://github.com/anthropics/sandbox-runtime) — `allowWrite`/`denyWrite`/`allowRead`/`denyRead`, `allowedDomains`/`deniedDomains`, **violation** / `SandboxViolationStore` ("blocks the operation and logs the violation"), *sandbox profile* (Seatbelt, generated), *proxy*
7. [OpenAI Codex — Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security) — sandbox modes `read-only` / `workspace-write` / `danger-full-access`; approval policies `on-request` / `never`; **protected paths** `.git`, `.codex`, `.agents` stay read-only inside writable roots; user **approves** or **declines**
8. [Cursor — Run modes](https://cursor.com/docs/agent/security/run-modes) — *Auto-review*, *Allowlist*, *Run Everything*; sandbox "cannot write outside approved paths"; "Approvals & Execution"
9. [VS Code — Manage approvals](https://code.visualstudio.com/docs/agents/run/approvals) · [Sandbox agent terminal commands](https://code.visualstudio.com/docs/agents/run/agent-sandboxing) — *approval* (does this action run now) vs *sandboxing* (what an approved command can reach); `autoApprove`; "to block, use a PreToolUse hook returning `deny`"
10. [Linux Landlock](https://docs.kernel.org/userspace-api/landlock.html) — *ruleset*, *access rights*, *domain* (a ruleset enforced on a thread)
11. [bubblewrap](https://github.com/containers/bubblewrap) — bind-mount based sandbox; no log of what it denies (already stated in [upstream/cli-violations.md](upstream/cli-violations.md))
12. [nono](https://nono.sh/) · [source](https://github.com/nolabs-ai/nono) — *capability* sandbox, **profiles**, `nono why` ("allowed or denied"), hash-chained **audit** record, *approval* webhooks, planned **`nono learn`** (trace → profile)
13. [NVIDIA OpenShell — Overview](https://docs.nvidia.com/openshell/about/overview) · [Providers](https://docs.nvidia.com/openshell/sandboxes/manage-providers) — per-sandbox declarative **policy**; **providers** = "credentials as first-class entities" (credential records / provider profiles), a *different* meaning from seisin's provider
14. [Cedar — Authorization](https://docs.cedarpolicy.com/auth/authorization.html) — *principal* / *action* / *resource*; **permit** / **forbid**; default **deny**, forbid overrides permit
15. [AWS IAM — Policy evaluation (explicit/implicit deny)](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_policy-eval-denyallow.html) · [**Permissions boundaries**](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html) — *explicit deny*, *implicit deny*; **permissions boundary** = a policy that caps what a role may be granted (a different "boundary"); IAM *role* = an identity you assume
16. [AWS IAM Access Analyzer — unused access](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-concepts.html) — *unused access* findings computed over a *usage window* (≈ seisin's "Granted, never used")
17. [AWS KMS — Grants](https://docs.aws.amazon.com/kms/latest/developerguide/grants.html) — **grant** as a noun: a standing permission given to a *grantee principal*
18. [Kubernetes — RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/) — **Role** = a set of permissions (not an identity); a RoleBinding **grants** a role to subjects
19. [Open Policy Agent — Decision logs](https://www.openpolicyagent.org/docs/management-decision-logs) — **decision** = the result of one policy query; *decision log* for auditing
20. [NIST CSRC glossary — least privilege](https://csrc.nist.gov/glossary/term/least_privilege) · [**tamper evident**](https://csrc.nist.gov/glossary/term/Tamper_evident) · [**audit log**](https://csrc.nist.gov/glossary/term/audit_log) — least privilege; "tamper-evident: makes alterations easily detectable" (not *tamper-proof*); audit log = "chronological record of system activities"
21. [OWASP Top 10 for LLM Applications 2025 — LLM06 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — *excessive permissions / functionality / autonomy*; least privilege for agents; human approval for high-impact actions
22. [MCP spec — Roots](https://modelcontextprotocol.io/specification/2025-06-18/client/roots) · [Tools (annotations)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — **roots** = filesystem boundaries a client exposes (deprecated in the 2026-07-28 revision); **resources**; tool annotation **`readOnlyHint`**
23. [GitHub — About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) — **code owner** = person/team responsible for paths; review requested automatically
24. [Microsoft Entra — Approve or deny access requests](https://learn.microsoft.com/en-us/entra/id-governance/entitlement-management-request-approve) — **access request** = asynchronous ask for access, an *approver* approves or denies, with justification
25. [OpenAI Agents SDK — Handoffs](https://openai.github.io/openai-agents-python/handoffs/) — **handoff** = one agent delegates a task to another
26. [AppArmor — aa-logprof](https://www.apparmor.net/man/master/aa-logprof/) — **complain mode** (a.k.a. learning mode): log what would be denied, block nothing; build the profile from the log
27. [1Password CLI — Secret references](https://developer.1password.com/docs/cli/secret-references/) — **secret reference** `op://vault/item/field`, resolved at runtime (`op read`/`op run`)
28. [Kubernetes Secrets Store CSI Driver — concepts](https://secrets-store-csi-driver.sigs.k8s.io/concepts.html) — **provider** = plugin that fetches a secret from an external store

---

## Future, breaking

Renames that would make stored data, a published schema or a command say the same thing as this
page. None is for this release; each is listed so the next breaking release can take them together.

| today | proposed | where it breaks | why |
|---|---|---|---|
| MCP `seisin_causes` field `stillRefused` | `stillDenied` | published MCP output | the boundary denies |
| `.seisin/requests.jsonl` `kind: "denied"` for a decline | `kind: "declined"` (read both) | stored lines, anyone parsing the queue | a person declines |
| unowned kind value `"territory"` | `"ownable"` | MCP `seisin_causes` (`kind`, `standing.unowned.kinds`) | "kind: territory" reads as the opposite |
| `key_mode = "scratch"` | `"run-file"` | every policy that uses it | the value lands in the run directory, not in scratch |
| `seisin deny` alias | removed | scripts that still call it | one verb per actor |
| `docs/permission-requests.md` | `docs/requests.md` | inbound links, README anchors | the collision with `PermissionRequest` |
