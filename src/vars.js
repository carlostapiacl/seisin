/**
 * `--var NAME=value`: the few paths and ports one policy cannot know in advance.
 *
 * A launcher starts many runs from one policy, and each run has its own folder
 * and its own ports. Those are not decisions about who may do what, so they
 * should not be a reason to write a policy per run. A role names them
 * (`reads = ["$RUN/config"]`, `local_ports = ["$MCP_PORT"]`) and the run says
 * what they are.
 *
 * Only the fields in EXPANDED take a variable, and every one of them is a place
 * the role reads or connects to. Nothing that seisin itself executes in the
 * parent does: not `[keys.providers]`, not `[sandbox.providers]`. A value given
 * on a command line must never decide what runs outside the sandbox.
 */
const NAME = /^[A-Z][A-Z0-9_]*$/;
const REF = /\$([A-Z][A-Z0-9_]*)/g;
const ROLE_FIELDS = ["reads", "toolchain", "local_ports", "verify"];

let current = new Map();

/** `--var NAME=value`, every one of them, for this process. */
export function setVars(list) {
  const vars = new Map();
  for (const item of list) {
    const at = item.indexOf("=");
    const name = at === -1 ? item : item.slice(0, at);
    const value = at === -1 ? "" : item.slice(at + 1);
    if (!NAME.test(name))
      throw new Error(`--var ${item}: the name is capitals, digits and "_", and starts with a capital`);
    if (!value || /[\n\r\0]/.test(value))
      throw new Error(`--var ${name}: needs a value on one line, NAME=value`);
    if (vars.has(name) && vars.get(name) !== value)
      throw new Error(`--var ${name}: given twice with different values`);
    vars.set(name, value);
  }
  current = vars;
}

export const varNames = () => [...current.keys()];

/** One entry with its variables filled in, and the names nobody gave. */
function fill(value, vars, missing) {
  if (typeof value !== "string") return value;
  const out = value.replace(REF, (whole, name) => {
    if (vars.has(name)) return vars.get(name);
    missing.push(name);
    return whole;
  });
  return out;
}

/** A list with its variables filled in; an entry with a name nobody gave is left out and reported. */
function expandList(list, vars, where, unbound, { whole = false, port = false } = {}) {
  if (!Array.isArray(list)) return list;
  const out = [];
  let lost = false;
  for (const entry of list) {
    const missing = [];
    const value = fill(entry, vars, missing);
    if (missing.length) {
      for (const name of missing) unbound.push({ where, name });
      lost = true;
      continue;
    }
    out.push(port && typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
  }
  // A command missing one word is a different command, so it goes whole.
  return whole && lost ? undefined : out;
}

/**
 * Fills the variables of a parsed policy, in place, and returns what stayed
 * unbound as `{ where, name, role? }`.
 *
 * A policy with `$RUN` in it has to stay readable by `check`, `explain` and the
 * MCP server, which have no run to ask: for them an entry nobody gave a value is
 * left out, and `check` says so. `seisin run` refuses instead (narrow.js).
 */
export function expandVars(parsed, vars = current) {
  const unbound = [];
  const runtime = parsed?.runtime;
  if (runtime && Object.hasOwn(runtime, "writes"))
    runtime.writes = expandList(runtime.writes, vars, "runtime.writes", unbound);
  const roles = parsed?.roles;
  if (!roles || typeof roles !== "object") return unbound;
  for (const role of Object.keys(roles)) {
    const r = roles[role];
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const before = unbound.length;
    for (const field of ROLE_FIELDS) {
      if (!Object.hasOwn(r, field)) continue;
      const list = expandList(r[field], vars, `roles.${role}.${field}`, unbound,
        { whole: field === "verify", port: field === "local_ports" });
      if (list === undefined) delete r[field];
      else r[field] = list;
    }
    for (let i = before; i < unbound.length; i++) unbound[i].role = role;
  }
  return unbound;
}
