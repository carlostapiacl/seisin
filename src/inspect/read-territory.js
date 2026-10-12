import { delimiter } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { keptFor, shutByTerritory, readPath, dataRoots } from "../territory.js";
import { realAncestor } from "../paths.js";

/**
 * What `read = "territory"` takes away from a role that it may need, said
 * before the run rather than discovered inside it.
 *
 * This is the answer to the objection decisions.md wrote against a read
 * allowlist: the toolchain gets one entry wrong and the agent crashes without
 * a reason. The mode leaves the system readable, so interpreters and libraries
 * are not the risk; what breaks is a toolchain kept under the home — a venv,
 * `~/.nvm`, `~/.pyenv` — and that is exactly what these name.
 */
export function territoryWarnings(config, r) {
  const out = [];
  const declared = [...(r.reads ?? []), ...(r.toolchain ?? [])];
  if (config.read !== "territory") {
    if (declared.length)
      out.push({
        kind: "reads-without-territory",
        headline: `${r.name}: reads / toolchain are set, but [runtime] read is "all" — they change nothing`,
        detail: 'Under read = "all" every file outside the denied ones is readable already. They take effect ' +
          'with [runtime] read = "territory".',
      });
    return out;
  }
  for (const p of r.toolchain ?? []) {
    const abs = readPath(config.root, p);
    if (!existsSync(abs))
      out.push({
        kind: "toolchain-missing",
        headline: `${r.name}: toolchain ${p} does not exist`,
        detail: `Looked for ${abs}. A role told to verify its work with a toolchain it does not have retries, ` +
          "installs and works around instead — measured at +80% cost per task, and no verification.",
      });
  }
  for (const p of r.reads ?? []) {
    const abs = readPath(config.root, p);
    if (!existsSync(abs))
      out.push({
        kind: "reads-missing",
        headline: `${r.name}: reads ${p} does not exist`,
        detail: `Looked for ${abs}. Remove a stale entry or create the path before relying on it.`,
      });
  }
  // A read grant that covers a whole home or data root turns the mode off for
  // this role without anything saying so: `reads = ["~"]` reads like a
  // detail and is every file the mode exists to shut.
  const roots = dataRoots();
  for (const p of declared) {
    const abs = realAncestor(readPath(config.root, p));
    const covered = roots.filter((root) => abs === "/" || root === abs || root.startsWith(abs + "/"));
    if (covered.length)
      out.push({
        kind: "territory-reopened",
        headline: `${r.name}: ${p} re-opens ${covered[0].replace(homedir(), "~") || "/"} whole — read = "territory" protects nothing there for this role`,
        detail: `${covered.join(", ")} ${covered.length === 1 ? "is a place" : "are places"} the mode denies because people keep their data there. ` +
          "Name the directory the role needs inside it instead.",
      });
  }
  const keep = keptFor(config, r);
  const path = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const shut = [...new Set(path.filter((d) => existsSync(d) && shutByTerritory(d, keep)))];
  if (shut.length)
    out.push({
      kind: "path-shut-by-territory",
      headline: `${r.name}: ${shut.length} PATH entr${shut.length === 1 ? "y is" : "ies are"} unreadable under read = "territory"`,
      detail: `Shut: ${shut.map((d) => d.replace(homedir(), "~")).join(", ")}. A program found there today ` +
        "falls through to another one inside the sandbox, or is not found. If the role needs one, name it " +
        `in toolchain: toolchain = ["${shut[0].replace(homedir(), "~").replace(/\/bin$/, "")}"].`,
    });
  /**
   * Claude Code keeps its sign-in in the macOS login keychain, which lives
   * under the home and is shut here. Measured 2026-10-09: the run starts and
   * says "Not logged in"; with ~/Library/Keychains in `reads` it signs in —
   * and the role can then read every item in the keychain (decisions.md,
   * the rejected keychain link), which is not offered. A token handed over as
   * a key keeps the keychain shut.
   */
  const tokenNames = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
  const hasToken = (r.keyEntries ?? []).some((k) => tokenNames.includes(k.name)) ||
    (r.env ?? []).some((e) => tokenNames.includes(e));
  if (process.platform === "darwin" && !hasToken)
    out.push({
      kind: "territory-keychain",
      headline: `${r.name}: under read = "territory" Claude Code cannot reach its sign-in in the login keychain`,
      detail: 'It starts and says "Not logged in". Hand it a token as a key instead — ' +
        'keys = ["CLAUDE_CODE_OAUTH_TOKEN=<provider>://…"] (from `claude setup-token`) or ANTHROPIC_API_KEY. ' +
        "Opening ~/Library/Keychains in reads signs it in and hands the role every password in the keychain.",
    });
  if (!r.verify)
    out.push({
      kind: "no-verify",
      headline: `${r.name}: no verify command — check --verify cannot prove this role can run its own checks`,
      detail: 'Name the command the role checks its work with: verify = ["python", "-m", "pytest", "--version"]. ' +
        "`seisin check --verify` then runs it inside the role's sandbox before any agent does.",
    });
  return out;
}
