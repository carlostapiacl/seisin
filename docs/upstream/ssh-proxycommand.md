# Upstream ask · the wired `ProxyCommand` cannot authenticate to the proxy it points at

Issue for [anthropics/sandbox-runtime][repo]. Kept here because seisin's README
tells users SSH does not work, and a documented gap should say whose it is and
what is being asked.

Verified against **0.0.76** (installed) and **0.0.77** (current) on 2026-09-21.
Every command below was run.

[repo]: https://github.com/anthropics/sandbox-runtime

> **Status · already tracked upstream — do not file.** Checked 2026-09-23:
> [PR #516][516] (opened 2026-09-04 by another contributor, open, not merged)
> fixes exactly this — Apple's `nc` has no SOCKS5 authentication, so the wired
> `ProxyCommand` dies at the handshake since the proxy started minting a token —
> and it cites the two reports it came from, anthropics/claude-code#70684 and
> #82255. The draft below stays as the measurement behind seisin's README line;
> if anything is worth doing upstream it is a +1 on that PR, not a third issue.

[516]: https://github.com/anthropics/sandbox-runtime/pull/516

[545]: https://github.com/anthropics/sandbox-runtime/issues/545
[582]: https://github.com/anthropics/sandbox-runtime/issues/582

---

## The issue, as drafted

> **Title:** `network`: the `GIT_SSH_COMMAND` the sandbox sets points at a helper that cannot authenticate to the SOCKS proxy

````markdown
## Summary

The sandbox sets, for every confined command:

```
GIT_SSH_COMMAND=ssh -o ControlMaster=no -o ControlPath=none \
                    -o ProxyCommand='nc -X 5 -x localhost:${socksProxyPort} %h %p'
```

The SOCKS proxy it points at requires SOCKS5 username/password authentication,
and `nc -X 5` cannot send any. The library already knows this — from
`socks-proxy.d.ts`:

> *"Consulted for a client that cannot authenticate (it offered no
> username/password method — e.g. BSD `nc -X 5`, the stock macOS ssh
> ProxyCommand). Such a connection is NEVER tunnelled."*

So the variable is set to a command that is documented, in the same package, as
one the proxy will never tunnel. The result is not a clean refusal: `git` over
SSH connects, negotiates, and dies mid-handshake.

## Reproduce

A policy allowing `github.com`, and a command run under `srt`:

```
$ curl -s -o /dev/null -w '%{http_code}' https://github.com
200

$ ssh -o BatchMode=yes -T git@github.com
ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known

$ git ls-remote git@github.com:<any>/<repo>.git HEAD
ssh_dispatch_run_fatal: Connection to UNKNOWN port 65535: Broken pipe
fatal: could not read from remote repository
```

The three are three different states and the difference is the point. HTTP(S)
goes through the HTTP proxy and works. Bare `ssh` never looks at a proxy, so it
fails at DNS — expected. `git` picks up `GIT_SSH_COMMAND`, finds the SOCKS
proxy, and fails at authentication, which is the one that looks like a bug in
the user's network rather than a configuration the library chose.

Measured on macOS 15 (Darwin 24.6.0), 0.0.76; the same `ProxyCommand` string
and the same `NEVER tunnelled` note are present in 0.0.77.

## Ask

Any one of these, smallest first:

- **Do not set `GIT_SSH_COMMAND`** when the helper cannot authenticate. A clean
  "cannot resolve" is a better failure than a broken pipe: the user reaches for
  an HTTPS remote instead of debugging their SSH agent.
- **Point it at a helper that can authenticate** where one is available —
  `ncat --proxy … --proxy-type socks5 --proxy-auth user:pass` speaks the
  protocol the proxy already requires. Neither `ncat` nor `socat` ships with
  macOS, so this needs a check rather than an assumption.
- **Or accept unauthenticated loopback for destinations that are already
  allowed.** This is the weakest of the three and probably wrong: the
  authentication exists so a denial can be attributed to the command that
  caused it, which is worth more than SSH.

## Notes

- Not asking for SSH support as a feature. The transport is already there — the
  SOCKS proxy filters by `(port, host)`, so port 22 to an allowed host is the
  shape it supports. The gap is one link in a chain the library wires itself.
- A caller that runs the binary cannot work around this: the environment is
  handed to the child by the library, and overriding `GIT_SSH_COMMAND` from
  outside means guessing the port, which is chosen per run.
````

---

## Longer rationale · not part of the issue

**Why the third option is listed and argued against in the same breath.** The
authentication is not incidental. The SOCKS username carries an encoded command
so that a refusal can be attributed to the invocation that caused it — the same
property the [violations ask](cli-violations.md) is about. Trading that away to
make `ssh` work would fix the smaller problem by damaging the larger one, and an
ask that does not say so invites the maintainer to take the easy road.

**Why this is worth filing at all, given git over HTTPS exists.** Because the
failure is dishonest, not because SSH is essential. A user with a `git@` remote
sees a broken pipe and starts debugging keys, agents and known-hosts. The
library put that `ProxyCommand` there; the library knows the helper cannot
authenticate; nothing tells the user. That is the same class as
[the violations ask](cli-violations.md) — the library holds information the
caller needs and does not pass it on.

**On filing a third ask while two are unanswered.** `#545` has had no reply
since 2026-09-13 and `#582` was filed on 2026-09-20 partly because nobody
checked whether waiting was the plan. Three open asks from one author, in ten
days, against a repository that has answered none of them, starts to read as
volume rather than signal. The argument for filing anyway is that this one is
cheap to act on and the reproducer is three lines. **The decision is Carlos's
and it is not made yet** — what is done is that the text is ready and verified,
so filing costs a command rather than an afternoon.
