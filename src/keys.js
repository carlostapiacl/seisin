/**
 * Keys that are references rather than files.
 *
 * Until this existed a key was a path: `keys = ["netlify-token.txt"]` named a
 * file inside a declared `[keys] dir`, and the whole mechanism was the
 * filesystem's — resolve it, check it lands inside the directory, add it to
 * `allowRead`. That works and it stays. What it cannot do is reach a secret
 * that has no path, which is where most secrets that are looked after at all
 * actually live: a keychain, 1Password, Bitwarden, sops, Vault.
 *
 * So a key may also be a **reference with a scheme**, resolved by a provider
 * declared in the same file:
 *
 *   [keys.providers.keychain]
 *   command = ["security", "find-generic-password", "-w", "-s", "{ref}"]
 *
 *   [roles.frontend]
 *   keys = ["keychain://netlify-token", "netlify-token.txt"]
 *
 * A provider is a command with a placeholder. Adding Bitwarden or
 * `sops` is then three lines of TOML and no code — which is what makes this one
 * integration instead of one per vault, and what keeps seisin from aging with
 * somebody else's CLI.
 *
 * ## What this does not do
 *
 * It resolves the secret **at rest**, not in the agent's context. The value
 * still reaches the process and the agent can still read it. That is a strict
 * improvement over a plaintext file — the secret stops living on disk, the
 * policy holds a reviewable reference instead of a path, and every resolution
 * is logged without its value — but it is not "the agent never sees it". That
 * is `inject`, it costs terminating the role's TLS with a CA of your own, and
 * it is not built. `modeOf` refuses it by name rather than letting it read as
 * available.
 *
 * ## Why the value is never written down
 *
 * The reference is what gets committed, diffed and approved; the value is what
 * gets handed to one process and forgotten. A log that carries the secret is a
 * second plaintext copy with worse access control than the first.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, isAbsolute, delimiter } from "node:path";
import { BASE, DEFAULTS } from "./env.js";
import { SOCK_ENV } from "./spool.js";
import { resolveExecutable, trustedPath } from "./surface.js";

/**
 * How long a provider may take. A minute, because the slow case is a person:
 * `op` and the keychain can put a prompt in front of someone who is not
 * looking at the screen yet. Before this there was no limit, and a provider
 * stuck on a prompt nobody could see held the run with no message at all.
 */
export const PROVIDER_TIMEOUT_MS = 60_000;

/** A credential is bytes, not megabytes. Past this it is not a key. */
const PROVIDER_MAX_BYTES = 1024 * 1024;

/**
 * `scheme://rest`, and nothing cleverer.
 *
 * The scheme is matched the way a URL scheme is, so a Windows path (`C:\…`) and
 * a relative path with a colon in it do not read as references. `rest` is the
 * whole remainder including any slashes, because `op://vault/item/field` is one
 * reference and not three.
 */
const RE_REF = /^([a-z][a-z0-9+.\-]*):\/\/(.+)$/;

/** `NAME=` in front of a reference: the environment variable to deliver it as. */
const RE_NAMED = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/;

/**
 * The name a reference arrives under when nobody said.
 *
 * Derived rather than required, because `keys = ["keychain://netlify-token"]`
 * is the spelling in front of everyone and making it illegal buys nothing. The
 * derivation is dull — last segment, uppercased, anything that is
 * not a letter or a digit becomes `_` — and `seisin check` prints the result,
 * so a name that surprises somebody is visible before a run rather than after.
 */
export function defaultName(ref) {
  const last = ref.split("/").filter(Boolean).pop() ?? ref;
  const name = last.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  // A reference of punctuation only would otherwise derive the empty string and
  // produce an unsettable variable. It is not reachable from a sane vault name;
  // it is here because an unnamed failure at spawn time is worse than a refusal.
  return /^[A-Za-z_]/.test(name) ? name : `KEY_${name}`;
}

/**
 * One entry of `keys = [...]`, read.
 *
 * Returns `{ kind: "file", raw }` for a path — which is everything that was
 * valid before this module existed, unchanged — or
 * `{ kind: "ref", scheme, ref, name, raw }` for a reference.
 *
 * It does not decide whether the scheme is *known*: that needs the config, and
 * separating the two is what lets `check` report every unknown scheme in a file
 * at once instead of dying on the first.
 */
