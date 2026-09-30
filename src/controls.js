/**
 * Handing a role a family of control files, and protecting instruction files,
 * as edits a person makes from the console.
 *
 * Both settings were only reachable by opening seisin.toml in an editor. That
 * is fine for whoever wrote the policy and a wall for whoever inherited it:
 * the console showed the refusal ("protected: .vscode, whose settings … VS
 * Code applies outside the sandbox") and offered no way to act on it except
 * approving a request that a grant can never satisfy (refuseIfBarred says so).
 *
 * What this module does not do is widen the menu. The families are exactly
 * config.js's CONTROL_FAMILIES; `.claude/`, git hooks, `.mcp.json` and `.envrc`
 * are never offered, because they are what a program outside the sandbox executes
 * and no role writes them — not from the file, not from here.
 *
 * Every edit is text, bounded to one table, like applyGrant: comments and the
 * order a person gave the file survive, and a change for one role can never
 * land in another role's table.
 */
import { createHash } from "node:crypto";
import { loadConfig, CONTROL_FAMILIES, stripComment, closesArray } from "./config.js";
import { settingsFor } from "./srt.js";
import { denyFor } from "./surface.js";
import { cleanReason } from "./requests.js";

const RE_HEADER = /^\[([A-Za-z0-9_.\-]+)\]$/;
const RE_KEY = /^([A-Za-z0-9_\-]+)\s*=/;

/** An error that is the caller's fault: the server answers it with 400. */
function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export const hashOf = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);

/**
 * The families as the caller sent them, validated and in the canonical order.
 *
 * Refused, not filtered: a request for ".claude" is somebody asking for the
 * one thing this tool will not hand out, and silently dropping it would save a
 * policy that is not what they asked for.
 */
export function normalizeFamilies(families) {
  if (!Array.isArray(families) || families.some((f) => typeof f !== "string"))
    throw bad(`families must be a list of names — some of ${CONTROL_FAMILIES.map((f) => JSON.stringify(f)).join(", ")}`);
  for (const f of families)
    if (!CONTROL_FAMILIES.includes(f))
      throw bad(`${JSON.stringify(f)} is not a family of control files. Known: ` +
        `${CONTROL_FAMILIES.map((x) => JSON.stringify(x)).join(", ")}. The others ` +
        `(.claude, git hooks, .mcp.json, .envrc) are never handed to a role.`);
  return CONTROL_FAMILIES.filter((f) => families.includes(f));
}

/**
 * The lines of one table: where its header is, where it ends, and each
 * key's first and last line. A multi-line array is one key, so a line inside
 * one is never taken for a header or for another key.
 */
function tableOf(lines, name) {
  let header = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = RE_HEADER.exec(stripComment(lines[i]).trim());
    if (h && h[1] === name) { header = i; break; }
  }
  if (header === -1) return null;
  const keys = [];
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    if (RE_HEADER.test(line)) { end = i; break; }
    const k = RE_KEY.exec(line);
    if (!k) continue;
    const from = i;
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (value.startsWith("[") && !closesArray(value))
      while (i + 1 < lines.length && !closesArray(stripComment(lines[++i]).trim()));
    keys.push({ key: k[1], from, to: i });
  }
  return { header, end, keys };
}

function stamp(note) {
  return `# set in the console ${new Date().toISOString().slice(0, 10)}` +
    (note ? ` · «${cleanReason(note)}»` : "");
}

/**
 * Sets `key = value` inside one table: replaces the line (or the lines, for a
 * multi-line array) where the key was, or adds it after the table's last key.
 * The replaced line's own trailing comment goes with it — it described the
 * value being replaced, and the stamp now describes the new one. Every other
 * line, comments included, stays byte for byte.
 */
function setKey(text, table, key, value, note) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n");
  const cr = eol === "\r\n" ? "\r" : "";
  const t = tableOf(lines, table);
  if (!t) return null;
  const at = t.keys.find((k) => k.key === key);
  if (at) {
    // The same value is no edit: re-stamping it would record a decision
    // nobody made, and move the date of the one somebody did.
    const was = lines.slice(at.from, at.to + 1).map((l) => stripComment(l).trim()).join(" ");
    if (was.slice(was.indexOf("=") + 1).replace(/\s+/g, "").replace(/,\]$/, "]") === value.replace(/\s+/g, "")) return text;
    const indent = /^\s*/.exec(lines[at.from])[0];
    const line = `${indent}${key} = ${value}   ${stamp(note)}${cr}`;
    lines.splice(at.from, at.to - at.from + 1, line);
  } else {
    // After the last key, not the last line: a comment above the next table
    // belongs to that table, and a line inserted under it would read as the
    // next role's.
    const after = t.keys.length ? t.keys[t.keys.length - 1].to : t.header;
    lines.splice(after + 1, 0, `${key} = ${value}   ${stamp(note)}${cr}`);
  }
  return lines.join("\n");
}

const listOf = (families) => `[${families.map((f) => `"${f}"`).join(", ")}]`;

