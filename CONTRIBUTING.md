# Contributing

Issues and pull requests are welcome. This page is short and says what is actually different
about contributing here, not what is the same everywhere.

## The one rule the rest follows from

**A claim in this repository has to be downstream of something that was measured.**

Not "this should be faster" — how much faster, on what, measured how. Not "this is safer" —
what got past the boundary before and does not now. The README, `docs/decisions.md` and
`docs/what-it-has-been-put-through.md` are all written this way, and a change that adds an
unmeasured claim to them will be asked for the measurement.

This cuts the other way too, and that is the part worth saying out loud: [a number in these
docs that does not reproduce](docs/field-notes.md#6--what-asking-costs-and-a-number-that-did-not-reproduce)
gets struck out and replaced with what does, including when it was flattering. If you find
one, that is a valuable issue, not a nitpick.

## Reporting something that got past the boundary

**Do not open a public issue.** See [SECURITY.md](SECURITY.md).

A report is much more useful with the `seisin.toml` that produced it and the command you ran.
The boundary is enforced by
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime), so some
findings belong upstream rather than here — if it turns out to be one, it gets filed there
with credit and the issue here tracks it. Two already are, and both are linked from the
README.

## Reporting anything else

The useful shape is: what you ran, what you expected, what happened, and `seisin check`'s
output for the policy involved. `seisin check` runs nothing and touches no credentials, so it
is safe to paste — but **read it first**, because it prints your role names and paths.

## Fixing a recipe

The [provider recipes](README.md#recipes) are the part of this repository that ages fastest:
they are other people's CLIs and they change. Three of them were measured on macOS; the rest
follow each tool's documentation and are marked as such.

**If one is wrong, a pull request fixing it is worth more than an issue.** Say which version
of the tool you ran it against and the whole thing becomes measured instead of assumed.

## Tests

The suite is `node --test`, no framework, and it runs with `npm test`.

**Two standards, and the second is the one people miss:**

1. **A test must be able to fail.** `assert.equal(SOME_CONSTANT, 2)` restates the
   implementation and will be removed. Two were, after they had been written by the same
   person who wrote this paragraph.
2. **A test of the boundary must exercise the boundary.** Twenty-five of the tests run real
   commands through the real kernel, and **CI fails if they skip** — because a green run that
   quietly tested nothing looks exactly like a real one, and once did for eighteen of them
   across a whole platform. Those live in `test/sandbox.test.js` and need
   `@anthropic-ai/sandbox-runtime` installed.

Unit tests with fakes are right for asking what the code *decides*. They cannot tell you what
*happens*. A change to what is allowed needs one of the second kind.

There is a counter in CI that fails if the test totals printed in the README and in
`docs/what-it-has-been-put-through.md` stop matching reality. If it fails on your PR, update
the numbers; that is what it is for.

## Three surfaces, and a change lands in all of them

seisin is read through three things, and they are not layers of one another:

| | who reads it | where it lives |
|---|---|---|
| **the CLI** | a person at a terminal, and every agent, through `run` and the hook | `src/`, `src/commands/` |
| **the console** | a person deciding something | `ui/index.html`, served by `src/serve.js` |
| **the MCP server** | an agent asking about its own situation | `src/mcp.js` |

**A change that touches what any of them say has to land in all three**, or the product
starts disagreeing with itself. Both halves of that failed on one day and each was found by
accident rather than by looking:

- `causes` and `walls` were computed for the console and **not exposed over MCP**, so an
  assistant got the raw log and had to re-derive the grouping without the policy.
- A person's action was renamed from *refuse* to *decline* everywhere except **a button in
  the console**, which kept saying `Refuse` until a GIF was re-recorded.

There is a test for the first shape — anything the console derives must have an MCP tool —
and it exists because a test is the only version of this rule that survives a tired evening.
The second shape has no test yet; `grep` is what there is.

## Words

A term that reaches the CLI, the console, the log or the README arrives with its line in
[docs/glossary.md](docs/glossary.md), or it does not arrive.

This is not tidiness. What this project adds over a sandbox is the sentence you read when
something is stopped, and a tool whose product is a sentence cannot afford four words for one
event. It had four — `block`, `denial`, `refusal` and `deny` — and the fix cost a rename of a
published command, which is what the rule is here to prevent next time.

The three verbs are taken and each belongs to one actor: the **boundary denies**, a **person
declines**, **seisin refuses** a configuration it will not accept.

## The config language

`seisin.toml` is parsed by a deliberate subset of TOML: `[table]` headers and
`key = "value"` / `key = ["a", "b"]` pairs, no inline tables, no escapes. That is not a
missing feature to be completed. From `src/config.js`:

> *If your config outgrows this subset, the config is doing too much.*

Proposals that need the parser to grow will be asked what the configuration is trying to
express and whether it belongs in a policy file at all. Sometimes the answer is yes — the
case has to be made.

## Commits

Prose, lower case, saying **what changed and why it was wrong before**. Look at `git log`.
A message that says "fix bug" makes the history unreadable, and the history here is a
document people actually use — several comments in the source point at it.

## What is out of scope

- **Being a sandbox.** The OS is the sandbox. seisin writes its settings and explains its
  denials. See [What it is not](README.md#what-it-is-not).
- **Storing secrets.** A provider *resolves* a reference; a vault keeps it. Rotation, backup
  and recovery are a different product.
- **Wiring in a specific vault.** A provider is a command, which is what keeps this from
  ageing with somebody else's CLI. A recipe in the README is the right way to add one.
- **A second config format**, for anybody. That decision has its own section in
  `docs/decisions.md`.

## Running it on yourself

The fastest way to find something real is to put a policy on your own repository and work
under it for a day. Nearly every defect worth fixing here was found that way rather than by
reading the code — including the ones written up in the [field notes](docs/field-notes.md).
