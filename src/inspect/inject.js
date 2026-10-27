/**
 * Warnings for `key_mode = "inject"`: the MITM it costs, the traffic it
 * widens, the one thing it does not close, and the platform it does not run on.
 *
 * Masking is the only mode where the agent never sees the value, and it is the
 * only one that reads the role's encrypted traffic to do it. A reader of
 * `check` should see, per masked credential: which hosts are intercepted (and
 * when a wildcard allow drags more than the one host under interception), that
 * the value is still recoverable by reflection, and — off Linux — that the role
 * will not run here. None of this is a reason not to use inject; it is the
 * price printed next to the thing it buys.
 */
import { injectKeysOf } from "../keys.js";
import { sandboxesOf } from "../sandboxes/index.js";
import { coversHost as covers } from "../srt.js";

export function injectWarnings(config, roles) {
  const out = [];
  for (const r of roles) {
    let inject;
    try {
      inject = injectKeysOf(config, r);
    } catch (e) {
      const [headline, ...rest] = e.message.split("\n");
      out.push({ kind: "cannot-be-enforced", role: r.name, headline, detail: rest.join("\n").trim() });
      continue;
    }
    if (inject.length === 0) continue;
    const allowed = r.network ?? config.allowedDomains ?? [];

    // Which sandbox masks is the sandbox's to say (sandboxes/, `masks`): on macOS
    // only tartaros does, so a provider list without it cannot run the role here.
    const names = sandboxesOf(config).map((s) => s.name);
    if (process.platform === "darwin" && !names.includes("tartaros"))
      out.push({
        kind: "inject-platform",
        role: r.name,
        headline: `${r.name}: key_mode = "inject" needs tartaros on macOS — [sandbox] provider is ${names.join(", ")}`,
        detail: `On macOS sandbox-runtime does not mask credentials yet (anthropics/sandbox-runtime#593), so ` +
          `this role will not run here. Add tartaros: [sandbox] provider = ["tartaros", "srt"]. Or run it on ` +
          `Linux, or use "env"/"run-file" here.`,
      });
    else if (process.platform !== "linux" && process.platform !== "darwin")
      out.push({
        kind: "inject-platform",
        role: r.name,
        headline: `${r.name}: key_mode = "inject" is not available on ${process.platform}`,
        detail: `No sandbox seisin runs here masks credentials. Run this role on Linux or macOS, or use "env"/"run-file".`,
      });

    for (const c of inject) {
      const terminated = new Set();
      const wholesale = [];
      for (const h of c.hosts)
        for (const p of allowed)
          if (covers(p, h)) {
            terminated.add(p);
            if (p.startsWith("*.")) wholesale.push({ pattern: p, host: h });
          }
      const under = [...terminated].join(", ") || "(none reachable — check network)";
      const wildcardNote = wholesale.length
        ? ` The wildcard ${wholesale.map((w) => w.pattern).join(", ")} is terminated whole, not just ` +
          `${wholesale.map((w) => w.host).join(", ")}: srt cannot intercept one host out of a wildcard.`
        : "";
      out.push({
        kind: "inject-mitm",
        role: r.name,
        headline: `${r.name}: ${c.name} is masked (agent sees a fake); TLS terminated for ${under}`,
        detail:
          `seisin reads this role's HTTPS to ${under} with a CA of its own, to substitute the real token ` +
          `on the way out.${wildcardNote} The token is still recoverable by reflection: if ${c.hosts.join("/")} ` +
          `stores what the agent sends and returns it later (an issue, a gist, a comment, a note), the agent ` +
          `can POST the sentinel, have the host keep the real value, and read it back. inject stops the agent ` +
          `from seeing the token directly and from sending it anywhere else — not this. Use a least-scope token.`,
      });
    }
  }
  return out;
}