export function parseKey(entry) {
  if (typeof entry !== "string") throw new Error(`keys: expected a string, got ${typeof entry}`);
  const named = RE_NAMED.exec(entry);
  const body = named ? named[2] : entry;
  const m = RE_REF.exec(body);
  if (!m) {
    // `NAME=path` is refused rather than read as a file called `NAME=path`.
    // A name in front of a path means the writer expected delivery by
    // environment, and a path key is delivered by being readable — so the
    // spelling asks for something that will not happen, silently.
    if (named)
      throw new Error(
        `keys = "${entry}": "${named[1]}=" names an environment variable, but ` +
        `"${body}" is a path, not a reference.\n` +
        `  A path key is delivered by being readable, so there is no variable to name. ` +
        `Drop the prefix, or point it at a provider: "${named[1]}=keychain://${named[2]}".`);
    return { kind: "file", raw: entry };
  }
  const [, scheme, ref] = m;
  return { kind: "ref", scheme, ref, name: named ? named[1] : defaultName(ref), raw: entry };
}

/**
 * `file://` — the one provider seisin ships, because it is the common case.
 *
 * Everything else stays out: a provider is a command,
 * and wiring 1Password or Vault into the package would be choosing for you and
 * ageing with somebody else's CLI. This one is different, and the difference is
 * not convenience.
 *
 * The secret in a plain file is **the case the tool exists for**. Measured on
 * one real deployment: 128 credential files in the clear, 79 of them
 * world-readable, and not one role using the key mechanism at all. Telling
 * that person "declare a provider that runs `cat`" puts a papercut on the only
 * path most people will ever take, and `cat` is worse than it looks — it
 * resolves relative to whatever directory the parent happened to be in, and it
 * hands back the whole file when the file holds twelve variables.
 *
 * So `file://` is native, resolves against the policy's own directory, and
 * takes a fragment:
 *
 *     keys = ["TOKEN=file://.secrets/netlify.txt"]              the whole file
 *     keys = ["RESEND_KEY=file://.secrets/all.env#RESEND_KEY"]  one key of many
 *
 * It grants **no read**. That is the entire point: the role gets the value and
 * cannot open the file, which is the thing `keys = ["all.env"]` cannot do
 * because a file grant is a file grant.
 *
 * It does not require the file to live under `[keys] dir`. The path form does,
 * because it opens a read inside a denied directory and has to be bounded. This
 * opens nothing — it hands over a string — so the same rule would be a
 * restriction copied for looking like the other one.
 */
export const BUILTIN = new Set(["file"]);

