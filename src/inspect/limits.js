/**
 * What the tool cannot do at all — as opposed to `warnings`, which are things
 * wrong with *this* config.
 *
 * Kept apart on purpose. A limit printed as a warning reads as something a
 * person could fix, and after the third run it reads as nothing at all.
 *
 * They used to close `check --verbose`, six paragraphs under every repo's
 * findings, identical in each one — so the part of the output about *this*
 * repo was the part nobody reached. `check` now names how many there are and
 * where to read them: `seisin help limits` (help.js prints this list).
 * `inspect()` still returns them, so the MCP hands them out with the map.
 */
export const LIMITS = [
  ...(process.platform === "darwin" ? [] : [{
    kind: "kernel-denials-unreadable",
    headline: "denials by the kernel are not recorded on this platform",
    detail:
      "on macOS `seisin run` reads them out of the system log, so a denial the hook never " +
      "saw still lands in `seisin log` with its owner and still queues a request. There is no " +
      "equivalent to read here — bubblewrap does not log denials, and the runtime's substitute " +
      "is not reachable from outside it. The boundary holds exactly as well; what you lose is " +
      "seeing it work. Run `seisin wire` so the hook records what it can. The ask is upstream: " +
      "github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md",
  }]),
  {
    kind: "keys-only-what-you-declared",
    headline: "key isolation covers the directory you declared, and nothing else",
    detail:
      "a credential sitting in the repo outside [keys] dir is ordinary readable " +
      "content to every role. Run `seisin scan` to find them — check does not, " +
      "because reading the whole tree on every invocation is how a command stops " +
      "being run.",
  },
  {
    kind: "observe-cannot-see-the-network",
    headline: "`--observe` opens the filesystem, never the network",
    detail:
      "so it cannot tell you which domains an agent needs. The runtime does record every " +
      "denial the proxy makes — host, port and reason — but only a caller that embeds the " +
      "library can read them; nothing reaches a caller that runs the binary, which is what " +
      "seisin does. So for an agent whose endpoints are not published, the options are to " +
      "find them another way or drop the network restriction for it. The ask is upstream: " +
      "github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md",
  },
  ...(process.platform === "linux" ? [{
    kind: "control-files-linux",
    headline: "a project's hooks and settings are protected only where they already exist",
    detail:
      "bubblewrap denies a path by mounting over it, and for a path that is not there it would " +
      "create it on your disk. So on Linux a role can still create a .git/hooks entry or a " +
      ".claude/settings.json in a project of its territory that had none. On macOS the kernel " +
      "denies creating them too.",
  }] : []),
  {
    kind: "shared-scratch",
    headline: "roles share ~/.cache, ~/.local/share and the temp dir unless isolate = \"home\"",
    detail:
      "programs installed there that are on your PATH are protected, and so are Claude Code's " +
      "settings and plugins. Anything else a program outside the sandbox reads from those places — a " +
      "cache it executes, a tool not on PATH — is writable by every role. isolate = \"home\" " +
      "gives each role its own.",
  },
  {
    kind: "agent-sign-in",
    headline: "~/.claude goes only to runs of claude, ~/.codex only to runs of codex",
    detail:
      "seisin reads the agent off the command after `--`, and a run is denied the other " +
      "agents' sign-in files (~/.codex/auth.json, ~/.claude/.credentials.json). What a run " +
      "of an agent can still read is its own: Codex and every command Codex runs share one " +
      "sandbox, so with a ChatGPT sign-in kept in ~/.codex/auth.json they can read those tokens. " +
      "Codex keeps them in the keychain instead with cli_auth_credentials_store = \"keyring\" " +
      "in its config. A wrapper script is not followed: `seisin run <role> --agent codex -- ./script` " +
      "names it. The protected paths `seisin check --verbose` lists are for every agent at once, " +
      "because a role can be run as any of them.",
  },
  {
    kind: "unlink-uncovered",
    headline: "a role can delete inside its own territory",
    detail:
      // The path that used to be here ships with the repo and not with the npm
      // package, so for most readers it named a file they do not have.
      "writes and deletes are one permission to the kernel, so `rm` inside a " +
      "role's own folders succeeds. Closing it needs denyUnlink in the sandbox " +
      "runtime: github.com/carlostapiacl/seisin#how-it-holds",
  },
];