/**
 * The policy text with `control_files` of one role set to `families`.
 *
 * An empty list is written as `control_files = []` with its stamp when the key
 * was there, rather than deleted: the line is the record that somebody took
 * the family away, and when. A role that never had the key and still has none
 * is left alone.
 */
export function applyControlFiles(toml, role, families, note = "") {
  const want = normalizeFamilies(families);
  const lines = toml.split("\n");
  const t = tableOf(lines, `roles.${role}`);
  if (!t) throw bad(`no [roles.${role}] section in the policy`);
  if (!want.length && !t.keys.some((k) => k.key === "control_files")) return { toml, changed: false };
  const out = setKey(toml, `roles.${role}`, "control_files", listOf(want), note);
  return { toml: out, changed: out !== toml };
}

/**
 * The policy text with `[protect] instructions` set.
 *
 * A missing `[protect]` table is created only to turn the protection on
 * (off is the default and needs no line), and it goes above the first role:
 * it is a setting about every role, and a reader meets it before the roles
 * it changes. A comment block that sits directly above that role stays with
 * the role.
 */
export function applyProtect(toml, on, note = "") {
  if (typeof on !== "boolean") throw bad("protect must be true or false");
  const lines = toml.split("\n");
  if (tableOf(lines, "protect")) {
    const out = setKey(toml, "protect", "instructions", String(on), note);
    return { toml: out, changed: out !== toml };
  }
  if (!on) return { toml, changed: false };
  const cr = toml.includes("\r\n") ? "\r" : "";
  let at = lines.findIndex((l) => /^roles\./.test(RE_HEADER.exec(stripComment(l).trim())?.[1] ?? ""));
  const block = [`[protect]${cr}`, `instructions = true   ${stamp(note)}${cr}`, cr];
  if (at === -1) {
    // Unreachable for a policy that loads (it has roles), kept total anyway.
    const sep = toml.endsWith("\n") || !toml ? "" : "\n";
    return { toml: `${toml}${sep}\n${block[0]}\n${block[1]}\n`, changed: true };
  }
  while (at > 0 && /^\s*#/.test(lines[at - 1])) at--;
  lines.splice(at, 0, ...block);
  return { toml: lines.join("\n"), changed: true };
}

/** Which roles may write each family after the edit. `null`: nothing protects it. */
export function accessOf(config) {
  const roles = Object.values(config.roles);
  return {
    ide: roles.filter((r) => r.controlFiles.includes("ide")).map((r) => r.name),
    instructions: config.protect?.instructions
      ? roles.filter((r) => r.controlFiles.includes("instructions")).map((r) => r.name)
      : null,
  };
}

/** A role's denyWrite, each entry with the reason denyFor gives for it. */
function deniesOf(config, name) {
  const why = new Map();
  try { for (const e of denyFor(config, config.roles[name])) why.set(e.path, e.why); } catch {}
  const list = settingsFor(config, name).filesystem?.denyWrite ?? [];
  return new Map(list.map((p) => [p, why.get(p) ?? "never_writes, or a runtime default"]));
}

/**
 * What the edit changes in each role's sandbox profile, by denyWrite entry.
 *
 * Computed from the two policies as `seisin run` would build them — settingsFor
 * over the text before and the text after — never from a description of the
 * families. A role whose territory holds no project where these files could
 * be gets an empty diff, and that is the honest answer: the toggle changes
 * nothing for it today.
 */
export function profileDiff(before, after, names) {
  return names.map((name) => {
    try {
      const a = deniesOf(before, name);
      const b = deniesOf(after, name);
      return {
        role: name,
        added: [...b].filter(([p]) => !a.has(p)).map(([path, why]) => ({ path, why })),
        removed: [...a].filter(([p]) => !b.has(p)).map(([path, why]) => ({ path, why })),
      };
    } catch (e) {
      return { role: name, error: e.message, added: [], removed: [] };
    }
  });
}

/**
 * One edit, described without writing it: the new text, and what it changes.
 *
 * The new text is loaded with the real loader against the real root, so an
 * edit that would leave a policy that no longer loads is refused here, before
 * anything is written.
 */
export function planEdit(config, text, edit) {
  let result;
  if (edit.kind === "role") {
    if (typeof edit.role !== "string" || !Object.hasOwn(config.roles, edit.role))
      throw bad(`unknown role ${JSON.stringify(edit.role)}`);
    result = applyControlFiles(text, edit.role, edit.families, edit.reason);
  } else {
    result = applyProtect(text, edit.on, edit.reason);
  }
  let after;
  try { after = loadConfig(config.path, result.toml); }
  catch (e) { throw bad(`the edited policy would not load, so nothing was written: ${e.message}`); }
  const names = edit.kind === "role" ? [edit.role] : Object.keys(config.roles);
  const diff = result.changed ? profileDiff(config, after, names).filter((d) => d.error || d.added.length || d.removed.length) : [];
  return {
    changed: result.changed,
    toml: result.toml,
    base: hashOf(text),
    diff,
    access: accessOf(after),
    protect: { instructions: after.protect.instructions },
    ...(edit.kind === "role" && { role: edit.role, controlFiles: after.roles[edit.role].controlFiles }),
  };
}