/** The file as a JSON object, or null if it is not one. */
function parseJsonObject(text) {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** One trailing newline is the editor's, not the secret's. */
const unterminate = (v) => v.replace(/\r?\n$/, "");

/**
 * `KEY=value` out of a file that holds several.
 *
 * Deliberately small: `export` is tolerated because half the world's `.env`
 * files have it, surrounding quotes come off, and everything else is left
 * alone. This is not a shell parser and should never become one — a config
 * language that grows an interpreter is how a permission tool gets a CVE.
 */
/**
 * One value out of a JSON object.
 *
 * JSON is here and Markdown is not, and the line between them is not effort:
 * **JSON is a format, a runbook is a document.** A service-account key, a
 * `credentials.json`, anything a cloud CLI writes — those have one shape, so
 * reading them is a rule. A table of passwords inside a page of prose has no
 * shape; extracting from it would be guessing, and a credential tool that
 * guesses hands over the wrong secret rather than failing.
 *
 * The literal key first, then a dotted path, because a key that contains a dot
 * is real and should win over a reading of it as a path.
 *
 * Only scalars. An object or an array is not a credential, and returning one
 * stringified would put `[object Object]` in an environment variable and call
 * it a token.
 */
function fromJson(obj, key, ref) {
  let v = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  if (v === undefined && key.includes(".")) {
    v = key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
  }
  if (v === undefined) {
    const top = Object.keys(obj).slice(0, 8).join(", ");
    throw new Error(
      `key "${ref}": that JSON has no ${key}.\n` +
      `  Top-level names: ${top}${Object.keys(obj).length > 8 ? ", …" : ""}.\n` +
      `  A nested one is reached with dots: "#credentials.token".`);
  }
  if (v === null || typeof v === "object")
    throw new Error(
      `key "${ref}": ${key} is ${v === null ? "null" : Array.isArray(v) ? "an array" : "an object"}, ` +
      `not a value.\n  A credential is a string or a number. Point the fragment at one, or drop ` +
      `the fragment to hand over the whole file.`);
  return String(v);
}

/**
 * One `NAME=value` line's value, the way dotenv reads it — or a refusal.
 *
 * Compared against dotenv 16 on the same file (2026-09-23), three lines came
 * back different, and a different value is a wrong credential handed over
 * without a word:
 *
 *   - `A=abc # comment` — dotenv drops the comment; this kept it.
 *   - a name defined twice — dotenv takes the last; this took the first.
 *   - a quoted value spanning lines — dotenv reads it whole; this returned
 *     the first line with its quote.
 *
 * The comment is read like dotenv, because there is one reading of it. The
 * other two are refused, because loaders disagree about them and picking one
 * is guessing which credential somebody meant.
 */
function dotEnvValue(raw, ref, key) {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'" || q === "`") {
    // The closing quote is the first one not escaped with a backslash, as in
    // dotenv's own pattern: `"a\"b"` is one value, `a\"b`, not `a\`.
    let end = -1;
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "\\") { i++; continue; }
      if (v[i] === q) { end = i; break; }
    }
    if (end === -1)
      throw new Error(
        `key "${ref}": ${key}= opens a ${q} quote that does not close on its line.\n` +
        `  A value across several lines is read differently by different loaders, so seisin ` +
        `does not read it. Put the credential on one line, or in a file of its own.`);
    // Only a comment may follow the closing quote. `A="a" b` is read by dotenv
    // as the whole line, quotes included, and by others as `a`.
    const rest = v.slice(end + 1).trim();
    if (rest && !rest.startsWith("#"))
      throw new Error(
        `key "${ref}": ${key}= has text after its closing quote (${rest.slice(0, 20)}…).\n` +
        `  Loaders disagree on what that value is. Quote the whole value.`);
    const inner = v.slice(1, end);
    // Inside double quotes dotenv turns \n and \r into the characters — the
    // shape a PEM key takes in a .env. Handed over literally, the key has a
    // backslash and an n where its line breaks go, and it does not parse.
    return q === '"' ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : inner;
  }
  const bare = v.replace(/\s+#.*$/, "");
  // A `#` inside an unquoted value: dotenv 16 cuts the value there
  // (`tok_#_123` → `tok_`), python-dotenv and docker compose keep it.
  if (bare.includes("#"))
    throw new Error(
      `key "${ref}": the value of ${key}= contains a # without quotes.\n` +
      `  Some loaders read everything after it as a comment and some do not, so the ` +
      `credential depends on who reads the file. Quote it: ${key}="…".`);
  return bare;
}

function fromDotEnv(text, key, ref) {
  let sawAny = false;
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    sawAny = true;
    if (m[1] !== key) continue;
    if (found !== null)
      throw new Error(
        `key "${ref}": ${key}= is defined more than once in that file.\n` +
        `  dotenv takes the last one and other loaders the first, so which credential is meant ` +
        `is not written down. Keep one.`);
    found = dotEnvValue(m[2], ref, key);
  }
  if (found !== null) return found;
  /**
   * Two different failures, and telling them apart is the whole message.
   *
   * "this file has no `TOKEN=`" is a typo in the reference. "this file has no
   * `NAME=` lines at all" is a person pointing a fragment at something that is
   * not an env file — and in the field that was a 146-line Markdown runbook
   * with the credentials in a table, which no extractor is going to read.
   * Saying "has no TOKEN=" about that sends somebody hunting for a typo in a
   * file where the answer is that the secrets are in prose.
   */
  if (!sawAny)
    throw new Error(
      `key "${ref}": nothing in that file looks like NAME=value, so there is no ${key} to take.\n` +
      `  A fragment reads one line out of an env file. If the secret lives inside a document ` +
      `— a runbook, a table, a note — seisin cannot reach it, and the fix is to move the ` +
      `secret out of the document rather than to teach a parser about it.\n` +
      `  Without the "#${key}", file:// hands over the whole file as the value.`);
  throw new Error(
    `key "${ref}": the file has NAME=value lines, but no ${key}=.\n` +
    `  A name that is not there is not an empty value — nothing is substituted for a key ` +
    `that did not resolve.`);
}

