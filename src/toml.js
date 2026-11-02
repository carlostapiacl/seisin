/**
 * The TOML subset seisin.toml is written in: `[table.name]` headers, and
 * `key = ["a", "b"]` / `key = "a"` values, with a line number on every error.
 *
 * Kept in-house so installing seisin pulls in no parser. If a config outgrows
 * this subset, the config is doing too much.
 */
import { CONFIG_NAME } from "./layout.js";

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
export const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

/** A table with no prototype, so nothing is inherited into it. */
export function dict() {
  return Object.create(null);
}

export const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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
export const LINES = new WeakMap();

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
