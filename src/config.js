/**
 * Reads and validates seisin.toml.
 *
 * The parser covers a deliberate subset of TOML: `[table.name]` headers, and
 * `key = ["a", "b"]` / `key = "a"` values. That is the whole config language,
 * and keeping it in-house is why installing seisin pulls in exactly one
 * dependency (the sandbox runtime) instead of a parser too.
 *
 * If your config outgrows this subset, the config is doing too much.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { isIP } from "node:net";
import { CONFIG_NAME } from "./layout.js";
import { parseKey, MODES, checkNames, BUILTIN, unknownMode } from "./keys.js";
import { readNotify } from "./notify.js";
import { BROWSERS } from "./browsers.js";

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

const RE_TABLE = /^\[([A-Za-z0-9_.\-]+)\]$/;
const RE_PAIR = /^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/;

/**
 * Names a table or key may not have.
 *
 * `[roles.__proto__]` does not show up in `Object.keys(roles)`, so `check`
 * prints the roles that exist and says nothing — while every other role
 * inherits whatever it declared. A config reading `[roles.frontend]` with no
 * `writes` came out of the parser owning the entire repo and holding
 * GITHUB_TOKEN, and no amount of reading the file would show it.
 *
 * The tables below are made with a null prototype, which stops the inheritance
 * on its own. The names are refused as well, because a config containing them
 * is not a config with a mistake in it.
 */
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** A table with no prototype, so nothing is inherited into it. */
function dict() {
  return Object.create(null);
}

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Read a property only if the object actually has it. */
export function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Where each table and key of a parsed file was written, by dotted name.
 *
 * Kept beside the result rather than in it, so the object stays exactly the
 * data that was written; loadConfig reads it to put a line number on a name it
 * does not know.
 */
const LINES = new WeakMap();

/** Minimal TOML subset -> plain object. Throws with a line number on bad input. */
export function parseToml(text) {
  const out = dict();
  const where = new Map();
  LINES.set(out, where);
  let table = out;
  let tableName = "";
  // "Last one wins" is TOML-ish and wrong for a permission file. A policy can
  // look restrictive at the top and be cancelled forty lines down, and the
  // person reviewing it reads the first block. Both shapes are refused.
  const seenTables = new Set();
  const seenKeys = new Set();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    const header = RE_TABLE.exec(line);
    if (header) {
      tableName = header[1];
      for (const part of tableName.split("."))
        if (FORBIDDEN.has(part))
          throw new Error(
            `${CONFIG_NAME}:${i + 1}: "[${tableName}]" uses the reserved name "${part}". ` +
            `A table named that would not appear as a role and would hand its settings to ` +
            `every other one.`);
      if (seenTables.has(tableName))
        throw new Error(
          `${CONFIG_NAME}:${i + 1}: [${tableName}] appears twice. ` +
          `A later table would silently override the earlier one — put every setting for ` +
          `${tableName} in one place.`);
      seenTables.add(tableName);
      tableName.split(".").forEach((_, k, parts) => {
        const name = parts.slice(0, k + 1).join(".");
        if (!where.has(name)) where.set(name, i + 1);
      });
      table = tableName.split(".").reduce((node, key, k, parts) => {
        if (!Object.prototype.hasOwnProperty.call(node, key)) node[key] = dict();
        else if (!isTable(node[key]))
          throw new Error(
            `${CONFIG_NAME}:${i + 1}: [${tableName}] — "${parts.slice(0, k + 1).join(".")}" is already ` +
            `a value, not a table. One name cannot be both.`);
        return node[key];
      }, out);
      continue;
    }

    const pair = RE_PAIR.exec(line);
    if (!pair) throw new Error(`${CONFIG_NAME}:${i + 1}: cannot read "${raw.trim()}"`);

    let [, key, value] = pair;
    const at = i + 1;
    // An array may span lines; keep pulling until the brackets balance. Only
    // the new line is searched: searching the whole growing value made an
    // unclosed array of 100k lines take 20 s to be refused. A `]` inside a
    // quoted item does not close it — `["a]b",` used to end the array there.
    if (value.startsWith("[") && !closesArray(value)) {
      const parts = [value];
      let closed = false;
      while (!closed && i + 1 < lines.length) {
        const next = stripComment(lines[++i]).trim();
        parts.push(next);
        closed = closesArray(next);
      }
      value = parts.join(" ");
    }
    if (FORBIDDEN.has(key))
      throw new Error(`${CONFIG_NAME}:${i + 1}: "${key}" is a reserved name and cannot be a setting.`);
    const seen = `${tableName}.${key}`;
    if (seenKeys.has(seen))
      throw new Error(
        `${CONFIG_NAME}:${i + 1}: "${key}" is set twice in [${tableName || "the root"}]. ` +
        `The second would win, which is not a thing a permission file should do quietly.`);
    seenKeys.add(seen);
    where.set(tableName ? `${tableName}.${key}` : key, at);
    /**
     * A key may not be a table that is declared elsewhere, in either order.
     *
     * `[roles.a]` with `network = []`, then `[roles]` and `a = true` forty lines
     * down, used to replace the whole role with `true`: its `network = []` came
     * back as "not set", which means the global allow list. `check` said
     * nothing. It is the "last one wins" this parser refuses everywhere else,
     * arriving by a different spelling.
     */
    if (Object.prototype.hasOwnProperty.call(table, key))
      throw new Error(
        `${CONFIG_NAME}:${i + 1}: "${key}" in [${tableName || "the root"}] is already the table ` +
        `[${tableName ? tableName + "." : ""}${key}]. One name cannot be both — the value would replace ` +
        `everything that table says.`);
    table[key] = readValue(value, i + 1);
  }
  return out;
}