/**
 * Read `file://<path>` or `file://<path>#<KEY>`, relative to the policy.
 *
 * Relative to the policy and not to the process: a key that resolves
 * differently depending on where you were standing when you typed the command
 * is a key that works in your shell and fails in the agent's.
 */
export function readFileRef(entry, root = ".") {
  const hash = entry.ref.lastIndexOf("#");
  const path = hash === -1 ? entry.ref : entry.ref.slice(0, hash);
  const key = hash === -1 ? null : entry.ref.slice(hash + 1);
  const full = isAbsolute(path) ? path : resolve(root, path);
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch (e) {
    throw new Error(
      `key "${entry.raw}": cannot read ${full} (${e.code ?? e.message}).\n` +
      `  The path is resolved against the policy file's directory, not the current one.`);
  }
  let value;
  if (key === null) {
    value = unterminate(text);
  } else {
    // Sniffed, not taken from the extension. The file that motivated this was
    // named `.txt` and the one before it `.env`; the name is a hint and the
    // content is the fact.
    const asJson = parseJsonObject(text);
    value = asJson ? fromJson(asJson, key, entry.raw) : fromDotEnv(text, key, entry.raw);
  }
  if (value === "")
    throw new Error(`key "${entry.raw}": ${full} is empty. An empty credential is not a credential.`);
  return value;
}

/**
 * Variable names a key may not take, and why each group is here.
 *
 * A key delivered by `env` is written into the child's environment after it is
 * built, so whatever it is called, it wins. That is fine until the name is one
 * of these:
 *
 *   - **What seisin itself injects.** `SEISIN_ROLE` is how the hook inside the
 *     box learns which role it is. A key called that would let a policy tell
 *     the hook it is somebody else — privilege confusion written in the one
 *     file that is supposed to prevent it. Same for the config path and the
 *     audit socket.
 *   - **What the child needs to be a child.** `keys = ["keychain://path"]`
 *     derives `PATH`, and the measured result is the sandbox failing with
 *     `env: node: No such file or directory` — a config mistake that reads
 *     exactly like a broken installation. `HOME`, `TMPDIR` and the TLS
 *     variables are the same shape, and `NODE_EXTRA_CA_CERTS` is worse than
 *     cosmetic.
 *
 * Refused when the policy loads rather than when it runs, so `seisin check`
 * catches it and nobody debugs it from inside a sandbox.
 */
export const RESERVED_ENV = new Set([
  "SEISIN_ROLE", "SEISIN_CONFIG", SOCK_ENV,
  ...BASE, ...Object.keys(DEFAULTS),
]);

/**
 * Every delivered name a role's keys would claim — the variable, and for
 * `scratch` the `_FILE` that carries the path.
 *
 * Checked as a set because two keys resolving to one name is the other half of
 * the same failure: `keys = ["T=a://x", "T=b://y"]` used to deliver the second
 * and drop the first, in silence, in a credential list. Measured before this
 * existed; the run printed `T=b` and said nothing about `a://x`.
 */
export function checkNames(role) {
  const taken = new Map();
  for (const e of role.keyEntries ?? []) {
    if (e.kind !== "ref") continue;
    for (const name of [e.name, `${e.name}_FILE`]) {
      if (RESERVED_ENV.has(name))
        throw new Error(
          `roles.${role.name}: key "${e.raw}" would arrive as ${name}, which seisin or the ` +
          `child already needs.\n` +
          `  Give it a name of its own: keys = ["MY_${name}=${e.scheme}://${e.ref}"].`);
      const first = taken.get(name);
      if (first !== undefined)
        throw new Error(
          `roles.${role.name}: "${first}" and "${e.raw}" both arrive as ${name}. ` +
          `One would silently replace the other.\n` +
          `  Name at least one of them: keys = ["SOMETHING_ELSE=${e.scheme}://${e.ref}"].`);
      taken.set(name, e.raw);
    }
  }
}

/**
 * A role's key entries, however the role object was built.
 *
 * `loadConfig` fills `keyEntries`; a role assembled by hand — a test, or an
 * embedder holding seisin as a library — has only `keys`, and that shape
 * shipped, so it keeps working. One helper rather than the same fallback
 * written in three files, because the day they disagree is the day a key is
 * scoped in one place and not in another.
 */
export function entriesOf(role) {
  return role.keyEntries ?? (role.keys ?? []).map(parseKey);
}

