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

const strip = (p) => {
  const fromRoot = root && p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, "") : p;
  if (!relativeTo) return fromRoot;
  const base = relativeTo.replace(/^\/+|\/+$/g, "");
  if (fromRoot === base) return ".";
  return fromRoot.startsWith(base + "/") ? fromRoot.slice(base.length + 1) : fromRoot;
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

process.stdout.write(out.join("\n"));
