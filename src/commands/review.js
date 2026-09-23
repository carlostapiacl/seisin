/**
 * `seisin review` — what the log says about the policy.
 *
 * The counterpart to `check`. `check` reads the config and tells you what it
 * would do; this reads what actually happened and tells you where the config
 * was wrong about it. Both run nothing.
 *
 * Exits 1 when there is friction, so it composes — a role blocked over and over
 * is a thing to fix, and a CI job that says so beats a human noticing in a
 * month. Unused grants and unowned paths exit 0: they are worth reading, not
 * worth failing a build over.
 *
 * A role held at a `[keys] dir` exits 0 too, and deliberately. That is the
 * boundary doing exactly what it was configured to do; failing a build over it
 * would mean a correct policy cannot go green.
 */
import { review } from "../review.js";
import { C, out } from "../render.js";

export function reviewCommand(config, argv = []) {
  const i = argv.indexOf("--min");
  const r = review(config, { minDenials: i === -1 ? 3 : Number(argv[i + 1]) });

  if (!r.entries) {
    out(`\n  ${C.dim}nothing recorded yet. Run an agent through seisin first.${C.off}\n\n`);
    return r;
  }

  const day = (s) => (s ?? "").slice(0, 10);
  out(`\n  ${C.dim}${r.entries} decisions, ${day(r.window.from)} to ${day(r.window.to)}${C.off}\n`);

  if (r.friction.length) {
    out(`\n  ${C.b}Stopped, repeatedly${C.off}\n`);
    out(`  ${C.dim}a role blocked on the same place over and over is a policy that is wrong,${C.off}\n`);
    out(`  ${C.dim}not an agent that is misbehaving${C.off}\n\n`);
    for (const f of r.friction) {
      const whose = f.owners.length ? ` ${C.dim}— belongs to ${f.owners.join(", ")}${C.off}` : "";
      out(`    ${C.yellow}${String(f.times).padStart(4)}×${C.off}  ${C.b}${f.role}${C.off} ${f.action} ${f.where}${whose}\n`);
    }
    out(`\n  ${C.dim}seisin grant, or move the territory. Either way it is a decision, not noise.${C.off}\n`);
  }

  /**
   * The same repetition, and the opposite conclusion.
   *
   * A key directory is closed to everyone rather than held by somebody, so
   * there is no owner to name and no handoff to make — and printing it under
   * the advice above turned the loudest thing this command says into *grant
   * two roles the credential directory*. Separated, the same lines read as
   * confirmation instead of as a recommendation, which is what they are.
   */
  /**
   * Connections, apart from both of the above: a port is not a territory, so
   * "grant, or move the territory" does not answer it, and it is not the policy
   * working either when the service is one the role was meant to reach.
   */
  if (r.connects?.length) {
    out(`\n  ${C.b}Refused connections${C.off}\n`);
    out(`  ${C.dim}a local port or socket the role kept dialling. Not a grant: a port goes in${C.off}\n`);
    out(`  ${C.dim}local_ports, and a socket stays closed${C.off}\n\n`);
    for (const c of r.connects)
      out(`    ${C.yellow}${String(c.times).padStart(4)}×${C.off}  ${C.b}${c.role}${C.off} ${c.where}\n`);
    out(`\n  ${C.dim}seisin walls <role> says, per target, which of the two it is.${C.off}\n`);
  }

  if (r.guarded.length) {
    out(`\n  ${C.b}Held at the keys${C.off}\n`);
    out(`  ${C.dim}a [keys] dir is closed to every role, so this is the policy working${C.off}\n`);
    out(`  ${C.dim}— not a territory drawn wrong, and never a thing to grant${C.off}\n\n`);
    for (const g of r.guarded)
      out(`    ${C.dim}${String(g.times).padStart(4)}×${C.off}  ${C.b}${g.role}${C.off} ${g.action} ${g.where}\n`);
    out(`\n  ${C.dim}Worth a look only if a role genuinely needs one of these: that is a${C.off}\n`);
    out(`  ${C.dim}\`keys\` line for the file, never a write grant on the directory.${C.off}\n`);
  }

  /**
   * Says why it cannot answer, instead of answering wrongly.
   *
   * Without the hook the log holds denials and nothing else, so every grant
   * looks dead. The old text called itself the only evidence anyone will ever
   * have for making a permission file smaller, printed over the whole policy.
   */
  if (!r.unusedKnowable) {
    out(`\n  ${C.b}Granted, never used${C.off} ${C.dim}— cannot be answered from this log${C.off}\n`);
    out(`  ${C.dim}nothing here records what was ALLOWED, only what was refused. Every grant${C.off}\n`);
    out(`  ${C.dim}would look dead, so nothing is listed. Run \`seisin wire\` and come back.${C.off}\n`);
  }

  if (r.unused.length) {
    out(`\n  ${C.b}Granted, never used${C.off}\n`);
    out(`  ${C.dim}nothing was written here in the window above. This is the only evidence${C.off}\n`);
    out(`  ${C.dim}anyone will ever have for making a permission file smaller${C.off}\n\n`);
    for (const u of r.unused) out(`    ${C.b}${u.role}${C.off}  ${u.glob}\n`);
    out(`\n  ${C.dim}A short window proves nothing. Check the dates before you delete a line.${C.off}\n`);
  }

  if (r.unowned.length) {
    out(`\n  ${C.b}Owned by nobody${C.off}\n`);
    out(`  ${C.dim}touched by an agent, claimed by no role — holes in the map${C.off}\n\n`);
    for (const u of r.unowned.slice(0, 10)) out(`    ${String(u.times).padStart(4)}×  ${u.where}\n`);
  }

  if (!r.friction.length && !r.guarded.length && !r.unused.length && !r.unowned.length && r.unusedKnowable)
    out(`\n  ${C.green}nothing to report${C.off} ${C.dim}— no repeated blocks, no dead grants, no unowned paths${C.off}\n`);

  out("\n");
  return r;
}
