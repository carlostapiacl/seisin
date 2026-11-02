# Prior art, and why not a container



- [`anthropics/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime): the enforcement. seisin is a thin thing on top of a serious one.
- [`kornysietsma/claude-code-permissions-hook`](https://github.com/kornysietsma/claude-code-permissions-hook): granular `PreToolUse` rules, one global policy.
- [`XuebinMa/agent-guard`](https://github.com/XuebinMa/agent-guard): an SDK that enforces what an agent may do, also one global policy.
- [`NVIDIA/OpenShell`](https://github.com/NVIDIA/openshell): a runtime that sandboxes an agent with Landlock and seccomp, under a declarative policy. Serious, and the closest thing here by weight. It was evaluated as a possible backend; [the measured compatibility decision](https://github.com/carlostapiacl/seisin/blob/main/docs/openshell.md) explains why it is currently an execution target candidate rather than a drop-in replacement.
- [`dredozubov/hazmat`](https://github.com/dredozubov/hazmat): runs the agent as a different system user, with `pf` rules and snapshots.
- [`nolabs-ai/nono`](https://github.com/nolabs-ai/nono): a kernel sandbox for agents on the host (Seatbelt, Landlock), with per-tool child sandboxes, a credential proxy with endpoint filtering, approval webhooks and a tamper-evident audit log. The most complete sandbox here, and on a Mac the one that enforces through the same kernel seisin does. `nono why` explains *which rule* denied something and how to allow it; it has no notion of *whose* it was.
- *Directory ownership* is recommended in half the multi-agent write-ups. As far as I could find, nobody enforces it, and nobody names the owner in the denial. That gap is why seisin exists.

## One sentence to tell these apart

**OpenShell, hazmat and nono isolate the agent from your machine. seisin separates roles from
each other inside one repository, and when the kernel denies something it names the owner.**

Those are different problems and the first one is not the one this solves. If what you want
is "this agent cannot touch anything outside its sandbox", they do that and OpenShell does it
with a large organisation behind it. If what you want is "four agents work in the same
repository and none of them edits another's files, and when one is denied it is told whose
those files are", nothing above answers that, which is why this exists.

They compose rather than compete: the agent seisin confines could be running inside one of
them.

*About placement, not quality: OpenShell was [evaluated here on 2026-09-27](https://github.com/carlostapiacl/seisin/blob/main/docs/openshell.md), through its Docker driver on
an Intel Mac. That confines an agent inside Docker Desktop's Linux VM; seisin confines a
process on the host through Seatbelt. OpenShell also offers other drivers, including a local
microVM path on supported Apple Silicon Macs. These are kernel-enforced boundaries, but not
the same kernel or workspace, and which one you want depends on what you are protecting.*


## Why not a container

A container is *more* isolation than this. If what you need is to run something you do not trust at all, run it
in a VM: [Kaiden](https://openkaiden.ai), [Containarium](https://containarium.dev)
and a growing shelf of others do that well, and this does not try to.

They answer **"can this process reach the host?"** seisin answers a different
question:

```
container / microVM        one box, one boundary, everything inside it is equal
seisin                     one repo, several roles, and a boundary between them
```

Put two agents in one container and they are back where they started: the same
files, the same keys, no answer to *whose is it*. That question is not about
isolation strength at all; it is about ownership, and it is the one thing an
operating system cannot know for you.

Which is also why this is thin. Enforcement is the sandbox (by default
[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime))
asking the kernel; seisin is the layer that decides what to ask for and says
whose file it was when the answer is no. The two compose; put seisin inside a
container if you want both, and the roles still hold.

| | what it answers |
|---|---|
| VM / microVM | can this reach the host |
| container | can this reach the host, cheaply |
| **seisin** | **whose file is this, and may this role change it** |

