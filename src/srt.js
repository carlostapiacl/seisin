/**
 * Turns one role into a settings file for @anthropic-ai/sandbox-runtime.
 *
 * The schema is not guessed: it was read off the installed package and checked
 * against the real binary. Two things it taught us, both load-bearing here:
 *
 *   1. `network` and `filesystem` are top level. They are NOT nested under a
 *      `sandbox` key — that shape belongs to Claude Code's settings.json, which
 *      is a different file with a similar vocabulary. Mixing them up produces a
 *      config that parses as empty and denies everything.
 *   2. Every field is required. Leaving out `network.deniedDomains` or
 *      `filesystem.denyWrite` makes the runtime refuse to start rather than fall
 *      back to its defaults. Emitting the whole object removes that class of
 *      error, which is most of what this file is for.
 */
import { join, dirname } from "node:path";
import { STATE_DIR, CONFIG_NAME } from "./layout.js";
import { entriesOf } from "./keys.js";
import { enforcedNeverWrites } from "./owners.js";
import { realAncestor } from "./paths.js";
import { denyFor } from "./surface.js";
import { runsRootOf } from "./rundir.js";
import { FIFO_SUFFIX } from "./spool.js";
import {
  SOCKET_MAX, isLink, realOrSelf, expand, homeFits, roleHome, roleHomeRoot,
  CREDENTIAL_HOMES, toWritePath, writePathsOf,
} from "./grants.js";

// Re-exported: these were srt.js's exports before grants.js existed, and
// callers (the CLI, the tests, anyone embedding seisin) import them from here.
export {
  expand, homeFits, roleHome, roleHomeRoot, CREDENTIAL_HOMES, RUNTIME_WRITES,
} from "./grants.js";


/** Reads are denied wholesale under the key directory, then re-allowed one file at a time. */
/**
 * The settings one role gets.
 *
 * `spool` is the path of the parent's audit socket, when a parent is holding
 * one. It is granted by path so the hook can report what it decided without
 * the repo's state directory being writable from inside — see spool.js. With
 * no parent there is nothing to grant and nothing to reach.
 */
/**
 * `local_ports`, as the allowlist entries that let the proxy dial them.
 *
 * Why the proxy and not the kernel. The kernel profile has exactly two answers
 * for loopback: nothing, or `localhost:*` (`allowLocalBinding`), and the runtime
 * exposes no third. The proxy is the one component that sees a destination
 * port, and it already takes `host:port` entries. It refuses loopback unless
 * the literal and port are listed, which is the property this relies on: 9000
 * stays refused when 8001 is open. Measured, 2026-09-23: curl, Node's fetch
 * and Python's urllib reach a listed port and get "Connection blocked by
 * network allowlist" on an unlisted one.
 *
 * All three spellings, because a client says whichever it says.
 */
export function localPortDomains(ports = []) {
  return (ports ?? []).flatMap((p) => [`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`]);
}

/**
 * What the runtime puts in NO_PROXY, minus loopback.
 *
 * The runtime always exempts localhost from the proxy, so a client talks to
 * 127.0.0.1:8001 directly — and the kernel, which has no port list, refuses
 * it. For a role with `local_ports` the exemption is taken back, so loopback
 * goes through the proxy, where the port list is. Only for those roles: for
 * every other role loopback is refused either way and nothing changes.
 *
 * Kept in step with sandbox-utils.js of the pinned runtime by a test.
 */
export const NO_PROXY_WITHOUT_LOOPBACK = "169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

/**
 * The command a role runs, with loopback routed through the proxy when it
 * has `local_ports`.
 *
 * An `env` in front and not a variable in the environment seisin passes: the
 * runtime sets NO_PROXY itself, after seisin's environment, so the only place
 * that wins is inside the box. Clients that ignore HTTP_PROXY — a MySQL driver,
 * Chromium, which exempts loopback on its own — still get refused. They need
 * to be pointed at the proxy, or the port needs `local_binding`, which opens
 * every port.
 */
export function loopbackVia(role, cmd) {
  if (!role?.localPorts?.length) return cmd;
  return ["env", `NO_PROXY=${NO_PROXY_WITHOUT_LOOPBACK}`, `no_proxy=${NO_PROXY_WITHOUT_LOOPBACK}`, ...cmd];
}

