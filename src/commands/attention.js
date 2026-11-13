/**
 * `seisin attention` — what across the runs needs a person, in the terminal.
 *
 * The console's first screen, for whoever does not open a browser: most people
 * who sandbox an agent learn what was refused from the terminal that ran it,
 * and nowhere else. Denials are almost all the boundary working, so a count
 * says nothing; this sorts them the way every screen does (views.js classOf)
 * and lists only what needs a person — a decision nobody has made, the allow
 * list's question, or another role's territory — by how many runs hit it.
 *
 * Over a directory of runs (`--runs`, or the policy's `[console] runs`), or the
 * runs named in the policy's own log when there is neither. Reads only.
 *
 * Exits 1 when a run's canary failed in the window: the boundary did not hold
 * there, and a CI job that says so beats a person noticing. Anything else,
 * however long the list, exits 0: it is worth reading, not failing over.
 *
 * And `runSummary`, the few lines `seisin run` ends with, made of the same
 * words over one run.
 */
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { runsView, logRunsView, filtersOf } from "../runs.js";
import { causesOf, classOf, ownersSaid, NEEDS_A_PERSON, parseSince } from "../views.js";
import { read, logPath } from "../log.js";
import { C, out, safe } from "../render.js";

/** What each class is called on a screen, and what it asks of the reader. */
export const CLASS_LABEL = {
  decide: "no owner",
  outside: "outside",
  handoff: "other role",
  protected: "protected",
  expected: "expected",
  granted: "granted since",
};

