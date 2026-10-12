import { covers, enforcedNeverWrites } from "../owners.js";
import { ROLE_KEYS, closest } from "../config.js";
import { territoryWarnings } from "./read-territory.js";

/**
 * What is wrong with a role table's keys, as opposed to its paths.
 *
 * Two things, both about `never_writes` and both ways a subtraction can look
 * written and not be:
 *
 *   - a setting seisin does not know. It used to be dropped without a word, which
 *     for `writes` is a role with less than it thinks, and for a misspelt
 *     `never_writes` is a role with MORE than its owner thinks — the one
 *     direction a policy must not fail in. Named with the nearest
 *     known setting when there is one close enough to be the intended spelling.
 *   - a `never_writes` entry that no `writes` of the same role covers. It
 *     subtracts from nothing, so it is either a typo in the path or a rule
 *     that stopped applying when the territory moved. Either way it reads as
 *     protection and is not.
 *
 * Silent when `never_writes` is absent. Absent is valid; a check that asks for
 * the setting would turn an optional subtraction into a required migration.
 */
export function roleKeyWarnings(roles, config = null) {
  const warnings = [];
  for (const r of roles) {
    const enforced = new Set(enforcedNeverWrites(config, r));
    const skipped = (r.neverWritesDeclared ?? r.neverWrites ?? []).filter((g) => !enforced.has(g));
    if (skipped.length)
      warnings.push({
        kind: "never-writes-not-enforced-here",
        headline: `${r.name}: never_writes ${skipped.join(" ")} — not enforced on Linux until it exists`,
        detail: "bubblewrap denies a path by mounting over it, and would create a missing one on the host " +
          "for the whole run — for a lock file, locking everyone else out, and for good if the role is " +
          "killed. seisin skips those, and explain says allowed for them, so the sentence matches the kernel.",
      });
    for (const k of r.unknownKeys ?? []) {
      const near = nearest(k, ROLE_KEYS);
      warnings.push({
        kind: "unknown-role-key",
        headline: `${r.name}: unknown setting "${k}" in [roles.${r.name}] — ignored` +
          (near ? `. Did you mean "${near}"?` : ""),
        detail: `Known settings: ${ROLE_KEYS.join(", ")}. ` +
          (near === "never_writes"
            ? "As written this subtracts nothing: the role can still write every path it lists."
            : "Nothing in it takes effect."),
      });
    }
    warnings.push(...territoryWarnings(config, r));
    // A family handed to a role is a hole in the protection on purpose, and
    // said on every check so it stays a decision somebody can see.
    for (const f of r.controlFiles ?? [])
      warnings.push({
        kind: "control-files-handed",
        headline: f === "ide"
          ? `${r.name}: control_files = ["ide"] — may edit .vscode/, .cursor/ and .windsurf/ in its territory`
          : `${r.name}: control_files = ["instructions"] — may edit CLAUDE.md, AGENTS.md and their kin in its territory`,
        detail: f === "ide"
          ? "Your editor applies what it writes there — tasks, settings, auto-approval, MCP servers — outside the sandbox. " +
            "Hand it only to a role that maintains those files, and review its changes to them."
          : "The next agent session reads what it writes there as its instructions, whichever role that session is.",
      });
    // macOS only, and not by omission: on Linux the runtime removes the network
    // namespace, so every role already has a loopback of its own — it can serve
    // and reach its own server with or without the key, and reaches nothing on
    // the host either way (measured in Docker, Debian 12, bwrap 0.8.0).
    if (r.localBinding && process.platform === "darwin")
      warnings.push({
        kind: "local-binding-reaches-localhost",
        headline: `${r.name}: local_binding lets it connect to every port on localhost, not only listen`,
        detail: "The runtime grants bind on any interface, inbound, and outbound to localhost:*. " +
          "Anything listening on this machine without authentication — a local control API, a " +
          "database, a dev server — is within this role's reach, outside its territory.",
      });
    // Both at once is a config that says "these ports" and grants "every port".
    // macOS only: on Linux local_binding reaches nothing on the host, so there
    // local_ports is the only one of the two that does anything.
    if (r.localBinding && r.localPorts?.length && process.platform === "darwin")
      warnings.push({
        kind: "local-ports-moot",
        headline: `${r.name}: local_ports names ${r.localPorts.join(", ")}, but local_binding already opens every localhost port`,
        detail: "local_binding grants outbound to localhost:* in the kernel profile, so the port list " +
          "restricts nothing for this role. Drop local_binding if the role only needs to reach " +
          "those ports; keep it only if the role has to listen.",
      });
    // The port list lives in the runtime's proxy, not in the kernel: a client
    // that dials 127.0.0.1:N itself is refused even on a listed port. Said on
    // every check, because the clients people list ports for — databases,
    // caches — are mostly that kind. See docs/decisions.md.
    else if (r.localPorts?.length)
      warnings.push({
        kind: "local-ports-proxy-only",
        headline: `${r.name}: local_ports ${r.localPorts.join(", ")} reaches only clients that use HTTP_PROXY`,
        detail: "The port list is enforced by the sandbox's proxy; the kernel has no rule for one localhost port. " +
          "curl, Python's urllib and requests, and Node's fetch (22+) go through it. Database drivers, " +
          "psql, mysql and redis-cli dial directly and are denied. To tell, run it with " +
          `\`seisin run ${r.name} -- <client>\`: on macOS a \`connect tcp:<port>\` in \`seisin log\` means it ` +
          "skipped the proxy; on Linux it fails with ECONNREFUSED.",
      });
    // trustd is a macOS service; on Linux the key changes nothing.
    if (r.trustd && process.platform === "darwin")
      warnings.push({
        kind: "trustd-open",
        headline: `${r.name}: trustd = true opens com.apple.trustd.agent, a path out that the domain list does not see`,
        detail: "trustd verifies certificates for Go (before 1.27) and Dart on macOS, and to do it fetches, " +
          "outside the sandbox, the URLs a certificate carries. The runtime calls it an exfiltration vector; " +
          "no public demonstration exists. Go 1.27+ does not need it: seisin sets SSL_CERT_FILE.",
      });
    for (const g of r.neverWrites ?? []) {
      if (r.writes.some((w) => covers(w, g) || covers(w, g.replace(/\/\*\*$/, ""))))
        continue;
      warnings.push({
        kind: "never-writes-subtracts-nothing",
        headline: `${r.name}: never_writes "${g}" is not inside any of its writes`,
        detail: "It denies something that was already denied, so it protects nothing. " +
          "Check the path, or drop the entry if the territory moved.",
      });
    }
  }
  return warnings;
}

/** The candidate within edit distance 3 of `word`, or null. */
function nearest(word, candidates) {
  // Spellings of the same idea in another vocabulary, checked first because
  // letters mislead here: `no_writes` is three edits from `writes`, and
  // suggesting the grant for a misspelt subtraction is the worst answer.
  if (/deny|never|no_?write/i.test(word)) return "never_writes";
  return closest(word, candidates);
}
