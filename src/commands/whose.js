/**
 * `seisin whose <path>` — the lookup a confined process is allowed to run.
 *
 * The README's opening claim is that a refusal names an owner. That is true
 * through the hook, and false for anyone who only wraps a process: the kernel
 * carries no reason, so the child sees `Operation not permitted` and guesses.
 * Measured in the field twice — an agent diagnosed a territory denial as
 * "possibly sandbox restrictions on macOS", which is a plausible sentence and
 * the wrong one.
 *
 * This closes it without any integration at all. The instruction becomes "on
 * EPERM, ask whose it is", which any agent can follow, and the answer comes
 * from the same config the boundary was built from.
 *
 * It reads and prints. There is deliberately nothing here that could make it
 * worth attacking, because unlike everything else in this tool it is meant to
 * be called *from inside* the box.
 */
import { ownersOf, keyHolders } from "../owners.js";
import { twinsOf, whereIs } from "../worktree.js";
import { C, out } from "../render.js";

export function whose(config, argv = []) {
  const target = argv[0];
  if (!target) throw new Error("usage: seisin whose <path>");

  const rel = target.startsWith(config.root + "/") ? target.slice(config.root.length + 1) : target;
  const isKey = (config.keyDirs ?? []).some((d) => rel === d || rel.startsWith(d + "/"));
  const owners = isKey ? keyHolders(config, rel) : ownersOf(config, rel);

  // Who is asking, when there is one. A confined child has it in its
  // environment; a person at a prompt does not, and neither case is an error.
  const asking = process.env.SEISIN_ROLE;
  const mine = asking && owners.includes(asking);

  // A key is a file in a declared directory, not a place in a checkout, so a
  // worktree has nothing to say about one.
  const worktree = isKey ? [] : elsewhere(config, rel, owners);

  if (owners.length === 0) {
    out(
      `\n  ${C.yellow}nobody${C.off} owns ${C.b}${rel}${C.off}\n` +
      `  ${C.dim}No role can ${isKey ? "read" : "write"} it until one claims it in ${config.path}.${C.off}\n\n`
    );
    for (const w of worktree) out(renderElsewhere(w, asking));
    return { target: rel, owners: [], mine: false, worktree };
  }

  const verb = isKey ? "is declared for" : "belongs to";
  out(
    `\n  ${C.b}${rel}${C.off} ${verb} ${C.b}${owners.join(", ")}${C.off}\n` +
    (mine
      ? `  ${C.green}that is you${C.off}${C.dim} — if it was refused, the reason is not ownership.${C.off}\n\n`
      : asking
        ? `  ${C.dim}you are ${asking}. Hand it over rather than working around it.${C.off}\n\n`
        : "\n")
  );
  for (const w of worktree) out(renderElsewhere(w, asking));
  return { target: rel, owners, mine, worktree };
}

/**
 * The same file in the other checkouts of this repo, when it is owned
 * differently there.
 *
 * This is the line the EPERM was missing. An agent refused inside a worktree
 * asks whose the file is, hears "nobody", and concludes the map has a hole —
 * when the map is fine and names the canonical checkout. A twin owned exactly
 * the same way says nothing new and gets no line.
 */
function elsewhere(config, rel, owners) {
  const { here, twins } = twinsOf(config, rel);
  const sameOwners = (a, b) => a.length === b.length && a.every((o) => b.includes(o));
  return twins
    .map((t) => ({ ...t, owners: ownersOf(config, t.rel) }))
    .filter((t) => !sameOwners(t.owners, owners))
    .map((t) => ({ ...t, here, where: whereIs(config, here, t), askedOwners: owners }));
}

function renderElsewhere(t, asking) {
  const kind = (c) => (c.worktree ? "the worktree" : "the canonical checkout");
  const there = t.owners.length
    ? `belongs to ${t.owners.join(", ")}` + (asking && t.owners.includes(asking) ? ` — that is you` : "")
    : "has no owner";
  const named =
    t.owners.length && t.askedOwners.length
      ? "The two checkouts are not owned by the same role."
      : `The policy names ${kind(t.owners.length ? t : t.here)}, not ${kind(t.owners.length ? t.here : t)}.`;
  return (
    `  ${C.yellow}worktree${C.off}  ${t.where}\n` +
    `  ${C.dim}          the same file there is ${C.off}${C.b}${t.rel}${C.off}${C.dim}, and it ${there}.\n` +
    `            ${named}${C.off}\n\n`
  );
}
