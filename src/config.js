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
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { CONFIG_NAME } from "./layout.js";

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

/** Minimal TOML subset -> plain object. Throws with a line number on bad input. */
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

/** Read a property only if the object actually has it. */
export function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export function parseToml(text) {
  const out = dict();
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
          `A later block would silently override the earlier one — put every setting for ` +
          `${tableName} in one place.`);
      seenTables.add(tableName);
      table = tableName.split(".").reduce((node, key) => {
        if (!Object.prototype.hasOwnProperty.call(node, key)) node[key] = dict();
        return node[key];
      }, out);
      continue;
    }

    const pair = RE_PAIR.exec(line);
    if (!pair) throw new Error(`${CONFIG_NAME}:${i + 1}: cannot read "${raw.trim()}"`);

    let [, key, value] = pair;
    // An array may span lines; keep pulling until the brackets balance.
    if (value.startsWith("[") && !value.includes("]")) {
      while (!value.includes("]") && i + 1 < lines.length) value += " " + stripComment(lines[++i]).trim();
    }
    if (FORBIDDEN.has(key))
      throw new Error(`${CONFIG_NAME}:${i + 1}: "${key}" is a reserved name and cannot be a setting.`);
    const seen = `${tableName}.${key}`;
    if (seenKeys.has(seen))
      throw new Error(
        `${CONFIG_NAME}:${i + 1}: "${key}" is set twice in [${tableName || "the root"}]. ` +
        `The second would win, which is not a thing a permission file should do quietly.`);
    seenKeys.add(seen);
    table[key] = readValue(value, i + 1);
  }
  return out;
}

/** Strips a trailing `#` comment, but not one inside a quoted string. */
function stripComment(line) {
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
      if (c !== '"') bad(`array items must be double-quoted, found ${JSON.stringify(body.slice(i, i + 12))}`);

      const end = body.indexOf('"', i + 1);
      if (end === -1) bad("unterminated string inside the array");
      items.push(body.slice(i + 1, end));
      i = end + 1;
      expectItem = false;                 // a trailing comma is fine; a trailing item is not
    }
    return items;
  }

  bad("value must be a string, an array of strings, or a boolean");
}

/**
 * Turns the parsed file into the shape the rest of the program uses, and
 * rejects anything ambiguous.
 *
 * Rejecting is the point. The sandbox runtime refuses to start on an invalid
 * settings file rather than falling back to a permissive default, and seisin
 * matches that: a permission tool that guesses is worse than no permission tool.
 */
export function loadConfig(path) {
  const parsed = parseToml(readFileSync(path, "utf8"));
  // Read only what the file actually declared. The parser refuses the names
  // that make inheritance possible, and this is the second half of the same
  // rule: if one of them ever gets through, a role still cannot pick up a
  // setting it never wrote down. Two independent stops, because the failure
  // they prevent is invisible in review — the config reads one way and the
  // policy is another.
  const roles = own(parsed, "roles") ?? {};

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
   * There is no ambiguity to preserve here — a nested table under [roles] has
   * no meaning in this tool — so it is an error, and it names both what was
   * written and what it became.
   */
  for (const name of Object.keys(roles)) {
    const r = own(roles, name);
    const nested = Object.keys(r ?? {}).filter((k) => r[k] && typeof r[k] === "object" && !Array.isArray(r[k]));
    if (nested.length)
      throw new Error(
        `${path}: [roles.${name}.${nested[0]}] — a dot separates keys in TOML, so this ` +
        `declares a role called "${name}", not "${name}.${nested[0]}".\n` +
        `  Role names cannot contain dots. Use "${name}-${nested[0]}".`);
  }
  const names = Object.keys(roles);
  if (names.length === 0) throw new Error(`${path}: no [roles.<name>] sections found`);

  // One directory or several. Several is the common case once a repo has more
  // than one kind of secret, and making people flatten them to satisfy the tool
  // is how a tool gets kept out.
  const keyDir = own(own(parsed, "keys"), "dir");
  const keyDirs = keyDir === undefined ? [] : asArray(keyDir, "keys.dir");
  // `undefined` means "use the defaults"; an explicit empty array means "none".
  // The difference matters: one is a user who has not thought about it, the
  // other is a user who has.
  const runtime = own(parsed, "runtime");
  const runtimeWrites = own(runtime, "writes");

  const out = {
    root: dirname(path), path, keyDirs,
    allowedDomains: own(own(parsed, "network"), "allow") ?? [],
    runtimeWrites: runtimeWrites === undefined ? undefined : asArray(runtimeWrites, "runtime.writes"),
    // `[runtime] isolate = true` gives each role its own HOME and TMPDIR
    // instead of the real ones. Off by default because turning it on makes
    // every CLI in the box see an empty home — which means logging in again,
    // and a permission tool that silently signs you out is a permission tool
    // people uninstall. See srt.js.
    isolate: own(runtime, "isolate") === true,
    redact: own(runtime, "redact"),
    scanIgnore: asArray(own(own(parsed, "scan"), "ignore"), "scan.ignore"),
    roles: {},
  };

  for (const name of names) {
    const r = own(roles, name);
    const writes = asArray(own(r, "writes"), `roles.${name}.writes`);
    const keys = asArray(own(r, "keys"), `roles.${name}.keys`);
    if (keys.length && keyDirs.length === 0)
      throw new Error(`${path}: roles.${name} lists keys, but [keys] dir is not set`);
    out.roles[name] = {
      name,
      writes,
      keys,
      env: asArray(own(r, "env"), `roles.${name}.env`),
      network: own(r, "network") === undefined ? null : asArray(own(r, "network"), `roles.${name}.network`),
    };
  }
  return out;
}

function asArray(value, where) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  throw new Error(`${where}: expected a string or an array of strings`);
}
