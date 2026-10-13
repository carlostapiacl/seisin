/**
 * `tartaros`: the Seatbelt / Landlock sandbox, driven by its own CLI.
 *
 * seisin's settings are richer than tartaros's flags, so this is a translation,
 * and the translation is held to the rule in docs/decisions.md: a role runs
 * under tartaros only when tartaros enforces every part of its settings **and
 * nothing more**. What it cannot say is returned by `unmet`, each part in a
 * sentence, and the run either takes the next sandbox the config lists or
 * refuses to start. Narrowing is allowed (a grant on a path that does not exist
 * is dropped); widening never is.
 *
 * What the flags can say, and so what is checked here:
 *
 *   - writes: `--write <path>` per writable root. Everything else is denied,
 *     except `/dev`, which tartaros grants every run. A denied write therefore
 *     needs no flag when it lies outside every root, and cannot be said when it
 *     lies inside one: tartaros has no way to deny a path inside a writable root
 *     beyond its own trust-handoff set.
 *   - reads: everything is readable but `--read-deny <path>`. A read re-opened
 *     inside a denied path (this run's own directory inside the runs root, a key
 *     inside its key directory) cannot be said.
 *   - network: denied, or loopback ports with `--port`. Domains cannot be said,
 *     nor listening (`local_binding`).
 *   - unix sockets: on Linux `--deny-unix` refuses them all, which is what the
 *     settings ask there (the audit channel is a FIFO). On macOS the audit
 *     channel IS a unix socket, and tartaros has no flag to allow exactly one.
 *
 * Globs are not a tartaros notion at all: a pattern in any list is unmet.
 */
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { realOrSelf } from "../grants.js";
import { WILD } from "../paths.js";

/** The ones tartaros grants every run, outside any `--write`. */
const ALWAYS_WRITABLE = ["/dev"];

const under = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");
/** Both spellings, so `/tmp/x` and `/private/tmp/x` meet. */
const forms = (p) => [...new Set([p, realOrSelf(p)])];
const inside = (p, roots) => roots.find((r) => forms(p).some((a) => forms(r).some((b) => under(a, b))));

/** `localhost:8001`, `127.0.0.1:8001` and `[::1]:8001` are a port; anything else is a domain. */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)$/;

export function portsOf(domains = []) {
  const ports = new Set(), others = [];
  for (const d of domains ?? []) {
    const m = String(d).match(LOOPBACK);
    if (m) ports.add(Number(m[1]));
    else others.push(d);
  }
  return { ports: [...ports].sort((a, b) => a - b), others };
}

/** The parts of `settings` tartaros cannot enforce, one sentence each. Empty means all of it. */
export function tartarosUnmet(settings, { platform = process.platform, exists = existsSync } = {}) {
  const out = [];
  if (platform !== "darwin" && platform !== "linux") return [`tartaros runs on macOS and Linux, not ${platform}`];
  const fs = settings.filesystem ?? {};
  const net = settings.network ?? {};

  const globs = ["allowWrite", "denyWrite", "denyRead", "allowRead"]
    .flatMap((k) => (fs[k] ?? []).filter((p) => WILD.test(p)).map((p) => `${k} ${p}`));
  if (globs.length) out.push(`a path pattern (${globs.slice(0, 3).join(", ")}${globs.length > 3 ? ", …" : ""}): tartaros takes paths, not globs`);

  const roots = [...(fs.allowWrite ?? []).filter((p) => !WILD.test(p) && exists(p)), ...ALWAYS_WRITABLE];
  const deniedInside = (fs.denyWrite ?? []).filter((p) => !WILD.test(p)).map((p) => [p, inside(p, roots)]).filter(([, r]) => r);
  if (deniedInside.length)
    out.push(`a write denied inside a writable path (${deniedInside.slice(0, 3).map(([p, r]) => p === r ? p : `${p} in ${r}`).join(", ")}` +
      `${deniedInside.length > 3 ? `, and ${deniedInside.length - 3} more` : ""}): tartaros cannot deny a path inside one it lets the role write`);

  const denied = (fs.denyRead ?? []).filter((p) => !WILD.test(p));
  const reopened = (fs.allowRead ?? []).filter((p) => !WILD.test(p)).map((p) => [p, inside(p, denied)]).filter(([, d]) => d);
  if (reopened.length)
    out.push(`a read re-opened inside a denied path (${reopened.slice(0, 3).map(([p, d]) => `${p} in ${d}`).join(", ")}` +
      `${reopened.length > 3 ? `, and ${reopened.length - 3} more` : ""}): tartaros cannot allow a path inside one it denies`);

  const { others } = portsOf(net.allowedDomains);
  if (others.length)
    out.push(`network by domain (${others.slice(0, 3).join(", ")}${others.length > 3 ? ", …" : ""}): tartaros grants loopback ports or the whole network, not domains`);
  if (net.allowLocalBinding) out.push("listening on localhost (local_binding): tartaros grants outbound loopback ports only");
  if (platform === "darwin" && (net.allowUnixSockets ?? []).length)
    out.push(`one unix socket (${net.allowUnixSockets[0]}, this run's audit channel): tartaros on macOS cannot allow a single socket`);
  return out;
}

/**
 * The command line. Only called once `tartarosUnmet` is empty, so every list
 * here is one tartaros can take as it is. Writable roots that do not exist are
 * dropped — a grant on nothing is narrower, and tartaros resolves each root.
 */
export function tartarosArgv(bin, settings, inner, { role = null, platform = process.platform, exists = existsSync } = {}) {
  const fs = settings.filesystem ?? {};
  const args = [bin, "run"];
  if (role) args.push("--role", role);
  for (const p of fs.allowWrite ?? []) if (exists(p)) args.push("--write", p);
  for (const p of fs.denyRead ?? []) args.push("--read-deny", p);
  for (const port of portsOf(settings.network?.allowedDomains).ports) args.push("--port", String(port));
  if (platform === "linux") args.push("--deny-unix");
  return [...args, "--", ...inner];
}

/** `tartaros` on PATH, or null. */
export function resolveTartaros(path = process.env.PATH) {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "tartaros");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const tartaros = {
  name: "tartaros",
  locate: () => resolveTartaros(),
  missing: () => "tartaros not found on PATH. Build it (cargo build --release -p tartaros-cli) and put its target directory on PATH.",
  unmet: (settings, ctx) => tartarosUnmet(settings, ctx),
  wrap: (bin, _file, settings, inner, ctx) => tartarosArgv(bin, settings, inner, ctx),
  tagsDenials: false,
};
