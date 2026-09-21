# Glossary

The words this project uses, with one meaning each.

This page exists because the product *is* a sentence. seisin does not provide isolation — the
kernel does that, and other tools do it well. What it adds is the line you read when something
is stopped, and a tool whose output is a sentence cannot afford four words for one thing.

**The rule, and it is in [CONTRIBUTING.md](../CONTRIBUTING.md) too:** a term that reaches the
CLI, the console, the log or the README arrives with its line here, or it does not arrive.

---

## Three actors, three verbs

This is the distinction the whole tool is built on, and it was blurred for a while because one
word was doing two opposite jobs.

| who | verb | what it produces |
|---|---|---|
| **the boundary** (the kernel, via the sandbox runtime) | **denies** | a **denial** — recorded as `verdict: "denied"` |
| **a person** | **grants** or **declines** | a policy change, or a refusal to make one, with a reason |
| **seisin itself** | **refuses** | an error: a configuration it will not accept |

Each word belongs to exactly one of them.

- The boundary **denies**. It does not decline — it has no opinion, it has a rule.
- A person **declines** a request. They do not deny it, because "deny" is what already happened
  to the agent and saying it twice for two different events is how a queue entry ends up
  meaning the opposite of what the reader thinks.
- seisin **refuses** a config — an unenforceable glob, a key name that collides, a provider
  with no `{ref}`. Nothing was attempted and nobody was stopped; the file is wrong.

*Why `deny` for the boundary and not `refuse`:* `denied` is the value in every log line ever
written, the enum in the MCP schema, and the word `allow`/`deny` used by IAM, Kubernetes and
the sandbox runtime underneath. The distinction is worth having; paying for it in stored
evidence and a published schema is not, when renaming the person's command costs one line.

---

## The policy

**role** — a named identity a command runs as. `seisin run <role> -- …`. The unit everything
else attaches to.

**territory** — the paths a role may write, its `writes`. A path is in exactly one role's
territory or in several, and overlap is allowed and reported.

**owner** — the role whose territory a path is in. *Owning* is about territory.

**holder** — a role that may read a given key. *Holding* is about keys. The two are different
words on purpose: a key is carried, not possessed, which is also what the project's name means.

**key** — a credential a role may reach. Either a path inside a declared `[keys] dir`, or a
**reference** resolved by a **provider**.

**reference** — a key written as `scheme://something` instead of a path. What gets committed,
reviewed and approved; never the value.

**provider** — the command that turns a reference into a value. Runs in the parent, outside the
sandbox. `file://` is the one that ships.

**scratch** — the temporary space every role can write, because an agent that cannot write a
temp file cannot work. Also where a `scratch`-mode key lands for the length of a turn.

**resource** — *(not built; the word is reserved so it cannot be used for anything else)* a
named set of paths that several roles may refer to. A resource is **not** owned — territory is
still what decides who the owner is.

## What happens

**denial** — one refused read or write, as the boundary saw it. The event. Not "block", which
is not a word this project uses.

**request** — a permission an agent asked for and cannot have, waiting on a person. Says
**asked**, not denied, because asking before reaching is allowed and reasonable.

**grant** — approving a request. The only action that writes to your policy, and it happens in
a terminal or in the console, never through MCP.

**wall** — something a role has been denied at least twice **and would still be denied today**,
recomputed against the policy as it stands rather than read out of the log. `seisin walls`.

**cause** — in the console, one path that denials are grouped under, and the name that several
of those paths share. A day where three quarters of the denials share one cause is a tooling
problem; the same volume spread across unrelated causes is a territory question.

**friction** — in `seisin review`, repeated denials that are not about keys. Narrower than
*cause* and computed differently; the two numbers are not meant to match.

## The machinery

**policy** — the `seisin.toml`. The file, not the model built from it.

**boundary** — the enforced limit. The kernel's, never seisin's: seisin writes the settings and
explains the result.

**settings** — the JSON the sandbox runtime is handed. Derived from the policy, never written
by hand.

**sidecar** — the files SQLite creates beside a database: `-wal`, `-shm`, `-journal`. Declaring
the database grants them, because they are the same database.

**isolate** — how much of your home a role stops reaching. Off, `credentials`, or `home`.

---

## Words this project does not use

- **block** — say *denial*.
- **refuse** for what the boundary does — it **denies**. `refuse` is what seisin does to a bad
  config.
- **deny** for what a person does — they **decline**. `seisin deny` still works and is not
  documented; it is spelled `seisin decline`.
- **permission** as a countable thing — there is no permission object. There is a territory, a
  key, and a request.