/** Is there a `]` on this line outside a quoted string? Strings do not span lines. */
export function closesArray(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === "]" && !quoted) return true;
  }
  return false;
}

/** Strips a trailing `#` comment, but not one inside a quoted string. */
export function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

/**
 * One value, read strictly.
 *
 * Strict is the whole point, and it was not before. The array reader used to
 * pick quoted runs out of the line with a regex and ignore everything between
 * them, so `["a" GARBAGE "b"]` parsed as `["a","b"]` and an unterminated string
 * parsed as `""`. A permission file that is half-understood is worse than one
 * that is rejected: the half that was dropped is the half you meant.
 *
 * So this scans rather than matches, and anything it does not recognise is an
 * error with a line number. There are no escapes — a `"` ends the string. If a
 * path of yours needs a quote in it, that is outside this subset and the
 * message says so instead of guessing.
 */
function readValue(value, lineNo) {
  const v = value.trim();
  const bad = (msg) => { throw new Error(`${CONFIG_NAME}:${lineNo}: ${msg}`); };

  if (v === "true") return true;
  if (v === "false") return false;

  if (v.startsWith('"')) {
    const end = v.indexOf('"', 1);
    if (end === -1) bad(`unterminated string — no closing quote in ${v}`);
    const rest = v.slice(end + 1).trim();
    if (rest) bad(`unexpected ${JSON.stringify(rest)} after the string`);
    return v.slice(1, end);
  }

  if (v.startsWith("[")) {
    if (!v.endsWith("]")) bad("unterminated array — no closing bracket");
    const items = [];
    let i = 1;
    const body = v.slice(0, -1);          // everything up to the closing bracket
    let expectItem = true;                // a list alternates item, comma, item…

    while (i < body.length) {
      const c = body[i];
      if (c === " " || c === "\t") { i++; continue; }

      if (c === ",") {
        if (expectItem) bad("empty array slot — two commas in a row, or a leading comma");
        expectItem = true; i++; continue;
      }
      if (!expectItem) bad(`missing comma before ${JSON.stringify(body.slice(i, i + 12))}`);
      // Whole numbers, for `local_ports`. Digits only: no sign, no decimal, no
      // underscore — a port is none of those, and every other key still
      // refuses a number through asArray.
      const digits = /^\d+/.exec(body.slice(i));
      if (digits) {
        const after = body[i + digits[0].length];
        if (after !== undefined && after !== "," && after !== " " && after !== "\t")
          bad(`${JSON.stringify(body.slice(i, i + 12))} is not a whole number`);
        items.push(Number(digits[0]));
        i += digits[0].length;
        expectItem = false;
        continue;
      }
      if (c !== '"') bad(`array items must be double-quoted, found ${JSON.stringify(body.slice(i, i + 12))}`);

      const end = body.indexOf('"', i + 1);
      if (end === -1) bad("unterminated string inside the array");
      // A backslash before the closing quote means somebody wrote `\"` and
      // expected an escape. There are none — the quote just ended the string,
      // and the error they get otherwise is about a missing comma somewhere in
      // the middle of a shell pipeline, which names the symptom and hides the
      // cause. Measured while writing the docs: every attempt at a one-line
      // provider command landed here.
      if (body[end - 1] === "\\")
        bad(`there are no escapes in this format, so the \\" in ` +
            `${JSON.stringify(body.slice(i, Math.min(end + 2, i + 40)))} ended the string early.\n` +
            `  A value cannot contain a double quote. If this is a shell command, put it in a ` +
            `script and name the script instead — which is also how it stops being unreadable.`);
      items.push(body.slice(i + 1, end));
      i = end + 1;
      expectItem = false;                 // a trailing comma is fine; a trailing item is not
    }
    return items;
  }

  if (/^\d+$/.test(v)) return Number(v);

  bad("value must be a string, an array of strings, a whole number, or a boolean");
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
        `  A read grant is a path and everything under it. Write "${above.replace(/\/?[^/]*[*?[\]{}].*$/, "") || "."}/**" ` +
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
    .map((d) => d.replace(/\/+$/, "") || d);
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
    root: root ? resolve(root) : dirname(path), path, keyDirs, keyProviders,
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
    // srt.js for what each level emits, and readIsolate() below for why there
    // are two of them.
    isolate: readIsolate(own(runtime, "isolate")),
    // `[runtime] read` — what a role may read. "all" is every file but the ones
    // denied by name; "territory" denies the places data lives and re-opens
    // only what the role needs. See territory.js.
    read: readReadMode(own(runtime, "read"), path),
    redact: readBoolean(own(runtime, "redact"), `${path}: runtime.redact`),
    scanIgnore: asArray(own(own(parsed, "scan"), "ignore"), "scan.ignore"),
    protect: readProtect(own(parsed, "protect"), path),
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
       * domains go through. See srt.js for what that costs: the client has to
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
       * the role says so. See srt.js for what it costs.
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
 * `srt`, as it always was. A name is one seisin ships or one declared under
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
const SHAPE = {
  roles: null,                            // validated where roles are read
  keys: { dir: true, providers: { "*": { command: true, mode: true } } },
  network: { allow: true, deny_addresses: true },
  runtime: { writes: true, isolate: true, redact: true, read: true },
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

/** The candidate within edit distance 3 of `word`, or null. Shared with `check`. */
export function closest(word, candidates) {
  let best = null, bestD = 4;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

/** Levenshtein distance. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** true, false, or absent (undefined). Anything else is a mistake, said as one. */
function readBoolean(value, where) {
  if (value === undefined || typeof value === "boolean") return value;
  throw new Error(`${where} must be true or false, not ${JSON.stringify(value)}`);
}

/** The keys a `[roles.<name>]` table can hold. Anything else is reported by `check`. */
export const ROLE_KEYS = ["writes", "private", "keys", "key_mode", "inject_hosts", "env", "network", "never_writes", "local_binding", "local_ports", "browsers", "mcp", "trustd", "control_files", "reads", "toolchain", "verify", "handoff", "handoff_exempt"];

/**
 * `control_files`: which families of control files a role may edit. Refused at
 * load when it names anything else — `.claude`, git hooks and the rest are not
 * on the list on purpose, and a word the reader does not know must not load as
 * a permission it thinks it wrote.
 */
export const CONTROL_FAMILIES = ["ide", "instructions"];

function readControlFiles(value, where) {
  if (value === undefined) return [];
  const out = [];
  for (const f of asArray(value, where)) {
    if (!CONTROL_FAMILIES.includes(f))
      throw new Error(`${where}: ${JSON.stringify(f)} is not a family of control files. ` +
        `Known: ${CONTROL_FAMILIES.map((x) => JSON.stringify(x)).join(", ")}. ` +
        `The others (.claude, git hooks, .mcp.json, .envrc) are never handed to a role.`);
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * `[protect]` — what is protected beyond the defaults. One key today:
 * `instructions = true` protects `CLAUDE.md`, `AGENTS.md` and their kin from
 * every role that is not handed them. Anything else in the table is refused.
 */
function readProtect(value, path) {
  if (value === undefined) return { instructions: false };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: [protect] must be a table`);
  for (const k of Object.keys(value))
    if (k !== "instructions")
      throw new Error(`${path}: [protect] ${k} is not a setting. Known: instructions.`);
  const v = own(value, "instructions");
  if (v !== undefined && typeof v !== "boolean")
    throw new Error(`${path}: [protect] instructions must be true or false, not ${JSON.stringify(v)}`);
  return { instructions: v === true };
}

/**
 * `mcp`: names of MCP servers, as the CLI's config calls them. Absent is null,
 * not [], so a policy that never mentions MCP changes nothing for a launcher
 * that reads it; `mcp = []` is the explicit "none".
 */
function readMcp(value, where) {
  if (value === undefined) return null;
  const list = asArray(value, where);
  const out = [];
  for (const n of list) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n))
      throw new Error(`${where}: ${JSON.stringify(n)} is not an MCP server name. ` +
        `Use the name from the CLI's config, for example mcp = ["playwright"].`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * `browsers`, refused rather than guessed: a name seisin has no preset for
 * would read as a grant that was made, and grant nothing.
 */
function readBrowsers(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new Error(`${where} is a list of browser names, for example browsers = ["chromium"].`);
  for (const b of value)
    if (!Object.hasOwn(BROWSERS, b)) {
      const near = closest(b, Object.keys(BROWSERS));
      throw new Error(`${where}: "${b}" is not a browser seisin has a preset for${near ? ` — did you mean "${near}"?` : ""} ` +
        `Known: ${Object.keys(BROWSERS).join(", ")}.`);
    }
  return [...new Set(value)];
}

/**
 * `local_ports`, refused rather than guessed when it is not a list of ports.
 *
 * Refused at load for the same reason as `never_writes`: a port list that loads
 * with a typo in it opens a port nobody meant, or silently fails to open the
 * one they did. A string is accepted when it is only digits, because TOML
 * written by hand says `"8001"` as often as `8001`.
 */
function readLocalPorts(value, where) {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const v of list) {
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new Error(`${where}: ${JSON.stringify(v)} is not a port. Write numbers from 1 to 65535, ` +
        `for example local_ports = [8001, 8081].`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * `inject_hosts`: for `key_mode = "inject"`, the hosts each masked credential
 * is substituted into, keyed by the delivered variable name.
 *
 *   [roles.frontend.inject_hosts]
 *   GH_TOKEN = ["api.github.com"]
 *
 * One list per credential and not one for the role, because the runtime gates
 * substitution per credential: credential A's real value reaches only A's
 * hosts, never B's. A host is an exact name — no wildcard — so `check` can say
 * precisely which traffic is intercepted; the match against a wider wildcard in
 * `allowedDomains` is computed later (srt.js), where the terminated set is.
 */
function readInjectHosts(value, where) {
  if (value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`${where}: inject_hosts is a table of VAR = ["host", …], ` +
      `for example [roles.x.inject_hosts] GH_TOKEN = ["api.github.com"].`);
  const out = {};
  for (const [name, hosts] of Object.entries(value)) {
    const list = asArray(hosts, `${where}.${name}`);
    if (list.length === 0)
      throw new Error(`${where}.${name}: a masked credential with no host injects nowhere. ` +
        `List the host its token authenticates to, like ["api.github.com"].`);
    for (const h of list) {
      if (typeof h !== "string" || h.trim() === "")
        throw new Error(`${where}.${name}: every host is a non-empty string`);
      if (h.includes("*"))
        throw new Error(`${where}.${name}: "${h}" is a wildcard. An inject host is an exact name, ` +
          `so check can say which traffic is intercepted. A wildcard in allowedDomains still ` +
          `covers it; that is reported, not declared here.`);
      if (/^https?:\/\//.test(h) || h.includes("/"))
        throw new Error(`${where}.${name}: "${h}" is not a host. Write the bare domain, like "api.github.com".`);
    }
    out[name] = [...new Set(list)];
  }
  return out;
}

/**
 * `never_writes`, refused rather than guessed when it cannot mean what it says.
 *
 * Refused at load, not warned about: this is a list of things a role must not
 * do, and a malformed entry that loads anyway fails open. An absolute path or a
 * `..` would point outside the repo the rest of the policy is written against,
 * so it cannot be the subtraction the person meant.
 */
function readNeverWrites(value, where) {
  const list = asArray(value, where);
  for (const g of list) {
    if (typeof g !== "string" || g.trim() === "")
      throw new Error(`${where}: every entry must be a non-empty string`);
    if (g.startsWith("/"))
      throw new Error(`${where}: "${g}" is absolute. never_writes is relative to the repo root, like writes.`);
    if (g.split("/").includes(".."))
      throw new Error(`${where}: "${g}" contains "..". never_writes names paths inside the repo.`);
  }
  return list;
}

/**
 * `private`: folders inside the repo, written `dir` or `dir/**`.
 *
 * A folder and not a glob, because what is enforced is a deny on one path for
 * every other role: `notes/*.md` would have to be widened to `notes` or frozen
 * to today's files. Not absolute and no `..`, because the denies are given
 * against the repo the policy describes and `explain` answers in it. Not the
 * repo itself: private to one role, the whole repo is shut to all the others,
 * which is a policy of one role written in the long way.
 */
function readPrivate(value, where) {
  const list = value === undefined ? [] : asArray(value, where);
  for (const p of list) {
    const dir = p.replace(/\/\*\*$/, "").replace(/\/+$/, "").replace(/^\.\//, "");
    if (p.startsWith("/"))
      throw new Error(`${where}: "${p}" is absolute. A private folder is relative to the repo root, like writes.`);
    if (dir.split("/").includes(".."))
      throw new Error(`${where}: "${p}" contains "..". A private folder is inside the repo.`);
    if (dir === "" || dir === "." || dir === "**")
      throw new Error(`${where}: "${p}" is the whole repo. A private folder is a folder inside it — ` +
        `"notes/**" — and every other role is denied it.`);
    if (/[*?[\]{}]/.test(dir))
      throw new Error(`${where}: "${p}" is a pattern. A private folder is one path and everything under it: ` +
        `write "${dir.replace(/\/?[^/]*[*?[\]{}].*$/, "") || "dir"}/**".`);
  }
  return list;
}

/** `private` with its `/**` and `./` taken off: the folder itself. */
export const privateDir = (p) => p.replace(/\/\*\*$/, "").replace(/\/+$/, "").replace(/^\.\//, "");

/**
 * One owner per private folder. Two roles naming the same folder, or one
 * inside the other, would each be denied the other's — so neither could read
 * its own. Refused at load, with both names.
 */
function checkPrivateOverlap(roles, path) {
  const all = Object.values(roles).flatMap((r) => (r.private ?? []).map((p) => ({ role: r.name, p, dir: privateDir(p) })));
  const inside = (a, b) => a === b || a.startsWith(b + "/");
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.role === b.role || !(inside(a.dir, b.dir) || inside(b.dir, a.dir))) continue;
      throw new Error(
        `${path}: roles.${a.role}.private "${a.p}" and roles.${b.role}.private "${b.p}" ` +
        `${a.dir === b.dir ? "are the same folder" : "overlap"}. A private folder has one owner: every ` +
        `other role is denied it, so each of these two would be denied its own. Give it to one of them.`);
    }
}

/**
 * A territory is relative to the repo root. An absolute one would ask the kernel
 * for a path on the machine and make `explain` (which reads absolute as outside
 * the repo) disagree with what the profile grants — see the CODEOWNERS `/apps/`
 * case. `..` is allowed on purpose: a role legitimately writes a sibling
 * directory (`../shared/...`), and it is resolved relative to the root, so a
 * territory that climbs above it grants what it resolves to, by the choice of
 * whoever wrote the policy.
 */
function assertNotAbsolute(list, where) {
  for (const g of list) {
    if (typeof g !== "string" || g.trim() === "")
      throw new Error(`${where}: every entry must be a non-empty string`);
    if (g.startsWith("/"))
      throw new Error(`${where}: "${g}" is absolute. Territories are relative to the repo root.`);
  }
  return list;
}

/**
 * An IP address or a CIDR range: `10.0.0.0/8`, `192.168.1.10`, `fc00::/7`
 * (IPv6 without brackets). Anything else is refused with what was written.
 */
function readAddresses(value, where) {
  const list = asArray(value, where);
  for (const v of list) {
    const [addr, prefix, extra] = v.split("/");
    const family = isIP(addr);
    const max = family === 6 ? 128 : 32;
    const okPrefix = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= max);
    if (!family || !okPrefix || extra !== undefined)
      throw new Error(`${where}: "${v}" is not an IP address or a CIDR range (e.g. "10.0.0.0/8", "fc00::/7")`);
  }
  return list;
}

function asArray(value, where) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error(`${where}: expected a string or an array of strings`);
}
