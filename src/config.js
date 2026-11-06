/**
 * Reads and validates seisin.toml (or a JSON policy): the shape, every role's
 * fields, the sandbox and key providers. The TOML subset is in toml.js.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { CONFIG_NAME } from "./layout.js";
import { parseKey, MODES, checkNames, BUILTIN, unknownMode } from "./keys.js";
import { readNotify } from "./notify-config.js";
import { FORBIDDEN, dict, isTable, own, LINES, parseToml } from "./toml.js";
import { expandVars } from "./vars.js";

export { own, parseToml, closesArray, stripComment } from "./toml.js";
import {
  closest, readBoolean, ROLE_KEYS, readControlFiles, readProtect, readMcp, readBrowsers, readLocalPorts, readInjectHosts, readNeverWrites, readPrivate, checkPrivateOverlap, assertNotAbsolute, readAddresses, asArray, trimSlashes, beforeGlob,
} from "./config-fields.js";
export { closest, ROLE_KEYS, CONTROL_FAMILIES, privateDir } from "./config-fields.js";



export { CONFIG_NAME } from "./layout.js";

/** Walk up from `from` until a seisin.toml shows up. Returns its path or null. */
export function findConfig(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}


/**
 * `[runtime] isolate` — one setting, two levels, because they were one and
 * should not have been.
 *
 *   false          (default) the role reads your home like any process you run
 *   "credentials"  the places credentials live go dark. HOME is untouched
 *   "home" / true  the above, plus a HOME, TMPDIR and XDG set of the role's own
 *
 * **Why the middle one exists.** These were a single switch, and the half that
 * is worth having was welded to the half that breaks things. Measured on macOS:
 * with a home of its own, `claude -p` answers `Not logged in - please run
 * /login`, and the cause is not this sandbox at all. Claude Code keeps its
 * credential in the macOS Keychain, the login keychain lives at
 * `$HOME/Library/Keychains`, and moving HOME points that at a keychain which
 * does not exist. `HOME=/empty claude -p` reproduces it with no sandbox in
 * sight, so the same would happen to any tool that relocates a home.
 *
 * Meanwhile the part people actually want - `~/.ssh`, `~/.aws`, `~/.npmrc` and
 * `~/.config/gh/hosts.yml` closed to every role - never needed a new HOME at
 * all. Measured, with HOME left alone: all four refused, and the agent starts.
 *
 * So the levels split along what each one costs. `"credentials"` is adoptable
 * on a machine you are already working on; `"home"` is the stronger claim and
 * keeps its honest price. `true` still means what it meant, so a config written
 * before this reads the same.
 *
 * Rejected: linking the real keychain into the isolated home to get the best of
 * both. Measured against a throwaway keychain - a confined role reads **every**
 * item in it, including one added without `-A`, because a macOS ACL is per
 * application and `security` is the application. That trades one hole for a
 * larger one: the login keychain is every password you have.
 */
/** `[runtime] read`: "all" (default) or "territory". An unknown value is refused, never read as "all". */
export function readReadMode(v, path = "seisin.toml") {
  if (v === undefined || v === "all") return "all";
  if (v === "territory") return "territory";
  throw new Error(
    `${path}: runtime.read must be "all" or "territory", not ${JSON.stringify(v)}. ` +
    `An unknown value cannot silently leave every file readable.`);
}

/**
 * `reads` and `toolchain`: paths, absolute, `~/…`, or relative to the repo.
 *
 * Same rule as `writes`, for the same reason: the sandbox opens a path and
 * everything under it, so a literal path or a `dir/**` subtree is all that can
 * be said. `docs/*.md` would have to be widened to `docs` or frozen to today's
 * files; either way the policy would say something the kernel does not.
 */
function readReadList(v, at) {
  const list = v === undefined ? [] : asArray(v, at);
  for (const p of list) {
    const above = p.endsWith("/**") ? p.slice(0, -3) : p;
    if (/[*?[\]{}]/.test(above) || p === "**")
      throw new Error(
        `${at} = "${p}" cannot be enforced as written.\n` +
        `  A read grant is a path and everything under it. Write "${beforeGlob(above) || "."}/**" ` +
        `for the subtree, or name the paths.`);
  }
  return list;
}

export function readIsolate(v) {
  if (v === true || v === "home") return "home";
  if (v === "credentials") return "credentials";
  if (v === false || v === undefined) return false;
  throw new Error(
    `runtime.isolate must be false, true, "credentials", or "home", not ${JSON.stringify(v)}. ` +
    `An unknown value cannot silently turn credential isolation off.`);
}

/**
 * A hash of the policy file as it is now, short: it names a version, it proves
 * nothing. Every log line carries the one its run started with (intake.js), and
 * every handoff decision the one it was made against (requests.js, queueOf).
 */
