/**
 * What the console and the MCP server both say about the log, computed once.
 *
 * The two readers are different — a person opens the console, an agent calls
 * the MCP — and they must not disagree about the same file. This held the
 * shared arithmetic inside serve.js, so the MCP server imported node:http to
 * group denials. Nothing here opens a socket or writes a file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { explain, standingOf } from "./owners.js";
import { kindsOf, KINDS } from "./kinds.js";
import { walls } from "./walls.js";
import { pending, requestsPath, markStale } from "./requests.js";

/**
 * An ISO date from what a person or an agent typed, or null for no filter.
 * Anything that does not parse is ignored rather than refused: a bad filter
 * should show everything, not an error.
 */
export function parseSince(raw) {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * `explain`, remembered while the policy file stays the same.
 *
 * Causes and walls ask the policy about every refused path, and a real log has
 * two thousand of them: ~0.75 ms each, most of the console's two-second poll.
 * The answer depends on the policy text, so that is the key — and a little on
 * the disk (on Linux a control file is protected only once it exists), so the
 * memory is dropped after a minute too, as standingOf does. A config that was
 * not read from a file gets a memory for this call only.
 */
const VERDICT_TTL = 60_000;
let verdictMemo = { key: null, at: 0, map: new Map() };

export function verdicts(cfg, { now = Date.now() } = {}) {
  let key = null;
  try {
    if (cfg.path) key = `${cfg.path}\u0000${createHash("sha256").update(readFileSync(cfg.path)).digest("hex")}`;
  } catch {}
  let map;
  if (key === null) map = new Map();
  else {
    if (verdictMemo.key !== key || now - verdictMemo.at > VERDICT_TTL) verdictMemo = { key, at: now, map: new Map() };
    map = verdictMemo.map;
  }
  return (c, role, action, target) => {
    const k = `${role}\u0000${action}\u0000${target}`;
    let v = map.get(k);
    if (!v) map.set(k, (v = explain(c, role, action, target)));
    return v;
  };
}

/**
 * Today's denials, grouped by what was denied rather than by who asked.
 *
 * Called `causes` and not `friction`: `seisin review` already has a `friction`
 * that counts something narrower — repeated denials that are not about keys —
 * and two screens of one product reporting different numbers under one label
 * is the kind of thing nobody notices until they are compared.
 *
 * The console used to show them per role, which is the same list a hundred
 * times over: measured on one deployment, 1,080 of 1,422 refusals were a
 * single lock file across six repositories, and per-role that reads as six
 * hundred identical rows instead of one sentence. Grouped, the shape of the
 * day is visible at a glance and it is almost never a territory dispute.
 *
 * `stillRefused` is recomputed against the policy as it stands, not read out
 * of the log — a cause that has been granted since is history, not friction,
 * and leaving it on the page sends somebody to fix what is already fixed.
 */
export function causesOf(cfg, entries, { ask = explain } = {}) {
  const by = new Map();
  for (const e of entries) {
    if (e.verdict !== "denied" || !e.target || !e.action) continue;
    const k = `${e.action}\u0000${e.target}`;
    const g = by.get(k) ?? { action: e.action, target: e.target, kind: e.kind, times: 0, roles: new Set(), ownersThen: e.owners ?? [] };
    g.times++;
    g.roles.add(e.role);
    by.set(k, g);
  }
  const total = [...by.values()].reduce((n, g) => n + g.times, 0);

  /**
   * The same grouping again, one level coarser: by the NAME at the end of the
   * path rather than the path.
   *
   * Grouping by path alone gets the most important reading backwards. Measured
   * here: six of the top seven causes were `.git/index.lock` in six different
   * repositories, no single one above 17% — so "no cause dominates" is what the
   * arithmetic says and the opposite of what is true. Three quarters of the
   * window was one *kind* of thing, and that is a tooling problem with a
   * mechanical fix, not a territory question anybody needs to rule on.
   *
   * By last segment, and nothing cleverer. A regex that recognised lock files,
   * caches and build outputs would be a list of guesses about other people's
   * toolchains that quietly goes stale; a repeated filename is a fact about
   * this log.
   */
  const fams = new Map();
  for (const g of by.values()) {
    const name = g.target.split("/").filter(Boolean).pop() ?? g.target;
    const f = fams.get(name) ?? { name, times: 0, paths: 0, where: [], roles: new Set() };
    f.times += g.times;
    f.paths++;
    // The places, so the console can show what a name is made of instead of
    // asserting a percentage the reader has to take on faith.
    f.where.push({ target: g.target, times: g.times });
    for (const r of g.roles) f.roles.add(r);
    fams.set(name, f);
  }
  const families = [...fams.values()]
    .sort((a, b) => b.times - a.times)
    .map((f) => ({
      name: f.name, times: f.times, paths: f.paths,
      share: total ? f.times / total : 0,
      roles: [...f.roles].sort(),
      where: f.where.sort((a, b) => b.times - a.times).slice(0, 20),
    }));

  /**
   * What a `grep` over the log cannot tell you: where each refused path stands
   * against the policy as it is now.
   *
   * The headline used to be "74% of it is one name", and a field review
   * applied this project's own test to it: *did the number tell you something
   * you did not know?* For somebody who reads the raw log, no. So the console
   * added how many causes are on paths no role owns — a decision rather than a
   * number — and then computed it from the `owners` each log line carried,
   * which is the one thing the log already had. It said the policy and read
   * the past: every grant made since left its refusals counted as "nobody's",
   * and protected surfaces, ports and paths outside the repository, which
   * nobody can ever own, were counted as waiting for somebody to claim them.
   *
   * Now every cause is classified by `standing` (owners.js), and the four
   * piles are reported in paths and in refusals. `unowned` keeps its name and
   * now means what the page always said it meant. The owners the log recorded
   * are kept on each cause as `ownersThen`: evidence of what was true, not
   * authority over what is.
   */
  const standOf = standingOf(cfg);
  const piles = Object.fromEntries(["unowned", "owned", "protected", "outside"].map((k) => [k, { paths: 0, denials: 0 }]));
  for (const g of by.values()) {
    const s = standOf({ kind: g.kind, target: g.target });
    g.standing = s;
    piles[s.kind].paths++;
    piles[s.kind].denials += g.times;
  }

  /**
   * And for the unowned pile, what kind of thing each path is (kinds.js).
   *
   * Suggesting an owner was measured first and was right about one time in
   * twenty; the rest widened a role over git's lock files, a test's scratch
   * directories and a credential. What the reader needs is the kind and the
   * move that fits it, and `territory` — the part that really is a decision —
   * is what is left. Over every unowned cause, not the twelve shown: one rule
   * needs the whole set (the same name made unique per run in many places).
   */
  const unowned = [...by.values()].filter((g) => g.standing.kind === "unowned");
  const natures = kindsOf(unowned.map((g) => g.target), { keyDirs: cfg.keyDirs ?? [] });
  piles.unowned.kinds = Object.fromEntries(Object.keys(KINDS).map((k) => [k, { paths: 0, denials: 0 }]));
  for (const g of unowned) {
    g.nature = natures.get(g.target);
    piles.unowned.kinds[g.nature.kind].paths++;
    piles.unowned.kinds[g.nature.kind].denials += g.times;
  }

  return {
    total,
    unowned: piles.unowned.paths,
    standing: piles,
    // The real number of distinct causes, not the length of the list below.
    // The page says "over N distinct paths" and the list is capped at twelve,
    // so taking N from the list reported the cap as if it were the count —
    // a wrong number stated confidently, which is worse than no number.
    distinct: by.size,
    families: families.slice(0, 8),
    causes: [...by.values()]
      .sort((a, b) => b.times - a.times)
      .slice(0, 12)
      .map((g) => ({
        action: g.action,
        target: g.target,
        times: g.times,
        share: total ? g.times / total : 0,
        roles: [...g.roles].sort(),
        standing: g.standing.kind,
        ...(g.standing.why && { why: g.standing.why }),
        // Only on an unowned cause: what kind of thing it is, and what to do.
        ...(g.nature && { kind: g.nature.kind, hint: g.nature.hint }),
        owners: g.standing.owners,
        ownersThen: g.ownersThen,
        // How many of the roles that hit this would still hit it. `some` and
        // not `every`: two roles out of three still blocked is still friction,
        // and requiring all of them would quietly retire a live cause the day
        // one role got a grant.
        stillRefused: [...g.roles].filter((r) => cfg.roles[r] && !ask(cfg, r, g.action, g.target).allowed).length,
      })),
  };
}

/**
 * Every role's walls, from one read of the log.
 *
 * `entries` are log lines of any verdict (walls keeps the denied ones); only
 * roles with at least one wall appear. The MCP read the log once per role — 32
 * reads on a real policy — to answer the same question.
 */
export function wallsByRole(cfg, entries, { ask } = {}) {
  const denied = entries.filter((e) => e.verdict === "denied");
  return Object.fromEntries(
    Object.keys(cfg.roles)
      .map((r) => [r, walls(cfg, r, { entries: denied, ...(ask && { ask }) })])
      .filter(([, w]) => w.length));
}

/**
 * The request queue as a person should read it: pending, with the requests
 * the role has stopped asking for marked. `history` is the whole log, every
 * verdict — a run that was only allowed things is still a run.
 */
export function queue(root, history) {
  return markStale(pending(requestsPath(root)), history);
}
