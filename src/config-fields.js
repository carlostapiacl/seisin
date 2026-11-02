/**
 * The readers for each field of a role and of the runtime: one function per
 * field, each refusing what it cannot read with the name and place it came from.
 */
import { isIP } from "node:net";
import { join } from "node:path";
import { BROWSERS } from "./browsers.js";
import { own } from "./toml.js";

/** `a/b//` → `a/b`, in linear time (a `/\/+$/` regex backtracks on a long run of slashes). */
export const trimSlashes = (p) => {
  let end = p.length;
  while (end > 0 && p[end - 1] === "/") end--;
  return p.slice(0, end);
};

// The directory above a path's first glob character: "src/a*/b" gives "src", "a*" gives "".
export const beforeGlob = (p) => {
  const g = p.search(/[*?[\]{}]/);
  if (g < 0) return p;
  const slash = p.lastIndexOf("/", g);
  return slash < 0 ? "" : p.slice(0, slash);
};

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
export function distance(a, b) {
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
export function readBoolean(value, where) {
  if (value === undefined || typeof value === "boolean") return value;
  throw new Error(`${where} must be true or false, not ${JSON.stringify(value)}`);
}

/** The keys a `[roles.<name>]` table can hold. Anything else is reported by `check`. */
export const ROLE_KEYS = ["writes", "private", "keys", "key_mode", "inject_hosts", "env", "network", "never_writes", "local_binding", "local_ports", "browsers", "mcp", "trustd", "control_files", "reads", "toolchain", "verify", "handoff", "handoff_exempt", "requests"];

/**
 * `control_files`: which families of control files a role may edit. Refused at
 * load when it names anything else — `.claude`, git hooks and the rest are not
 * on the list on purpose, and a word the reader does not know must not load as
 * a permission it thinks it wrote.
 */
export const CONTROL_FAMILIES = ["ide", "instructions"];

export function readControlFiles(value, where) {
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
export function readProtect(value, path) {
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
export function readMcp(value, where) {
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
export function readBrowsers(value, where) {
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
export function readLocalPorts(value, where) {
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
 * `allowedDomains` is computed later (srt-settings.js), where the terminated set is.
 */
export function readInjectHosts(value, where) {
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
export function readNeverWrites(value, where) {
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
export function readPrivate(value, where) {
  const list = value === undefined ? [] : asArray(value, where);
  for (const p of list) {
    const dir = trimSlashes(p.replace(/\/\*\*$/, "")).replace(/^\.\//, "");
    if (p.startsWith("/"))
      throw new Error(`${where}: "${p}" is absolute. A private folder is relative to the repo root, like writes.`);
    if (dir.split("/").includes(".."))
      throw new Error(`${where}: "${p}" contains "..". A private folder is inside the repo.`);
    if (dir === "" || dir === "." || dir === "**")
      throw new Error(`${where}: "${p}" is the whole repo. A private folder is a folder inside it — ` +
        `"notes/**" — and every other role is denied it.`);
    if (/[*?[\]{}]/.test(dir))
      throw new Error(`${where}: "${p}" is a pattern. A private folder is one path and everything under it: ` +
        `write "${beforeGlob(dir) || "dir"}/**".`);
  }
  return list;
}

/** `private` with its `/**` and `./` taken off: the folder itself. */
export const privateDir = (p) => trimSlashes(p.replace(/\/\*\*$/, "")).replace(/^\.\//, "");

/**
 * One owner per private folder. Two roles naming the same folder, or one
 * inside the other, would each be denied the other's — so neither could read
 * its own. Refused at load, with both names.
 */
export function checkPrivateOverlap(roles, path) {
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
export function assertNotAbsolute(list, where) {
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
export function readAddresses(value, where) {
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

export function asArray(value, where) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  throw new Error(`${where}: expected a string or an array of strings`);
}
