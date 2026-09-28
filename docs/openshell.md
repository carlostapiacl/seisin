# OpenShell compatibility

> Evaluated against OpenShell `0.0.116` on 2026-09-27. OpenShell `0.1.0`–`0.1.2`
> shipped in the days around that run; the measurements below were not repeated
> against them. The filesystem schema was re-read on 2026-09-28 at `0.1.2` and has
> not changed in the way that decides this page (see below). This is a
> compatibility decision, not a security audit of OpenShell.

## Recommendation

Use OpenShell when the desired boundary is a separate Linux workspace with
controlled egress, brokered credentials and explicit port forwarding. Do not
use it as a drop-in backend for `seisin run` today.

OpenShell is not simply “Docker”. Its gateway can place sandboxes on Docker,
Podman, Kubernetes or a microVM driver. With Docker it runs the workload in a
Linux container; on supported Apple Silicon Macs its local path can use a Linux
microVM. On the Intel Mac used for this evaluation, native OpenShell is not
supported, so the executable path was the official Docker driver in Docker
Desktop's Linux VM.

## Why it did not become a backend

seisin's filesystem contract contains subtraction:

```text
role territory
  minus never_writes
  minus seisin.toml and .seisin/
  minus Git and agent control files
```

It also denies a key directory and reopens only the exact keys a role declares.
The current OpenShell filesystem schema is an allowlist of `read_only` and
`read_write` paths enforced with Landlock. Landlock grants are additive. If a
parent directory is read-write, declaring a child read-only does not remove the
write grant inherited from the parent. That limitation was raised in
[issue #698](https://github.com/NVIDIA/OpenShell/issues/698), and closed as not
planned on 2026-04-01: the maintainers treat it as a Landlock invariant working
as intended and suggest inverting the layout (a read-only parent with writable
children listed one by one). At `0.1.2` the filesystem schema is still
`read_only` and `read_write` only; the `deny_rules` it now has apply to network
endpoints, not to paths. So this is not a gap waiting on a fix — it is the
design.

That means translating a role with `writes = ["**"]` would make protected files
writable, while translating the protected files honestly would require
enumerating every other path in the repo and rebuilding the sandbox whenever
the tree changes. Neither is the same boundary. seisin refuses translations
that widen authority, so the backend fails closed.

There is a second architectural difference: an OpenShell sandbox owns its own
Linux workspace. Local content is uploaded and results must be synchronized
back. A server binds inside that sandbox and is exposed with `--forward`; it is
not the same as allowing a host process to bind a port. This is useful, but it
is an execution target rather than a transparent replacement for the current
host-process runtime.

## What passed, what did not

| Capability | Result |
|---|---|
| pinned CLI, gateway and supervisor `0.0.116` | verified (not repeated on `0.1.x`) |
| Docker/Linux gateway API and sandbox allocation | verified |
| policy delivery to the supervisor | verified |
| domain/binary/L7 network policy | supported by the schema; not exercised end to end here |
| brokered providers/secrets | supported by OpenShell; not exercised with real credentials |
| explicit port forwarding | supported by OpenShell; different lifecycle from `local_ports` |
| child exception inside writable parent | **cannot be represented safely** |
| protected seisin/Git files inside a writable repo | **cannot be represented safely** |
| selective key access under a broadly readable repo | **cannot be represented safely** |
| workload on this Docker Desktop gateway | provisioning failed with `ContainerExited` after policy load |
| Apple Silicon microVM | not run; this host is Intel |

The provisioning failure reproduced with both the community base image and a
minimal controlled Alpine image, and with both a custom policy and OpenShell's
default. It appears separate from the policy-model incompatibility: repairing
it would not make the unsafe filesystem translation exact.

## A future integration that would be honest

A future `seisin target openshell` could deliberately adopt the remote-workspace
model. It would need to exclude policy, audit, Git metadata and secrets from the
uploaded tree; materialize writable territory without parent grants; define
how changes return to the host; map denials back to owners; and test Docker,
Linux-native and Apple Silicon microVM paths independently.

Until those conditions hold, OpenShell belongs in the alternatives section,
not behind the same `seisin run` promise.

Primary references, from the repository's own docs (the docs.nvidia.com pages
this cited on 2026-09-27 no longer resolve):
[policy schema](https://github.com/NVIDIA/OpenShell/blob/main/docs/how-it-works/policies/schema.mdx),
[compute drivers](https://github.com/NVIDIA/OpenShell/blob/main/docs/extensibility/drivers.mdx),
[support matrix](https://github.com/NVIDIA/OpenShell/blob/main/docs/about/support-matrix.mdx).