/**
 * The three ways a resolved value can reach a role.
 *
 * The middle one is called `scratch` and not `file`, which looks like a
 * cosmetic choice and is not. The runtime has a field named
 * `credentials.files`, it is the one that looks like seisin's `keys` (both take
 * paths), and on macOS it does **not** mask — it makes the file unreadable, so
 * a `cat` returns `Operation not permitted` and the reader concludes the
 * feature is broken rather than misused. That mistake has already been made
 * once here and cost a measurement that got written up as a finding about the
 * runtime. A mode called `file` sitting ten centimetres from a runtime field
 * called `files` that fails that way is a trap with a date on it.
 *
 * `scratch` also says what actually happens: the value lands in scratch space
 * for the turn and is removed after it, which `file` does not say at all.
 */
export const MODES = ["env", "scratch", "inject"];

/**
 * How a role receives its reference keys, and where that is written.
 *
 * Per role (`key_mode`) or per provider (`mode`), role first. It is not a
 * per-key setting, and that is a limit of the config language rather than a
 * judgement: the parser covers `[table]` headers and `key = value` pairs, so a
 * mode attached to one entry of an array has nowhere to live without inline
 * tables — and growing the parser to hold one field is the trade this repo has
 * already decided against out loud.
 *
 * The important half survives that limit. The encargo's argument for declaring
 * the mode beside the permission is that a reader of `seisin.toml` can say
 * "this role sees the value" without opening any code, and a per-role setting
 * answers exactly that question.
 *
 * There is no silent default. A reference with no mode anywhere is an error,
 * because the two available answers differ in what the agent can walk away
 * with, and picking one for somebody is picking how much a leak costs them.
 */
export function modeOf(config, role, entry) {
  const provider = config.keyProviders?.[entry.scheme];
  const mode = role.keyMode ?? provider?.mode ?? null;
  if (mode === null) {
    // A built-in scheme has no `[keys.providers.…]` table to put a default in —
    // declaring one is refused, because a scheme cannot mean two things. So
    // offering it here sent the first person who tried the feature from this
    // error straight into another one. Found in the field, on the first wall.
    const second = BUILTIN.has(entry.scheme)
      ? ""
      : ` Or set one for every key of that provider: ` +
        `[keys.providers.${entry.scheme}] mode = "env".`;
    throw new Error(
      `roles.${role.name}: key "${entry.raw}" has no delivery mode.\n` +
      `  Declare one beside the permission: [roles.${role.name}] key_mode = "env".${second}\n` +
      `  "env" passes the value as ${entry.name}; "scratch" writes it to a file inside the ` +
      `role's scratch space, grants that one path, and removes it when the turn ends.`);
  }
  if (mode === "inject")
    throw new Error(
      `roles.${role.name}: key_mode = "inject" is not implemented.\n` +
      `  It is the one mode where the agent never sees the value, and it is not free: the ` +
      `runtime only masks a credential when the role's TLS is terminated with a CA of ` +
      `seisin's own — MITM over all of that role's traffic, not just the host holding the ` +
      `secret. It is refused rather than half-available.\n` +
      `  Use "env" or "file" today. See docs/decisions.md.`);
  if (!MODES.includes(mode))
    throw new Error(
      `roles.${role.name}: key_mode = "${mode}" is not a delivery mode. Known: ${MODES.join(", ")}.` +
      // The one wrong answer named, because it is the word everybody
      // reaches for and it is one letter from a runtime field that fails
      // silently. Guessing costs a debugging session; saying so costs a line.
      (mode === "file"
        ? `\n  "file" is not one of them on purpose — the runtime has a "credentials.files" that ` +
          `takes paths and, on macOS, makes them unreadable instead of masking. The mode that ` +
          `hands a role a file is "scratch".`
        : ""));
  return mode;
}

/**
 * Run a provider and hand back what it printed.
 *
 * Three properties, each of which was a requirement before it was code:
 *
 *   - **The parent runs it, never the confined process.** Same reason `owners`
 *     recomputes instead of believing what it is told: the inside of the box
 *     cannot be allowed to reach the thing that decides what the box contains.
 *     A provider command spawned from within the sandbox would need the vault's
 *     own credential in there with it, which is the problem this feature exists
 *     to remove.
 *   - **A failure is a failure.** Not empty, not the file of the same name, not
 *     a skipped key. The house rule is already written twice: a check that
 *     cannot measure and says ok lies more than one that says no. A role that
 *     starts without the credential it declared fails later, further away, and
 *     looking like something else.
 *   - **The value is not in the error.** `stderr` from the provider is passed
 *     through because it is how `op` says "not signed in", but `stdout` never
 *     is — a provider that prints the secret and then exits non-zero would
 *     otherwise put it in the terminal and the log.
 */
