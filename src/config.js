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

export const CONFIG_NAME = "seisin.toml";

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
export function parseToml(text) {
  const out = {};
  let table = out;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    const header = RE_TABLE.exec(line);
    if (header) {
      table = header[1].split(".").reduce((node, key) => (node[key] ??= {}), out);
      continue;
    }

    const pair = RE_PAIR.exec(line);
    if (!pair) throw new Error(`${CONFIG_NAME}:${i + 1}: cannot read "${raw.trim()}"`);

    let [, key, value] = pair;
    // An array may span lines; keep pulling until the brackets balance.
    if (value.startsWith("[") && !value.includes("]")) {
      while (!value.includes("]") && i + 1 < lines.length) value += " " + stripComment(lines[++i]).trim();
    }
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

function readValue(value, lineNo) {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[")) {
    const inner = v.slice(1, v.lastIndexOf("]"));
    const items = inner.match(/"[^"]*"/g) || [];
    if (inner.trim() && items.length === 0)
      throw new Error(`${CONFIG_NAME}:${lineNo}: array items must be double-quoted`);
    return items.map((s) => s.slice(1, -1));
  }
  // One slice, not two. The first version chained `.slice(1, -1)` on top of the
  // unquote and ate the leading character, so `".secrets"` came back as `secrets`.
  // That is silent and it is the worst kind: `denyRead` then pointed at a path
  // that does not exist, and every key was readable by every role. Caught by the
  // end-to-end test, never by reading the line.
  if (v.startsWith('"')) return v.slice(1, v.lastIndexOf('"'));
  throw new Error(`${CONFIG_NAME}:${lineNo}: value must be a string, an array of strings, or a boolean`);
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
  const roles = parsed.roles ?? {};
  const names = Object.keys(roles);
  if (names.length === 0) throw new Error(`${path}: no [roles.<name>] sections found`);

  // One directory or several. Several is the common case once a repo has more
  // than one kind of secret, and making people flatten them to satisfy the tool
  // is how a tool gets kept out.
  const keyDirs = parsed.keys?.dir === undefined ? [] : asArray(parsed.keys.dir, "keys.dir");
  // `undefined` means "use the defaults"; an explicit empty array means "none".
  // The difference matters: one is a user who has not thought about it, the
  // other is a user who has.
  const runtimeWrites = parsed.runtime?.writes;

  const out = {
    root: dirname(path), path, keyDirs,
    allowedDomains: parsed.network?.allow ?? [],
    runtimeWrites: runtimeWrites === undefined ? undefined : asArray(runtimeWrites, "runtime.writes"),
    redact: parsed.runtime?.redact,
    scanIgnore: asArray(parsed.scan?.ignore, "scan.ignore"),
    roles: {},
  };

  for (const name of names) {
    const r = roles[name];
    const writes = asArray(r.writes, `roles.${name}.writes`);
    const keys = asArray(r.keys, `roles.${name}.keys`);
    if (keys.length && keyDirs.length === 0)
      throw new Error(`${path}: roles.${name} lists keys, but [keys] dir is not set`);
    out.roles[name] = {
      name,
      writes,
      keys,
      env: asArray(r.env, `roles.${name}.env`),
      network: r.network === undefined ? null : asArray(r.network, `roles.${name}.network`),
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
