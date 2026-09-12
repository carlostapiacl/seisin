#!/usr/bin/env node
/**
 * Turns a cell config into a seisin.toml.
 *
 *   node adapters/equipo-conf.js <path/to/cell.conf> [--root <repo root>]
 *
 * This adapter exists because of a rule worth stating: seisin does not grow a
 * second config format to accommodate one user. If you already declare who owns
 * what somewhere else, you translate it here, and the tool stays one file with
 * one shape for everybody.
 *
 * It reads `[propiedad]` (rol | writable globs) and, if present, `[claves]`
 * (rol | readable key files). `[claves]` is the section this whole thing was
 * designed around and it may well not exist yet — in that case every role comes
 * out with no keys, which is the correct starting policy anyway: deny, then
 * grant deliberately.
 */
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const [file, ...flags] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  process.stderr.write("usage: equipo-conf.js <cell.conf> [--root <repo root>] [--relative-to <dir under root>]\n");
  process.exit(2);
}
const flag = (name) => {
  const i = flags.indexOf(name);
  return i === -1 ? "" : flags[i + 1] ?? "";
};
const root = flag("--root");

/**
 * Where the emitted paths should be relative to.
 *
 * The territory in a cell config is written from the portfolio root, so a
 * seisin.toml placed inside a cell resolves every path one level too deep and
 * silently grants nothing that exists. Found twice — once here and once in a
 * field report from a user who hit it in the lab — which is enough to make it
 * a flag rather than a footnote.
 */
const relativeTo = flag("--relative-to");

const text = readFileSync(file, "utf8");
const cell = basename(file).replace(/\.conf$/, "");

/** Rows of `name | value value value` inside one `[section]`. */
function section(name) {
  const out = {};
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { inside = line === `[${name}]`; continue; }
    if (!inside || !line || line.startsWith("#") || !line.includes("|")) continue;
    const [who, ...rest] = line.split("|");
    const key = who.trim();
    if (key) out[key] = rest.join("|").trim().split(/\s+/).filter(Boolean);
  }
  return out;
}

/** A `KEY="value"` line at the top of the file. */
function scalar(name) {
  const m = new RegExp(`^${name}\\s*=\\s*"?([^"\\n]*)"?`, "m").exec(text);
  return m ? m[1].trim() : "";
}

const territory = section("propiedad");
const keys = section("claves");
const noGit = new Set(scalar("SIN_GIT").split(/\s+/).filter(Boolean));

const roles = Object.keys(territory);
if (roles.length === 0) {
  process.stderr.write(`${file}: no [propiedad] rows found\n`);
  process.exit(1);
}

/**
 * One path, rewritten from the repository root to `relativeTo`.
 *
 * The `..` escape is the whole point. A territory does not have to stay inside
 * the cell — ours does not: a role owns its work tree under the cell and its
 * handover note in the engine's log directory one level up. The first version
 * rewrote what fell under the base and returned everything else unchanged,
 * which put two different bases in one file. Both entries read as correct and
 * the file could not be: from the cell, the root-relative one does not exist.
 *
 * Nothing failed. The role simply did not get the territory it was granted, and
 * the only symptom was whatever the agent did when a write it expected to work
 * came back refused — which is the exact failure mode this tool exists to end.
 */
const escapesUsed = [];

const strip = (p) => {
  const fromRoot = root && p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, "") : p;
  if (!relativeTo) return fromRoot;
  const base = relativeTo.replace(/^\/+|\/+$/g, "");
  if (fromRoot === base) return ".";
  if (fromRoot.startsWith(base + "/")) return fromRoot.slice(base.length + 1);

  // Outside the base: walk up as far as the common prefix, then down.
  const from = base.split("/").filter(Boolean);
  const to = fromRoot.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  const out = [...Array(from.length - i).fill(".."), ...to.slice(i)].join("/");
  escapesUsed.push(`${fromRoot}  →  ${out}`);
  return out;
};

const out = [
  `# Generated from ${basename(file)} by adapters/equipo-conf.js`,
  `# Cell: ${cell} · ${roles.length} role(s)`,
  `#`,
  `# Review before use. The territory below is what the cell already enforces;`,
  `# the keys are only as good as the [claves] section it was read from.`,
  ``,
];

if (Object.keys(keys).length) out.push(`# [keys]`, `# dir = "02-confidencial/keys"`, ``);
else out.push(
  `# No [claves] section in the source, so no role gets a key. That is the right`,
  `# default: grant them one at a time and you will notice which ones nobody needs.`,
  ``);

// The agent's own API first: without it the agent fails to authenticate and
// never reaches the policy this file is about.
out.push(
  `[network]`,
  `# This list is Claude's. A role running a different agent needs that agent's`,
  `# host added, or it sits in a perfect territory unable to reach its own model.`,
  `allow = [`,
  `  "api.anthropic.com", "*.anthropic.com",`,
  `  "github.com", "*.github.com",`,
  `  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"`,
  `]`,
  ``,
);

for (const role of roles) {
  const writes = territory[role].map(strip);
  const own = (keys[role] ?? []).map((k) => k.replace(/^.*\//, ""));
  out.push(`[roles.${role}]`);
  out.push(`writes = [${writes.map((w) => `"${w}"`).join(", ")}]`);
  out.push(`keys   = [${own.map((k) => `"${k}"`).join(", ")}]`);
  if (noGit.has(role)) out.push(`# no git in the source config: this role only reads and writes its own notes`);
  out.push(``);
}

// Say it where the reviewer is already looking. A territory that leaves the
// cell is a real thing to declare, and a `..` that appears without comment is
// the kind of line someone deletes as a typo.
if (escapesUsed.length) {
  out.splice(5, 0,
    `# ${escapesUsed.length} path(s) reach outside ${relativeTo} and are written as escapes:`,
    ...escapesUsed.map((e) => `#   ${e}`),
    ``);
}

process.stdout.write(out.join("\n"));