export function settingsFor(config, roleName, spool = null, observe = false) {
  const role = config.roles[roleName];
  if (!role) throw new Error(`unknown role "${roleName}". Known: ${Object.keys(config.roles).join(", ")}`);

  const abs = (p) => (p.startsWith("/") ? p : join(config.root, p));
  // "credentials" closes the places credentials live; "home" does that and
  // gives the role a home of its own. Only the second one needs a new HOME,
  // and only the second one signs every CLI in the box out. See config.js.
  //
  // `true` is normalised here as well as in the config reader, because a caller
  // embedding the library builds this object itself and `isolate: true` has
  // meant "home" since before there was a second level.
  const level = config.isolate === true ? "home" : config.isolate;
  const shielded = level === "credentials" || level === "home";
  const isolated = level === "home";

  /**
   * Refuse before the runtime does, because the runtime's refusal says nothing.
   *
   * With an isolated home too deep for the socket the runtime puts inside it,
   * `srt` dies on `listen EINVAL: invalid argument` and a path — no role, no
   * mention of `isolate`, nothing a reader could act on. This is the same
   * failure seisin already documents in spool.js, reached from the other side.
   */
  if (isolated) {
    const room = homeFits(config, roleName);
    if (room < 0)
      throw new Error(
        `\`isolate = true\` cannot hold role "${roleName}" here: its home leaves ` +
        `${-room} byte(s) too little for the runtime's socket, and a unix socket path ` +
        `is capped near ${SOCKET_MAX} bytes.\n` +
        `  Shorten the role name, or run with a shorter TMPDIR.`,
      );
  }

  const home = isolated ? roleHome(config, roleName) : null;
  const denyRead = [];
  const allowRead = [];

  // Every declared directory is denied, then each key the role names is
  // re-allowed. A key written without a directory resolves against the first
  // one, which keeps the ordinary single-directory config short.
  const dirs = config.keyDirs ?? [];
  for (const dir of dirs) {
    // A key *file* that is a symlink is refused below. The directory itself is
    // the same hole one level up: denyRead names the path as written, and the
    // runtime enforces on the destination — so `.secrets -> /tmp/elsewhere`
    // gives a deny that covers nothing and an allow that reaches out of the
    // repo. Refused rather than resolved, because a key directory that is not
    // where it says it is has nothing to gain from being clever about.
    const here = abs(dir);
    // lstat on the directory itself, not a comparison of resolved paths: on
    // macOS /var is a link to /private/var, so a repo under a temp directory
    // would fail this check for an ancestor it does not control.
    if (isLink(here))
      throw new Error(
        `[keys] dir "${dir}" is a symlink to ${realOrSelf(here)}.\n` +
        `  The sandbox enforces on the destination, so the deny would not cover what the ` +
        `allow reaches. Point [keys] dir at the real location instead.`);
    denyRead.push(here);
  }

  /**
   * Isolated mode also narrows what a role may READ, which the ordinary mode
   * does not touch at all.
   *
   * By default the model is "read anything except the declared key
   * directories", and that is a real limit worth saying out loud: `~/.ssh`,
   * `~/.aws`, `~/.npmrc`, `~/.config/gh/hosts.yml` and `~/.kube/config` are all
   * ordinary readable files to every role unless they happen to sit under a
   * key directory. For agents you run yourself that is a reasonable trade —
   * they need to read the machine to work. For anything you would not trust,
   * it is the whole game.
   *
   * These are denies rather than an allowlist on purpose. A default-deny read
   * set has to enumerate every library, interpreter and cache a toolchain
   * touches, gets one wrong, and fails as an unexplainable crash inside the
   * agent. Naming the places credentials actually live is narrower than the
   * ideal and it is a boundary that holds up in practice.
   */
  if (shielded) denyRead.push(...CREDENTIAL_HOMES.map(expand));

  /**
   * `~/.claude` and `~/.codex` are closed only at the `home` level, and the
   * difference is the whole reason the two levels exist.
   *
   * They hold a session, so closing them is right when each role is meant to be
   * a separate identity. But on macOS the agent's credential is not in there at
   * all — it is in the login keychain, reached through `$HOME`. At the
   * `credentials` level HOME is untouched, so the agent stays logged in and
   * every role shares that one session, exactly as they already do today.
   * Closing these two here would cost the session without buying the
   * separation, which is the worst of both.
   */
  if (isolated) {
    denyRead.push(...["~/.claude", "~/.codex"].map(expand));
    // And the other roles' homes. Giving each role its own HOME closed writing
    // between them and left reading wide open — so `a` could read the session
    // token `b`'s CLI had just written. Worse, the audit page said this was
    // closed, because the only thing measured was the write.
    //
    // Same shape as the key directories: deny the parent, allow your own.
    denyRead.push(realOrSelf(roleHomeRoot(config)));
    allowRead.push(realOrSelf(home));
  }
  /**
   * Only a key that IS a file becomes a read grant.
   *
   * A reference has no path, so there is nothing here to allow: it is resolved
   * by the parent before the sandbox starts and handed over as an environment
   * variable or as a scratch file. See keys.js. Filtering here rather than
   * upstream keeps the two kinds from having to know about each other — the
   * settings this function emits are still, entirely, about the filesystem.
   */
  for (const entry of entriesOf(role).filter((e) => e.kind === "file")) {
    const key = entry.raw;
    const path = key.includes("/") ? abs(key) : abs(join(dirs[0] ?? ".", key));
    // A key has to live in a declared key directory. Without this check a
    // slash in the name made the path relative to the repo root instead, so
    // `keys = ["../.ssh/id_rsa"]` re-opened a read outside `.secrets` — which
    // is a read grant written in the one list nobody reads twice, because
    // everything in it is supposed to be a key.
    // Resolved, not compared as text. The sandbox enforces on the destination
    // of a symlink — the same property that made a `/tmp` grant grant nothing —
    // so `.secrets/github-token.txt -> ~/.ssh/id_rsa` is a read grant on the
    // ssh key, written in the one list nobody audits twice. Measured: the read
    // succeeded through the link and through the real path.
    const real = realOrSelf(path);
    const inside = dirs.some((d) => {
      const root = realOrSelf(abs(d));
      return real === root || real.startsWith(root.endsWith("/") ? root : root + "/");
    });
    if (!inside)
      throw new Error(
        `keys = "${key}" for role ${role.name} resolves to ${real}, outside every [keys] dir ` +
        `(${dirs.join(", ") || "none declared"}).\n` +
        `${real === path ? "" : `  (it is a symlink: ${path} → ${real})\n`}` +
        `  A key must live in a declared key directory. To use another location, declare it: ` +
        `[keys] dir = ["${dirs[0] ?? ".secrets"}", "<the other one>"].`
      );
    allowRead.push(path);
  }

  /**
   * Other runs' directories are unreadable; this run's is readable.
   *
   * Every run keeps its socket and `scratch` keys under one root (rundir.js),
   * and every role runs as the same user, so the directory mode protects
   * nothing between roles. Measured: one role read another's scratch key while
   * both ran. Same shape as the key directories: deny the parent, allow your own.
   */
  const runs = runsRootOf(spool);
  const isFifo = spool?.endsWith(FIFO_SUFFIX) === true;
  if (runs) {
    denyRead.push(runs);
    allowRead.push(dirname(spool));
  }

  return {
    network: {
      // `local_ports` rides the same allowlist as the domains: the runtime's
      // proxy is the one place that sees the destination PORT. See loopbackVia.
      // Without ports the value is passed through untouched, `undefined` included: that
      // is how a config with no network list has always read, and a spread would throw.
      allowedDomains: role.localPorts?.length
        ? [...(role.network ?? config.allowedDomains ?? []), ...localPortDomains(role.localPorts)]
        : role.network ?? config.allowedDomains,
      deniedDomains: [],
      // Exactly one socket: the parent's audit spool, when there is a parent.
      // Granted by path, not by turning unix sockets on.
      allowUnixSockets: spool && !isFifo ? [spool] : [],
      // Per role, `local_binding = true`. Off by default: listening is a
      // capability, and most roles never need it.
      allowLocalBinding: role.localBinding === true,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite: [
        // Observing means the kernel stops refusing, because otherwise there is
        // nothing to observe. `--observe` used to relax only the hook, so the
        // sandbox denied the write anyway and the banner said "nothing denied"
        // over a transcript of denials — and `init --from-observations` builds
        // a policy out of that transcript. It would read "the agent needs
        // nothing outside its territory", which is the opposite of the truth.
        //
        // The repo, and only the repo. Everything in denyWrite below still
        // holds: the config, the state directory and the key directories stay
        // shut even here, because observing is not a reason to hand over the
        // paperwork of the confinement.
        // One function answers "what may this role write" for the settings and
        // for surface.js, which needs the union over every role. Two copies of
        // that arithmetic would be two answers the day one of them changes.
        ...writePathsOf(config, role, { observe }),
        ...(isFifo ? [spool] : []),
      ],
      /**
       * The confinement's own paperwork, never writable — not even by a role
       * that was granted the whole repo.
       *
       * `writes = ["**"]` is a reasonable thing to write for a solo agent, and
       * it used to hand that agent its own policy file: rewrite seisin.toml,
       * get a wider territory on the next run. Measured against the real
       * kernel, not reasoned about. denyWrite wins over allowWrite in the
       * profile, so this holds however wide the territory gets.
       *
       * The key directories are already unreachable through denyRead — the
       * runtime turns a read-denied path into an unlink/create denial too — but
       * they are named here as well, because relying on that coupling is
       * relying on someone else's implementation detail staying put.
       */
      denyWrite: [
        /**
         * The role's own subtractions, `never_writes`.
         *
         * Here and not as a hole cut out of allowWrite, because the profile
         * cannot cut holes: it grants prefixes and denies prefixes, and a deny
         * wins over any grant however wide. That is the property the key is
         * built on, and the same one the entries below rely on.
         */
        ...enforcedNeverWrites(config, role)
          .map((g) => abs(toWritePath(g, "never_writes")))
          // Both spellings: the one written and the one the kernel will meet.
          // With a symlink on the way (`app/data -> store`) the write lands on
          // `store/…`, and a deny on the written path alone let it through —
          // measured by the review of 2026-09-22 (rc=0, file created).
          .flatMap((p) => { const r = realAncestor(p); return r === p ? [p] : [p, r]; }),
        /**
         * Everything the parent reads or executes, and every file that tells a
         * program outside the box what to run — the policy, `.seisin/`, the key
         * directories, the key providers, `file://` targets, programs on PATH
         * installed where a role writes, and each project's hooks and settings.
         * One list with a reason per entry, built in surface.js, which says why
         * each member of the family is on it. `seisin check` prints it.
         */
        ...denyFor(config, role, { observe }).map((e) => e.path),
        // The audit socket, and the directory holding it. Denying only the
        // socket left `mv /tmp/seisin-xxxx /tmp/gone` as a way to take the
        // channel out without ever touching the file that was protected.
        // Connecting is `network-outbound` and both of those are
        // `file-write-unlink`, so denying them leaves the first working.
        // And the root all runs live under, so no role can put a symlink where
        // the next run will write its settings and keys.
        // A FIFO channel (Linux) is written, so it is granted below and only
        // its directory is denied here: the role writes lines into it and can
        // neither remove it nor put anything beside it (measured in Docker).
        ...(spool ? [...(isFifo ? [] : [spool]), dirname(spool), ...(runs ? [runs] : [])] : []),
      ],
    },
    /**
     * `trustd = true`: the one Mach service TLS needs on macOS for tools that
     * verify through the Security framework — Go before 1.27 (gh, kubectl,
     * terraform) and every Dart/Flutter. The runtime ships it as
     * `enableWeakerNetworkIsolation` and warns it is an exfiltration path:
     * trustd fetches, outside the box, the URLs a certificate carries. Per role
     * and off by default, so the answer is written next to the role that needs it.
     */
    ...(role.trustd === true ? { enableWeakerNetworkIsolation: true } : {}),
  };
}

/**
 * The provider executables that live at a path, absolute.
 *
 * A command with no separator (`security`, `op`, `gpg`) is resolved by the OS
 * from PATH and is deliberately left alone: denying "wherever gpg happens to
 * be" would mean writing a rule about a machine rather than about a repo.
 */
export function providerPaths(config) {
  const out = [];
  for (const p of Object.values(config.keyProviders ?? {})) {
    const cmd = p.command?.[0];
    if (!cmd || !cmd.includes("/")) continue;
    out.push(cmd.startsWith("/") ? cmd : join(config.root ?? ".", cmd));
  }
  return [...new Set(out)];
}