const n = (x) => Number(x ?? 0).toLocaleString("en-US");
const plural = (k, one, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;

/** The flags the filter takes, as the query string runs.js reads. */
const FILTER_FLAGS = { "--team": "team", "--role": "role", "--work-item": "work_item", "--status": "status", "--outcome": "outcome" };

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

/** Where the runs are: `--runs`, then the policy's `[console] runs`, then its own log. */
function sourceOf(config, argv) {
  const dir = valueOf(argv, "--runs");
  if (dir) {
    let st = null;
    try { st = statSync(dir); } catch {}
    if (!st?.isDirectory()) throw new Error(`--runs ${dir}: not a directory`);
    return { dir: resolve(dir) };
  }
  if (!config) throw new Error("no seisin.toml here: run it in a repository, or name a directory of runs with --runs <dir>");
  const declared = config.console?.runs;
  if (declared && existsSync(declared)) return { dir: declared };
  return { config };
}

export function attentionView(config, argv = []) {
  const q = new URLSearchParams();
  for (const [flag, key] of Object.entries(FILTER_FLAGS)) {
    const v = valueOf(argv, flag);
    if (v) q.set(key, v);
  }
  const since = valueOf(argv, "--since");
  // A person typed it: a window that does not parse is refused, not ignored,
  // so the whole history is never presented as the last week (as review does).
  if (since && !parseSince(since))
    throw new Error(`--since takes a date (2026-10-01) or a duration back from now (7d, 12h, 2w), not "${safe(since)}"`);
  if (since) q.set("since", since);
  const src = sourceOf(config, argv);
  const filters = filtersOf(q.toString());
  // --all is every cause, not the first fifty the console lists.
  const limit = argv.includes("--all") ? Infinity : undefined;
  return src.dir
    ? runsView(src.dir, filters, { limit })
    : logRunsView(src.config.path, read(logPath(src.config.root)), filters, Object.keys(src.config.roles), src.config, { limit });
}

const BARS = " ▁▂▃▄▅▆▇█";
function spark(values) {
  const max = Math.max(...values, 0);
  return values.map((v) => (v === 0 ? "·" : BARS[Math.max(1, Math.round((v / max) * 8))])).join("");
}

export function attentionCommand(config, argv = []) {
  const view = attentionView(config, argv);
  if (argv.includes("--json")) {
    out(JSON.stringify({ filters: view.filters, total: view.total, totals: view.totals, attention: view.attention }, null, 2) + "\n");
    return view;
  }
  const a = view.attention;
  const all = argv.includes("--all");
  const where = view.filters.since ? ` since ${view.filters.since.slice(0, 16).replace("T", " ")}` : "";
  if (!view.totals.runs) {
    out(`\n  ${C.dim}no runs${where}${view.total ? ` (of ${n(view.total)}) match` : " recorded yet"}.${C.off}\n\n`);
    return view;
  }
  out(`\n  ${C.b}${plural(view.totals.runs, "run")}${C.off}${C.dim}${where}${view.totals.runs !== view.total ? ` · of ${n(view.total)}` : ""}${C.off}\n\n`);

  // Whether the boundary held, before anything about what it refused.
  const h = a.health;
  const held = [];
  if (h.refused) held.push(`${C.red}${plural(h.refused, "run")} stopped at its canary: the boundary did not hold, nothing ran${C.off}`);
  if (h.incomplete) held.push(`${C.yellow}${plural(h.incomplete, "run")} with an incomplete record: the system log dropped kernel messages${C.off}`);
  if (h.noRecord) held.push(`${plural(h.noRecord, "run")} with no record that the boundary held`);
  if (h.unread) held.push(`${plural(h.unread, "run")} whose policy could not be read`);
  out(`  ${C.b}Boundary${C.off}  ${held.length ? held.join(`\n            `) : `${C.green}held in every run${C.off}`}\n`);

  const p = a.piles;
  const needDenials = p.decide.denials + p.outside.denials + p.handoff.denials;
  out(`  ${C.b}Denied${C.off}    ${n(needDenials)} that need a person ${C.dim}(${["decide", "outside", "handoff"].map((c) => `${CLASS_LABEL[c]} ${n(p[c].denials)}`).join(" · ")})${C.off}\n` +
      `            ${C.dim}${n(p.protected.denials + p.expected.denials)} that are the boundary working (protected ${n(p.protected.denials)} · expected ${n(p.expected.denials)})${C.off}\n`);

  const days = a.days;
  out(`  ${C.b}14 days${C.off}   ${spark(days.map((d) => d.needs))}  ${C.dim}needing a person, per day, ${days[0].day.slice(5)} to ${days[days.length - 1].day.slice(5)}${C.off}\n`);

  if (!a.top.length) {
    out(`\n  ${C.green}Nothing needs a person.${C.off} ${C.dim}Every denial was protected on purpose or expected.${C.off}\n\n`);
    return view;
  }
  out(`\n  ${C.b}Needs a person${C.off}  ${C.dim}${plural(a.needs, "thing")}${a.paths !== a.needs ? ` in ${n(a.paths)} places` : ""}, by the runs that hit each${a.fresh ? ` · ${n(a.fresh)} new today` : ""}${C.off}\n\n`);
  const list = all ? a.top : a.top.slice(0, 8);
  const width = Math.max(...list.map((c) => String(n(c.runs)).length));
  for (const c of list) {
    const mark = c.new ? `${C.yellow}new ${C.off}` : "";
    const places = c.places ? ` ${C.dim}in ${n(c.places)} places${C.off}` : "";
    out(`  ${String(n(c.runs)).padStart(width)} ${C.dim}runs${C.off}  ${CLASS_LABEL[c.class].padEnd(10)} ${mark}${safe(c.action)} ${C.b}${safe(c.target)}${C.off}${places}\n`);
    const why = c.hint ?? c.why;
    const who = [c.teams.length ? `teams ${c.teams.slice(0, 4).join(", ")}${c.teams.length > 4 ? ` +${c.teams.length - 4}` : ""}` : null,
      c.roles.length ? `roles ${c.roles.slice(0, 4).join(", ")}${c.roles.length > 4 ? ` +${c.roles.length - 4}` : ""}` : null].filter(Boolean).join(" · ");
    out(`  ${" ".repeat(width)}       ${C.dim}${[why, who].filter(Boolean).map(safe).join(" — ")}${C.off}\n`);
  }
  if (!all && a.top.length > list.length) out(`\n  ${C.dim}… ${a.top.length - list.length} more: seisin attention --all${C.off}\n`);
  out(`\n  ${C.dim}One run in full: seisin ui${view.mode === "runs" && view.dir && !config ? ` --runs ${safe(view.dir)}` : ""}. A role's walls: seisin walls <role>.${C.off}\n\n`);
  return view;
}

/** Exit status: 1 when a canary failed in the window, 0 otherwise. */
export function attentionStatus(view) {
  return view.attention.health.refused ? 1 : 0;
}

/**
 * The lines `seisin run` ends with: this run's denials in the same five words,
 * and only what needs a person spelled out, with the command that says more.
 * Null when the run was denied nothing worth a line.
 */
export function runSummary(config, role, runLabel, entries = read(logPath(config.root))) {
  const mine = entries.filter((e) => e.run === runLabel);
  // The broker writes a host once with how many times it was refused; a line is one
  // denial everywhere else. Capped, so a corrupt count cannot make an array of it.
  const weighed = mine.flatMap((e) => (e.verdict === "denied" && e.times > 1 ? Array(Math.min(Number(e.times) || 1, 10_000)).fill(e) : [e]));
  const got = causesOf(config, weighed, { limit: Infinity });
  const by = { decide: 0, outside: 0, handoff: 0, protected: 0, expected: 0 };
  // What the caller said would be denied (the canary's probe, `expectDenied`): causesOf
  // leaves those out, and they are the boundary working.
  by.expected += weighed.filter((e) => e.verdict === "denied" && e.expected === true).length;
  const needs = [];
  for (const c of got.causes) {
    if (c.about === "system" && !c.expected) continue;
    const cls = classOf(c);
    by[cls] += c.times;
    // Only what the policy would still refuse: a path granted since is history.
    if (NEEDS_A_PERSON.has(cls) && c.stillDenied) needs.push({ ...c, cls });
  }
  const total = Object.values(by).reduce((s, k) => s + k, 0);
  if (!total) return null;
  const working = by.protected + by.expected;
  const parts = [by.expected && `${n(by.expected)} expected`, by.protected && `${n(by.protected)} protected on purpose`].filter(Boolean);
  if (!needs.length) {
    // What needs a person but was granted since this run counts as nothing to do, and says so.
    const since = total - working;
    const said = [...parts, since && `${n(since)} granted since`].filter(Boolean);
    return since
      ? `${C.dim}seisin: ${plural(total, "denial")} in this run, nothing to do (${said.join(", ")})${C.off}\n`
      : `${C.dim}seisin: ${plural(total, "denial")} in this run, all of it the boundary working (${said.join(", ")}) — nothing to do${C.off}\n`;
  }
  const head = `seisin: ${plural(total, "denial")} in this run — ${[...parts, `${n(total - working)} to look at`].join(", ")}:`;
  const lines = needs.slice(0, 3).map((c) => {
    const why = c.hint ?? c.why ?? (c.cls === "handoff" && c.owners?.length ? `belongs to ${ownersSaid(c.owners)}` : "");
    return `  ${CLASS_LABEL[c.cls].padEnd(10)} ${safe(c.action)} ${safe(c.target)}${c.times > 1 ? ` (${c.times}×)` : ""}${why ? `${C.dim} — ${safe(why)}${C.off}` : ""}\n`;
  });
  const more = needs.length > 3 ? `  ${C.dim}… and ${needs.length - 3} more${C.off}\n` : "";
  const first = needs[0];
  const next = first.about === "file" && (first.action === "read" || first.action === "write")
    ? `seisin explain ${role} ${first.action} ${safe(first.target)}`
    : `seisin walls ${role}`;
  return `${C.yellow}${head}${C.off}\n${lines.join("")}${more}  ${C.dim}→ ${next} · across runs: seisin attention${C.off}\n`;
}