export function policyId(config) {
  try {
    return createHash("sha256").update(readFileSync(config.path)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * Turns the parsed file into the shape the rest of the program uses, and
 * rejects anything ambiguous.
 *
 * Rejecting is the point. The sandbox runtime refuses to start on an invalid
 * settings file rather than falling back to a permissive default, and seisin
 * matches that: a permission tool that guesses is worse than no permission tool.
 */
export function loadConfig(path, text = readFileSync(path, "utf8"), { root = null } = {}) {
  // `text` lets a caller validate an edit before writing it — the console
  // previews a policy that does not exist on disk yet, against the real root.
  const parsed = String(path).endsWith(".json") ? parseJsonPolicy(text, path) : parseToml(text);
  checkShape(parsed, SHAPE, "", path, LINES.get(parsed));
  // `--var`: what a role names and this process was given. What nobody gave is
  // left out here, and `check` says so; `seisin run` refuses it (narrow.js).
  const unbound = expandVars(parsed);
  // Read only what the file actually declared. The parser refuses the names
  // that make inheritance possible, and this is the second half of the same
  // rule: if one of them ever gets through, a role still cannot pick up a
  // setting it never wrote down. Two independent stops, because the failure
  // they prevent is invisible in review — the config reads one way and the
  // policy is another.
  const roles = own(parsed, "roles") ?? {};
  // `roles = "x"` or `roles = [...]` at the root, or `[roles]` with `a = true`,
  // would read as roles named "0", "1" or "a" with no settings of their own —
  // and a role with nothing set gets the global defaults.
  if (!isTable(roles))
    throw new Error(`${path}: "roles" must be tables — [roles.<name>] — not ${JSON.stringify(roles)}`);
  for (const [name, r] of Object.entries(roles))
    if (!isTable(r))
      throw new Error(
        `${path}: roles.${name} = ${JSON.stringify(r)} — a role is a table, [roles.${name}], ` +
        `with its settings under it.`);

  /**
   * A role is a leaf. `[roles.a.b]` is a typo, with certainty.
   *
   * In TOML the dot separates keys, so `[roles.mimo-v2.5-free-1]` declares a
   * role called `mimo-v2` with a nested table inside it. `check` printed a list
   * of plausible-looking names and said nothing; the failure arrived later as
   * `unknown role "mimo-v2.5-free-1"`. Fifteen of eighteen runs on somebody's
   * bench died on it, and the surviving three were the model names with no dots
   * in them.
   *
   * There is almost no ambiguity to preserve here — a nested table under
   * [roles] has one meaning in this tool, `inject_hosts`, and any other is an
   * error that names both what was written and what it became.
   */
  for (const name of Object.keys(roles)) {
    const r = own(roles, name);
    const nested = Object.keys(r ?? {})
      .filter((k) => k !== "inject_hosts" && r[k] && typeof r[k] === "object" && !Array.isArray(r[k]));
    if (nested.length)
      throw new Error(
        `${path}: [roles.${name}.${nested[0]}] — a dot separates keys in TOML, so this ` +
        `declares a role called "${name}", not "${name}.${nested[0]}".\n` +
        `  Role names cannot contain dots. Use "${name}-${nested[0]}".`);
  }
  const names = Object.keys(roles);
  if (names.length === 0) throw new Error(`${path}: no [roles.<name>] sections found`);
  // Case-colliding names would share a HOME under `isolate = "home"` on a
  // case-insensitive disk (APFS), so `dev` and `Dev` would read each other's
  // secrets while `check` said nothing. Refuse the ambiguity at load.
  {
    const byLower = new Map();
    for (const n of names) {
      const k = n.toLowerCase();
      if (byLower.has(k))
        throw new Error(`${path}: roles "${byLower.get(k)}" and "${n}" differ only in case. ` +
          `On a case-insensitive disk they would share an isolated HOME. Rename one.`);
      byLower.set(k, n);
    }
  }

  // One directory or several. Several is the common case once a repo has more
  // than one kind of secret, and making people flatten them to satisfy the tool
  // is how a tool gets kept out.
  const keyDir = own(own(parsed, "keys"), "dir");
  // `.secrets/` and `.secrets` are one directory, and every consumer compares
  // them as prefixes: with the slash kept, `scan` walked into the protected
  // directory and a bare key resolved to `.secrets//x`, which matched nothing.
  const keyDirs = (keyDir === undefined ? [] : asArray(keyDir, "keys.dir"))
    .map((d) => trimSlashes(d) || d);
  const keyProviders = readProviders(own(own(parsed, "keys"), "providers"), path);
  // `undefined` means "use the defaults"; an explicit empty array means "none".
  // The difference matters: one is a user who has not thought about it, the
  // other is a user who has.
  const runtime = own(parsed, "runtime");
  const runtimeWrites = own(runtime, "writes");

  const out = {
    // The root is the policy's folder, unless the policy was read from elsewhere
    // (`--policy`): then it is the folder the command runs in, and the policy
    // stays outside the repo it governs.
    root: root ? resolve(root) : dirname(path), path, keyDirs, keyProviders, unbound,
    // Through asArray like every other list: `allow = "github.com"` was kept as
    // a string, and a string iterated is its characters.
    allowedDomains: asArray(own(own(parsed, "network"), "allow"), "network.allow"),
    // `[network] deny_addresses` — where an allowed name may not lead. An allowed
    // domain whose DNS somebody else controls can be pointed at a host on your
    // LAN; the runtime denies loopback, link-local and metadata addresses by
    // itself and leaves private ranges to the policy, because an intranet name
    // is a legitimate thing to allow. Checked here, with the line, rather than
    // by the sandbox at start.
    deniedAddresses: readAddresses(own(own(parsed, "network"), "deny_addresses"), `${path}: network.deny_addresses`),
    runtimeWrites: runtimeWrites === undefined ? undefined : asArray(runtimeWrites, "runtime.writes"),
    // `[runtime] isolate` — how much of your home a role stops reaching. See
    // srt-settings.js for what each level emits, and readIsolate() below for why there
    // are two of them.
    isolate: readIsolate(own(runtime, "isolate")),
    // `[runtime] read` — what a role may read. "all" is every file but the ones
    // denied by name; "territory" denies the places data lives and re-opens
    // only what the role needs. See territory.js.
    read: readReadMode(own(runtime, "read"), path),
    redact: readBoolean(own(runtime, "redact"), `${path}: runtime.redact`),
    scanIgnore: asArray(own(own(parsed, "scan"), "ignore"), "scan.ignore"),
    protect: readProtect(own(parsed, "protect"), path),
    console: readConsole(own(parsed, "console"), path),
    roles: {},
  };

  for (const name of names) {
    const r = own(roles, name);
    const writes = assertNotAbsolute(asArray(own(r, "writes"), `${path}: roles.${name}.writes`), `${path}: roles.${name}.writes`);
    const keys = asArray(own(r, "keys"), `roles.${name}.keys`);
    // Read once, here, so every consumer sees the same answer about what an
    // entry is. `keys` itself stays the array of strings that was written: it
    // is what `render`, `serve` and `init` print, and the whole point of a
    // reference is that the written form is the reviewable one.
    const keyEntries = keys.map((k) => {
      try {
        return parseKey(k);
      } catch (e) {
        throw new Error(`${path}: roles.${name}: ${e.message}`);
      }
    });
    // Only a path needs somewhere to live. A reference does not, and demanding
    // `[keys] dir` from a config whose secrets are all in a vault would be the
    // tool insisting on the arrangement it was built for.
    if (keyEntries.some((k) => k.kind === "file") && keyDirs.length === 0)
      throw new Error(`${path}: roles.${name} lists keys, but [keys] dir is not set`);
    /**
     * An unknown scheme is refused, not ignored.
     *
     * Same rule as everywhere else here: a `keys = ["vault://x"]` with no
     * `[keys.providers.vault]` is a configuration error, and the alternative —
     * treating it as a filename, or as a key that quietly never arrives — is a
     * policy that reads as protecting something it is not.
     */
    for (const k of keyEntries) {
      // `file://` ships with seisin, so it needs no declaration. It is the one
      // builtin, and the reason is in keys.js: a secret in a plain file is the
      // case this exists for, and making that case declare a provider that
      // runs `cat` is a papercut on the only path most people take.
      if (k.kind !== "ref" || BUILTIN.has(k.scheme) || own(keyProviders, k.scheme)) continue;
      const known = Object.keys(keyProviders);
      throw new Error(
        `${path}: roles.${name}: key "${k.raw}" uses the "${k.scheme}" scheme, and no ` +
        `[keys.providers.${k.scheme}] is declared.\n` +
        `  ${known.length ? `Declared providers: ${known.join(", ")}.` : "No providers are declared."}\n` +
        `  A provider is a command with a placeholder:\n` +
        `    [keys.providers.${k.scheme}]\n` +
        `    command = ["your-cli", "read", "{ref}"]`);
    }
    checkNames({ name, keyEntries });
    const keyMode = own(r, "key_mode");
    if (keyMode !== undefined && !MODES.includes(keyMode))
      throw unknownMode(`${path}: roles.${name}:`, "key_mode", keyMode);
    const injectHosts = readInjectHosts(own(r, "inject_hosts"), `${path}: roles.${name}.inject_hosts`);
    const neverWrites = readNeverWrites(own(r, "never_writes"), `${path}: roles.${name}.never_writes`);
    const localBinding = own(r, "local_binding");
    const trustd = own(r, "trustd");
    if (trustd !== undefined && typeof trustd !== "boolean")
      throw new Error(`${path}: roles.${name}.trustd must be true or false, not ${JSON.stringify(trustd)}`);
    if (localBinding !== undefined && typeof localBinding !== "boolean")
      throw new Error(`${path}: roles.${name}.local_binding must be true or false, not ${JSON.stringify(localBinding)}`);
    const handoff = own(r, "handoff");
    if (handoff !== undefined && typeof handoff !== "boolean")
      throw new Error(`${path}: roles.${name}.handoff must be true or false, not ${JSON.stringify(handoff)}`);
    const localPorts = readLocalPorts(own(r, "local_ports"), `${path}: roles.${name}.local_ports`);
    const browsers = readBrowsers(own(r, "browsers"), `${path}: roles.${name}.browsers`);
    const mcp = readMcp(own(r, "mcp"), `${path}: roles.${name}.mcp`);
    const controlFiles = readControlFiles(own(r, "control_files"), `${path}: roles.${name}.control_files`);
    const reads = readReadList(own(r, "reads"), `${path}: roles.${name}.reads`);
    const toolchain = readReadList(own(r, "toolchain"), `${path}: roles.${name}.toolchain`);
    const priv = readPrivate(own(r, "private"), `${path}: roles.${name}.private`);
    const verify = own(r, "verify") === undefined ? null : asArray(own(r, "verify"), `roles.${name}.verify`);
    /**
     * `handoff_exempt`: folders where the trust-handoff set is not protected, for a
     * setup phase that fills a dependency tree whose packages ship their own
     * `.gitattributes`, `.github/` or `.git/` (`composer install`, measured: 326
     * denials). Relative to the repo, no `..`, no globs. Only a sandbox that can
     * open exactly that (tartaros) is handed the role.
     */
    const handoffExempt = own(r, "handoff_exempt") === undefined ? [] : asArray(own(r, "handoff_exempt"), `roles.${name}.handoff_exempt`);
    /**
     * `requests`: the only requests the role may send to an allowed host,
     * `"METHODS host[/path]"` (METHODS: `GET,POST` or `*`). An allowed host is
     * otherwise all of it: a token for api.github.com pushes to any repository
     * it reaches. The host must be in `network`. Only tartaros enforces it
     * (from 0.1.0-alpha.18): it terminates that host and refuses anything else.
     */
    const requests = own(r, "requests") === undefined ? [] : asArray(own(r, "requests"), `roles.${name}.requests`).map((spec) => {
      const m = /^(\*|[A-Z]+(?:,[A-Z]+)*)\s+([A-Za-z0-9.-]+)(\/\S*)?$/.exec(String(spec).trim());
      if (!m || (m[3] ?? "").split("/").some((seg) => seg === "." || seg === ".."))
        throw new Error(`${path}: roles.${name}.requests "${spec}": "METHODS host[/path]", e.g. "GET api.github.com" or "POST,PATCH api.github.com/repos/acme/"`);
      return { host: m[2], methods: m[1] === "*" ? [] : m[1].split(","), paths: m[3] ? [m[3]] : [] };
    });
    // A rule narrows a host the role may reach; on a host it may not, it says nothing.
    const reach = own(r, "network") === undefined ? [] : asArray(own(r, "network"), `roles.${name}.network`);
    for (const q of requests) {
      const covered = reach.some((h) => h === q.host || (h.startsWith("*.") && q.host.endsWith(h.slice(1))));
      if (!covered)
        throw new Error(`${path}: roles.${name}.requests: ${q.host} is not in roles.${name}.network, so the role cannot reach it at all`);
    }
    for (const e of handoffExempt)
      if (e.startsWith("/") || e.startsWith("~") || e.split("/").includes("..") || /[*?[\]]/.test(e) || !e.trim())
        throw new Error(`${path}: roles.${name}.handoff_exempt "${e}": a folder in the repo, relative, with no ".." and no globs`);
    if (verify && verify.length === 0)
      throw new Error(`${path}: roles.${name}.verify is empty. It is the command that proves the role can check ` +
        `its own work — ["python", "-m", "pytest", "--version"] — or leave it out.`);
    out.roles[name] = {
      name,
      /**
       * `writes` is what is GRANTED; `writesDeclared` is what was written.
       *
       * Expanded here and not at emit time, because two answers is how the
       * document ends up looser or tighter than the boundary. Everything
       * downstream — `ownersOf`, `explain`, `whose`, the settings, the console
       * — reads `writes`, so the owner of a database is the owner of its `-wal`
       * everywhere, and the kernel and the sentence agree. The declared form is
       * kept so that regenerating a config writes back what a person typed
       * rather than the expansion.
       */
      writes: withSidecars([...new Set([...writes, ...priv])]),
      writesDeclared: writes,
      /**
       * Folders only this role reads and writes. Each is also part of its
       * territory (added to `writes` above, so `explain`, `whose` and the
       * settings agree it is this role's), and every OTHER role is given a
       * denyRead and a denyWrite on it — in either read mode, isolated or not.
       * Deny-only: an allow nested in a deny breaks on one platform or the
       * other unless it is handled the way territory.js handles its own.
       */
      private: priv,
      keys,
      keyEntries,
      keyMode: keyMode ?? null,
      injectHosts,
      env: asArray(own(r, "env"), `roles.${name}.env`),
      network: own(r, "network") === undefined ? null : asArray(own(r, "network"), `roles.${name}.network`),
      /**
       * What this role may never write, even inside its own `writes`.
       *
       * A subtraction, and the only one the format has. It exists for the case
       * a territory glob cannot say: `repo/**` minus `repo/.git/index.lock`, for
       * a role that works in a worktree and has its own index. Without it the
       * alternative is enumerating every top-level entry of the repo but `.git`
       * — a list that goes stale the day somebody adds a directory.
       *
       * Per role and never global: a global deny on `.git/index.lock` breaks
       * every role that legitimately commits in the shared checkout. Absent
       * means exactly what it meant before the key existed.
       */
      // Sidecars too: `data/app.sqlite` minus its `-wal` is not a subtraction.
      // A fabricated -wal is applied to the database the next time it opens.
      neverWrites: withSidecars(neverWrites),
      neverWritesDeclared: neverWrites,
      /**
       * Whether this role may listen on a local port — a dev server, the
       * backend an end-to-end test drives, a test database.
       *
       * Off unless the role says so, and per role because most roles never
       * start a server: an agent that edits docs has no business accepting
       * connections. Wider than the name: the runtime also lets the role listen
       * on every interface and connect to every localhost port. See `check`.
       */
      localBinding: localBinding === true,
      /**
       * The ports on this machine the role may connect to, and no others.
       *
       * The narrow form of reaching a local service. `local_binding` opens
       * every port on localhost (macOS), which includes whatever control API
       * is listening there without a password. This names the ports instead,
       * and the runtime's proxy enforces the list — the same allowlist the
       * domains go through. See srt-settings.js for what that costs: the client has to
       * go through the proxy, which HTTP clients do and a MySQL driver does not.
       */
      localPorts,
      /**
       * The headless browsers this role may start (browsers.js): the Mach
       * services each needs, by name, and nothing else. `[]` unless the role
       * says so — every other role keeps the profile as it was.
       */
      browsers,
      /**
       * The MCP servers this role may load, by name, or null when the policy
       * does not say. `[]` is "none". seisin declares this and does not
       * enforce it: MCP servers are started by the agent's CLI, so the launcher
       * builds the CLI's MCP config from this list (Claude Code:
       * `--mcp-config` with only these + `--strict-mcp-config`).
       */
      mcp,
      /**
       * Whether this role may reach com.apple.trustd.agent (macOS). Needed by
       * Dart/Flutter and by Go built before 1.27 to verify TLS at all; Go 1.27+
       * does without it through the SSL_CERT_FILE that env.js sets. Off unless
       * the role says so. See srt-settings.js for what it costs.
       */
      trustd: trustd === true,
      /**
       * The families of control files this role may edit inside its own
       * territory: "ide" (`.vscode/`, `.cursor/`, `.windsurf/`) and
       * "instructions" (`CLAUDE.md`, `AGENTS.md`…). surface.js says what each
       * is and why only these two can be handed out. Absent is none.
       */
      controlFiles,
      /**
       * Whether this role takes work handed to it (handoff.js). True unless the
       * role says `handoff = false`: a role that is a pipeline phase rather
       * than a worker — it prepares the tree, it is not someone to pass a
       * file to — still owns its territory, and a write denied there goes to
       * another owner or to a person instead of starting it.
       */
      handoff: handoff !== false,
      /** Folders, relative to the root, where trust-handoff is not protected (tartaros only). */
      handoffExempt,
      /** The only requests to an allowed host: `{ host, methods, paths }` (tartaros only). */
      requests,
      /**
       * What this role reads beyond its repo, under `read = "territory"`.
       *
       * `reads` is data — a sibling checkout, a shared docs folder. `toolchain`
       * is what runs — a venv, `~/.nvm`, `~/.cargo` — kept apart because `check`
       * treats the two differently: a toolchain that does not exist is the
       * reason a role cannot verify itself, and that is worth a finding. Both
       * are read grants and nothing else; neither is ever writable. Ignored
       * (and said so by `check`) under `read = "all"`, where everything is
       * readable already.
       */
      reads,
      toolchain,
      /**
       * The command that proves this role can check its own work, run by
       * `seisin check --verify` inside the role's sandbox. Measured in
       * an agent orchestrator (2026-10-09): an agent asked to verify with nothing to verify
       * with cost 80% more per task and verified nothing; the same agent with
       * its toolchain ran the suite every time at the original cost.
       */
      verify,
      // Kept so `check` can name a misspelt key instead of ignoring it. An
      // unknown key in a role table used to be dropped silently, and for a
      // subtraction that is failing open: `never_write` would read as a rule
      // and subtract nothing.
      unknownKeys: Object.keys(r).filter((k) => !ROLE_KEYS.includes(k)),
    };
  }
  checkPrivateOverlap(out.roles, path);
  out.sandbox = readSandbox(own(parsed, "sandbox"), path);
  out.notify = readNotify(own(parsed, "notify"), { path, root: out.root, keyDirs, roles: out.roles, own });
  return out;
}

/**
 * `[keys.providers.<name>]` — the commands that turn a reference into a value.
 *
 * Validated here and not at resolution time, because the whole argument for
 * references is that a broken policy should be visible in `seisin check`,
 * without asking anybody's keychain for a password to find out.
 *
 * `{ref}` is required. A command without it resolves every reference to the
 * same thing, which is the kind of mistake that looks like it works: the first
 * key comes back, so does the second, and they are both the first one.
 */
function readProviders(table, path) {
  const out = Object.create(null);
  if (table === undefined) return out;
  for (const name of Object.keys(table)) {
    const p = own(table, name);
    // Redefining `file://` is refused rather than honoured. Two configs where
    // the same scheme means different things is the failure this whole feature
    // is supposed to remove — and it would be invisible, because the policy
    // reads identically in both.
    if (BUILTIN.has(name))
      throw new Error(
        `${path}: [keys.providers.${name}] — "${name}://" is built in and cannot be redefined.\n` +
        `  It reads a file, optionally one KEY out of it: "file://.secrets/all.env#TOKEN".\n` +
        `  For different behaviour, give your provider another name.`);
    const command = own(p, "command");
    if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string"))
      throw new Error(
        `${path}: [keys.providers.${name}] needs a command, as an array of strings.\n` +
        `  e.g. command = ["security", "find-generic-password", "-w", "-s", "{ref}"]`);
    if (!command.some((c) => c.includes("{ref}")))
      throw new Error(
        `${path}: [keys.providers.${name}] has no {ref} in its command, so every key of this ` +
        `provider would resolve to the same value.\n` +
        `  Put {ref} where the reference goes: command = [${command.map((c) => `"${c}"`).join(", ")}, "{ref}"]`);
    const mode = own(p, "mode");
    if (mode !== undefined && !MODES.includes(mode))
      throw unknownMode(`${path}: [keys.providers.${name}]`, "mode", mode);
    out[name] = { name, command, mode: mode ?? null };
  }
  return out;
}

/** The sandboxes seisin ships (sandboxes/index.js). Named here too, so config.js imports no runtime code. */
const BUILTIN_SANDBOXES = ["srt", "tartaros"];

/**
 * `[sandbox]`: which sandbox enforces the roles, and any declared by command.
 *
 * `provider` is one name or a list in order of preference; absent, it is
 * `["tartaros", "srt"]` (DEFAULT_PROVIDERS; `srt` alone before 0.7). A name is one seisin ships or one declared under
 * `[sandbox.providers.<name>]` — an unknown one is refused here, never read as
 * the default, because "the config asks for tartaros and the run used srt"
 * without a word is the silent substitution sandboxes/index.js exists to stop.
 */
function readSandbox(table, path) {
  if (table === undefined) return null;
  const providers = Object.create(null);
  const declared = own(table, "providers");
  for (const name of declared === undefined ? [] : Object.keys(declared)) {
    if (BUILTIN_SANDBOXES.includes(name))
      throw new Error(`${path}: [sandbox.providers.${name}] — "${name}" is built in and cannot be redefined. ` +
        `Give your provider another name.`);
    const command = own(own(declared, name), "command");
    if (!Array.isArray(command) || command.length === 0 || command.some((c) => typeof c !== "string" || c === ""))
      throw new Error(`${path}: [sandbox.providers.${name}] needs a command, as an array of strings:\n` +
        `  command = ["mybox", "run", "--policy", "{policy}", "--"]`);
    if (!command.slice(1).some((c) => c.includes("{policy}")))
      throw new Error(`${path}: [sandbox.providers.${name}] has no {policy} in its command, so the sandbox would never ` +
        `see the policy it is meant to enforce.\n  Put {policy} where the settings file goes: ` +
        `command = [${[...command, "{policy}"].map((c) => `"${c}"`).join(", ")}]`);
    // Optional: asks the sandbox, before anything runs, whether it can hold a
    // policy. Exit 0 is yes; anything else is no, and the last line it prints says why.
    // Without it a declared sandbox is only ever found out by the canary, so a
    // list like ["mybox", "srt"] would stop at exit 86 instead of moving on.
    const check = own(own(declared, name), "check");
    if (check !== undefined) {
      if (!Array.isArray(check) || check.length === 0 || check.some((c) => typeof c !== "string" || c === ""))
        throw new Error(`${path}: [sandbox.providers.${name}] check must be a command, as an array of strings:\n` +
          `  check = ["mybox", "check", "--policy", "{policy}"]`);
      if (!check.slice(1).some((c) => c.includes("{policy}")))
        throw new Error(`${path}: [sandbox.providers.${name}] has no {policy} in its check, so it would answer ` +
          `without seeing the policy it is asked about.\n  Put {policy} where the settings file goes: ` +
          `check = [${[...check, "{policy}"].map((c) => `"${c}"`).join(", ")}]`);
    }
    // Declared, because it cannot be detected: its Seatbelt denials carry
    // sandbox-runtime's tag, so the kernel's refusals under it can be recorded.
    const tags = own(own(declared, name), "tags_denials");
    if (tags !== undefined && typeof tags !== "boolean")
      throw new Error(`${path}: [sandbox.providers.${name}] tags_denials is true or false, not ${JSON.stringify(tags)}.`);
    providers[name] = { name, command, check: check ?? null, tagsDenials: tags ?? false };
  }
  const raw = own(table, "provider");
  if (raw === undefined)
    return { provider: null, providers };
  const names = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string"))
    throw new Error(`${path}: sandbox.provider = ${JSON.stringify(raw)} — a name, or a list of names in order of preference: ` +
      `provider = ["tartaros", "srt"]`);
  for (const n of names) {
    if (BUILTIN_SANDBOXES.includes(n) || providers[n]) continue;
    const known = [...BUILTIN_SANDBOXES, ...Object.keys(providers)];
    const near = closest(n, known);
    throw new Error(`${path}: sandbox.provider names "${n}", which is not a sandbox seisin knows` +
      `${near ? ` — did you mean "${near}"?` : "."}\n  Built in: ${BUILTIN_SANDBOXES.join(", ")}. ` +
      `Any other is declared with a command: [sandbox.providers.${n}] command = ["…", "{policy}"].`);
  }
  if (new Set(names).size !== names.length)
    throw new Error(`${path}: sandbox.provider lists a sandbox twice (${JSON.stringify(names)}).`);
  return { provider: names, providers };
}

/**
 * A SQLite database is four files, and a policy should say it once.
 *
 * `data/x/app.sqlite` is not the database — it is one of the files the
 * database is made of. Writing to it in WAL mode also writes `-wal` and
 * `-shm`; in rollback mode, `-journal`. So "this role writes this database"
 * takes four lines, and a policy with eight databases and thirty-one roles
 * takes nine hundred and ninety-two of them. Measured on a real one: 744 of
 * 1,248 write lines — 60% — were sidecars, and every single one had its
 * `.sqlite` declared beside it. Not one case wanted the `-wal` without the
 * database.
 *
 * **This grants no authority that was not already there**, which is the whole
 * reason it is safe to do implicitly. The `-wal` holds that database's pending
 * transactions: whoever can write the database can already empty it, replace
 * it, or corrupt it. The sidecar is not a second resource — it is the same one.
 *
 * It is also not a glob. The kernel grants a path and everything under it, so
 * `app.sqlite*` is unenforceable and `seisin check` refuses it; these are
 * emitted as literal paths, exactly as if they had been typed.
 *
 * **The suffix list is closed on purpose** and this is the line that keeps the
 * idea from becoming the exception list it could be: three suffixes, and only
 * after a name that says SQLite. `.db` is deliberately not in it — plenty of
 * things are called `.db` and a grant to create `whatever.db-wal` inside a
 * directory somebody else owns would be new authority, arriving quietly. A
 * database with another name declares its sidecars by hand, as before.
 */
const SIDECARS = ["-wal", "-shm", "-journal"];
const IS_SQLITE = /\.sqlite3?$/;

export function withSidecars(paths) {
  const out = [];
  for (const p of paths) {
    out.push(p);
    if (IS_SQLITE.test(p)) for (const s of SIDECARS) out.push(p + s);
  }
  // A policy written before this existed already lists them. Keeping the first
  // occurrence keeps the order somebody chose.
  return [...new Set(out)];
}

/**
 * Every table and key a policy may have outside `[roles.*]`. `true` is a value,
 * an object is a table, and `*` stands for any name (a provider's).
 *
 * Anything else is refused at load, with its line. The roles table reports an
 * unknown key through `check` because a role's typo is usually one extra
 * grant; here the settings are global, and the one that made this necessary
 * was `isolaet = true` under [runtime] — read as nothing, so isolation stayed
 * off for every role and nothing on screen said so. The same "fail open by
 * typo" that was closed for roles, closed harder because it covers them all.
 */
/**
 * `[console]`: what `seisin ui` opens beside the policy. `runs` is a directory
 * of runs, relative to this file. `launcher` names who lends the territory:
 * then nothing is granted from the console, and it says to ask there.
 */
function readConsole(table, path) {
  if (table === undefined) return {};
  const out = {};
  for (const k of ["runs", "launcher"]) {
    const v = own(table, k);
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim()) throw new Error(`${path}: console.${k} must be a non-empty string, not ${JSON.stringify(v)}.`);
    out[k] = v;
  }
  if (out.runs) out.runs = resolve(dirname(resolve(path)), expandHome(out.runs));
  return out;
}

const expandHome = (p) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const SHAPE = {
  roles: null,                            // validated where roles are read
  keys: { dir: true, providers: { "*": { command: true, mode: true } } },
  network: { allow: true, deny_addresses: true },
  runtime: { writes: true, isolate: true, redact: true, read: true },
  console: { runs: true, launcher: true },
  scan: { ignore: true },
  protect: { instructions: true },
  notify: { url: true, url_file: true, format: true },
  sandbox: { provider: true, providers: { "*": { command: true, check: true, tags_denials: true } } },
};

function checkShape(table, shape, prefix, path, lines) {
  const known = Object.keys(shape).filter((k) => k !== "*");
  for (const key of Object.keys(table)) {
    const name = prefix ? `${prefix}.${key}` : key;
    const at = `${path}:${lines?.get(name) ?? "?"}`;
    const rule = Object.prototype.hasOwnProperty.call(shape, key) ? shape[key] : shape["*"];
    if (rule === undefined) {
      const near = closest(key, known);
      throw new Error(
        `${at}: ${prefix ? `[${prefix}] ` : ""}"${key}" is not a setting` +
        `${prefix ? "" : " or a table"} seisin knows${near ? ` — did you mean "${near}"?` : "."}\n` +
        `  Known${prefix ? ` in [${prefix}]` : " at the top level"}: ${known.join(", ")}. ` +
        `An unknown name is refused rather than ignored: ignored, a misspelt setting ` +
        `reads as a rule and does nothing.`);
    }
    if (rule === null) continue;
    const value = table[key];
    if (rule === true && isTable(value))
      throw new Error(`${at}: [${name}] is a table, but ${name} is a setting — write ${key} = … under [${prefix}].`);
    if (typeof rule === "object" && !isTable(value))
      throw new Error(`${at}: ${name} = ${JSON.stringify(value)} — ${name} is a table, [${name}], with its settings under it.`);
    if (typeof rule === "object") checkShape(value, rule, name, path, lines);
  }
}

/**
 * A policy written as JSON (`--policy run.json`), for a launcher that generates
 * one: JSON can hold a quote in a value, which the TOML subset cannot, and a
 * program writing the policy should not have to avoid them.
 *
 * The same data and the same strictness as the TOML reader: tables, strings,
 * whole numbers, booleans, and arrays of strings or whole numbers, nothing
 * else; the forbidden names refused; every table with a null prototype; and a
 * key written twice in one object refused, because JSON.parse keeps the last
 * one, and a policy that is restrictive at the top and cancelled further down
 * is exactly what the TOML reader refuses too. A JSON policy is not edited by
 * `grant`: it is generated, so it is changed where it is generated.
 */
export function parseJsonPolicy(text, path = "policy.json") {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${path}: not JSON — ${e.message}`); }
  // Duplicate keys, which JSON.parse folds away: one pass over the text, which
  // JSON.parse has just said is well formed.
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") stack.push({ obj: true, keys: new Set(), key: true });
    else if (c === "[") stack.push({ obj: false });
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack.at(-1)?.obj) stack.at(-1).key = true;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top?.obj && top.key) {
        const k = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(k)) throw new Error(`${path}: "${k}" is written twice in one object; the last would silently win.`);
        top.keys.add(k);
        top.key = false;
      }
      i = j;
    }
  }
  const walk = (v, name) => {
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isInteger(v) || v < 0) throw new Error(`${path}: ${name} = ${v} — only whole numbers`);
      return v;
    }
    if (Array.isArray(v)) {
      return v.map((x, i) => {
        if (typeof x === "string" || (typeof x === "number" && Number.isInteger(x) && x >= 0)) return x;
        throw new Error(`${path}: ${name}[${i}] — array items are strings or whole numbers`);
      });
    }
    if (isTable(v)) {
      const t = dict();
      for (const [k, x] of Object.entries(v)) {
        if (FORBIDDEN.has(k)) throw new Error(`${path}: "${k}" is not a name a table or key may have`);
        t[k] = walk(x, name ? `${name}.${k}` : k);
      }
      return t;
    }
    throw new Error(`${path}: ${name} = ${JSON.stringify(v)} — a value is a string, a whole number, a boolean, an array or a table`);
  };
  if (!isTable(raw)) throw new Error(`${path}: the policy is an object`);
  return walk(raw, "");
}