export function resolveRef(entry, provider, { run = spawnSync, root = ".", config = null, env = process.env } = {}) {
  if (provider?.builtin === "file" || (provider === undefined && entry.scheme === "file"))
    return readFileRef(entry, root);
  const argv = provider.command.map((part) => part.replaceAll("{ref}", entry.ref));
  /**
   * Found where no role can write, and handed the same PATH.
   *
   * `spawnSync("fakeprov")` searched the parent's PATH, and a PATH directory
   * inside a territory made the next run execute whatever that role had put
   * there — outside the box, as you. Measured on 2026-09-23 with a marker file.
   * The provider's own PATH is narrowed the same way, because a provider that
   * is a script starts with `#!/usr/bin/env bash` and looks its interpreter up
   * again. Without a config (a caller embedding seisin), or with a `run` of the
   * caller's own, the argv is handed over as given: finding the program is part
   * of spawning it, and whoever replaced the spawn owns that too.
   */
  const opts = { encoding: "utf8", timeout: PROVIDER_TIMEOUT_MS, maxBuffer: PROVIDER_MAX_BYTES };
  if (config && run === spawnSync) {
    argv[0] = resolveExecutable(argv[0], config, env);
    opts.env = { ...env, PATH: trustedPath(config, env).join(delimiter) };
  }
  const r = run(argv[0], argv.slice(1), opts);
  if (r.error?.code === "ETIMEDOUT")
    throw new Error(
      `key "${entry.raw}": the ${entry.scheme} provider (${argv[0]}) did not answer in ` +
      `${PROVIDER_TIMEOUT_MS / 1000} s and was stopped.\n` +
      `  A provider that waits on a prompt nobody sees would otherwise hold the run forever.`);
  if (r.error)
    throw new Error(
      `key "${entry.raw}": could not run the ${entry.scheme} provider (${argv[0]}): ${r.error.message}`);
  if (r.status !== 0) {
    // Whatever it printed on stdout is taken out of stderr before stderr is
    // shown: a provider that echoes the secret to both and then fails would
    // otherwise put it in the terminal through the error meant to explain it.
    const leaked = (r.stdout ?? "").trim();
    const clean = leaked.length >= 4 ? (r.stderr ?? "").split(leaked).join("‹redacted›") : (r.stderr ?? "");
    const said = clean.trim().split("\n").slice(0, 3).map((l) => l.slice(0, 200)).join("\n    ");
    throw new Error(
      `key "${entry.raw}": the ${entry.scheme} provider exited ${r.status ?? "on a signal"}.` +
      (said ? `\n    ${said}` : "") +
      `\n  Nothing is substituted for a key that did not resolve — the run stops here rather ` +
      `than starting a role without a credential it declared.`);
  }
  // One trailing newline is the shell's, not the secret's: `security -w` and
  // `op read` both add one, and a token with a newline welded to it fails
  // authentication in a way that looks like a wrong token.
  const value = (r.stdout ?? "").replace(/\r?\n$/, "");
  if (value === "")
    throw new Error(
      `key "${entry.raw}": the ${entry.scheme} provider succeeded and printed nothing.\n` +
      `  An empty credential is not a credential. Check the reference — most providers exit 0 ` +
      `for a name they do not have.`);
  return value;
}

/**
 * Every reference a role declares, resolved, as `{ entry, mode, value }`.
 *
 * Validation of schemes and modes happens over the whole list before the first
 * provider runs. A config with three bad references should say so once, and it
 * should say so without asking anyone's keychain for a password first.
 */
export function resolveKeys(config, role, opts = {}) {
  opts = { root: config.root ?? ".", config, ...opts };
  const refs = role.keyEntries.filter((e) => e.kind === "ref");
  const plan = refs.map((entry) => ({ entry, mode: modeOf(config, role, entry) }));
  return plan.map((p) => ({
    ...p,
    value: resolveRef(p.entry, config.keyProviders[p.entry.scheme], opts),
  }));
}
