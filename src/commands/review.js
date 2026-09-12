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

  if (!r.friction.length && !r.unused.length && !r.unowned.length)
    out(`\n  ${C.green}nothing to report${C.off} ${C.dim}— no repeated blocks, no dead grants, no unowned paths${C.off}\n`);

  out("\n");
  return r;
}
