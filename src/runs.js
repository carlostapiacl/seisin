/**
 * The console's runs: a directory of them (`[console] runs`, `seisin ui --runs`),
 * or the runs named in one log.
 *
 * A launcher that lends each run a territory of its own (an orchestrator, say) has no
 * single seisin.toml to open: every run gets one written for it at the root of
 * a worktree, runs there, and the worktree is gone a day or two later. What is
 * worth keeping is copied out — the policy, the `.seisin/` beside it and a
 * `run.json` the launcher writes — one folder per run, under one directory.
 * This reads that directory. The contract is docs/runs.md.
 *
 * Read only, on purpose. The territory is the launcher's to lend: a grant
 * written into an archived run's seisin.toml changes nothing anywhere, so the
 * console in this mode offers none and the server refuses every write.
 *
 * A run that is archived does not change, so what is worked out from it is
 * kept for as long as its files' signature stays the same — the poll every two
 * seconds over hundreds of runs re-reads a directory listing and some stats,
 * not every log.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, policyId } from "./config.js";
import { stateDir } from "./state.js";
import { read } from "./log.js";
import { pending } from "./requests.js";
import { STATE_DIR, LOG_NAME } from "./layout.js";
import { expectedOf, runHomeOf } from "./kinds.js";
import { causesOf, classOf, ownersSaid, CLASSES, NEEDS_A_PERSON, parseSince } from "./views.js";

/**
 * An archived run's own files, always at `<run>/.seisin/`: a run folder is read
 * as it was written, whatever `--state-dir` this process was given. A launcher
 * that runs with `--policy <run>/seisin.toml --state-dir <run>/.seisin` writes
 * each run straight into this shape, and has nothing to copy at the end.
 */
const logPath = (root) => join(root, STATE_DIR, LOG_NAME);
const requestsPath = (root) => join(root, STATE_DIR, "requests.jsonl");

/** The name a run's folder may have: what becomes `run=` in a link. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The fields of run.json the console reads; anything else in it is ignored. */
const META = ["run_id", "team", "work_item", "role", "repo", "started_at", "ended_at", "status", "launcher"];

/** How many causes the global view is sent, summed over the runs shown. */
const CAUSES_SHOWN = 50;

/** How many of a run's own causes travel with it in the list. */
const RUN_CAUSES = 5;

export function isRunId(id) {
  return typeof id === "string" && RUN_ID.test(id) && id !== "." && id !== "..";
}

function statSig(p) {
  try { const s = statSync(p); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return "-"; }
}

/** The run folders under `dir`, by name; a file or a name that is not a run id is skipped. */
export function runFolders(dir) {
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw Object.assign(new Error(`cannot read the runs directory ${dir}: ${e.message}`), { status: 500 }); }
  return names.filter((d) => d.isDirectory() && isRunId(d.name)).map((d) => d.name).sort();
}

/** Where a run's policy is: `seisin.toml`, or `seisin.json` for a launcher that generates JSON. */
export function runPolicy(dir, id) {
  const toml = join(dir, id, "seisin.toml");
  const json = join(dir, id, "seisin.json");
  if (existsSync(toml)) return toml;
  if (existsSync(json)) return json;
  // A run that was narrowed from one policy keeps what it held under in its
  // state directory, named by its hash (narrow.js). The newest is the last it ran.
  const held = join(dir, id, STATE_DIR, "policies");
  try {
    const files = readdirSync(held).filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, at: statSync(join(held, f)).mtimeMs })).sort((a, b) => b.at - a.at);
    if (files.length) return join(held, files[0].f);
  } catch {}
  return toml;
}

/**
 * What a run's summary is made from, as stats only: the policy, run.json, the
 * queue, the current log and the `.seisin/` directory itself, whose mtime
 * moves when a segment is rotated in or out. No directory is listed: six
 * hundred `readdir`s were most of a warm poll (~0.7 s).
 */
function signatureOf(dir, id) {
  const root = join(dir, id);
  const log = logPath(root);
  return [
    statSig(runPolicy(dir, id)),
    statSig(join(root, "run.json")),
    statSig(requestsPath(root)),
    statSig(log),
    statSig(dirname(log)),
  ].join("|");
}

/** run.json, the launcher's word on the run — or null when it is missing or not JSON. */
function metaOf(dir, id) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(dir, id, "run.json"), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const k of META) if (raw[k] !== undefined && raw[k] !== null) out[k] = typeof raw[k] === "string" ? raw[k] : String(raw[k]);
  return out;
}

/**
 * What one run comes to: who it was, what it was denied, what the denials
 * cost in retries (every denial after the first of the same thing, system
 * denials aside), and whether it was let start at all.
 *
 * `outcome` is seisin's word, beside the launcher's `status`:
 *   refused — its canary failed, so nothing ran;
 *   denied  — it ran and was denied a file or a host;
 *   clean   — its canary passed and it was denied neither (system denials, the
 *             OS's own housekeeping, and the canary's expected probes do not count);
 *   no-record — nothing says the boundary held: no log, or no passed canary in it.
 *             Nothing denied in a log that is not there says nothing about the run;
 *   unread  — its policy could not be read.
 */
function summarize(dir, id) {
  const meta = metaOf(dir, id);
  const base = {
    id,
    run_id: meta?.run_id ?? id,
    team: meta?.team ?? null,
    work_item: meta?.work_item ?? null,
    role: meta?.role ?? null,
    repo: meta?.repo ?? null,
    started_at: meta?.started_at ?? null,
    ended_at: meta?.ended_at ?? null,
    status: meta?.status ?? null,
    launcher: meta?.launcher ?? null,
    meta: meta !== null,
  };
  let cfg;
  try { cfg = loadConfig(runPolicy(dir, id), undefined, { root: join(dir, id) }); }
  catch (e) {
    return { ...base, outcome: "unread", error: e.code === "ENOENT" ? "no seisin.toml (or seisin.json) in this run's folder" : e.message,
      roles: [], denied: 0, byKind: {}, byClass: Object.fromEntries(CLASSES.map((c) => [c, 0])), expected: 0, retried: 0, causes: [], hosts: [], entries: 0, canary: null, dropped: 0,
      perRole: {}, defs: {} };
  }
  const all = read(logPath(cfg.root));
  const facts = digest(all, id, cfg);
  return {
    ...base,
    // A run.json that did not say when it started: the log's first line did.
    started_at: base.started_at ?? facts.started_at,
    ended_at: base.ended_at ?? facts.ended_at,
    roles: Object.keys(cfg.roles),
    defs: roleDefsOf(cfg),
    ...withoutDates(facts),
  };
}

/**
 * What each role may do, said short, for the head of its page: the territory
 * as declared, the keys by name, where the network reaches, and what holds it.
 * From the policy the run held under; the console shows the newest.
 */
export function roleDefsOf(cfg) {
  const out = {};
  for (const [name, r] of Object.entries(cfg.roles ?? {})) {
    out[name] = {
      writes: r.writesDeclared ?? r.writes ?? [],
      keys: (r.keyEntries ?? r.keys ?? []).map((k) => (typeof k === "string" ? k : k.raw ?? k.name ?? String(k))),
      network: r.network ?? cfg.allowedDomains ?? [],
      read: cfg.read ?? null,
      sandbox: cfg.sandbox?.provider?.[0] ?? null,
      ...(r.localPorts?.length && { localPorts: r.localPorts }),
      ...(r.browsers?.length && { browsers: r.browsers }),
      ...(r.mcp && { mcp: r.mcp }),
    };
  }
  return out;
}

const withoutDates = ({ started_at, ended_at, ...rest }) => rest;

/**
 * Where each of a run's denials stands (views.js classOf), against the policy
 * the run held under: `action\0target` → `{ class, standing, kind, hint }`.
 *
 * causesOf's own answer, so the list across runs and the screen of one run say
 * the same word about the same path. Its `stillDenied` asks the policy again
 * for every cause; an archived run's policy does not change, so that question
 * is skipped. Measured over 2,302 runs of a pilot: 8 s cold, once, and kept
 * with the run's summary afterwards.
 */
function classesOf(cfg, all) {
  const out = new Map();
  if (!cfg) return out;
  let got;
  try { got = causesOf(cfg, all, { limit: Infinity, ask: () => ({ allowed: false }) }); }
  catch { return out; }
  for (const c of got.causes)
    out.set(`${c.action}\u0000${c.target}`, {
      class: classOf(c), standing: c.standing, nowOwners: c.owners ?? [],
      ...(c.kind && { kind: c.kind }), ...(c.hint && { hint: c.hint }), ...(c.why && { why: c.why }),
      // Another role's: whose, which is the whole of what a person needs to hand it over.
      ...(!c.why && c.standing === "owned" && c.owners?.length && { why: `belongs to ${ownersSaid(c.owners)}` }),
    });
  return out;
}

/** What one run's log lines come to, whichever way the run is kept. */
function digest(all, id, cfg = null) {
  const classes = classesOf(cfg, all);
  // And the same for each role that ran: a launcher's run starts several (a
  // preparation, then the agent), and the console is read by role.
  const byRole = new Map();
  for (const e of all) if (e.role) (byRole.get(e.role) ?? byRole.set(e.role, []).get(e.role)).push(e);
  const perRole = {};
  for (const [role, lines] of byRole) {
    const { started_at, ended_at, sandbox, entries, ...rest } = digestLines(lines, id, classes);
    perRole[role] = { ...rest, started_at, ended_at };
  }
  return { ...digestLines(all, id, classes), perRole };
}

/** What a set of one run's log lines comes to: the whole run, or one role in it. */
function digestLines(all, id, classes) {
  /**
   * Grouped here, by what was denied, rather than through causesOf and walls:
   * those ask the policy and the disk about every path (~130 ms a run on the
   * pilot's logs, a minute and more over six hundred), to say whether a
   * denial would still be one today. An archived run's policy does not change,
   * so every repeat of a denial is a retry against a standing wall, and the
   * per-run view, which is one run, still gets the full answer from state().
   */
  const byKind = {};
  let denied = 0, expected = 0;
  const groups = new Map();
  for (const e of all) {
    if (e.verdict !== "denied") continue;
    // Housekeeping counts as expected even in a log written before seisin said
    // so: macOS frameworks, and Claude Code's plugin updater in the run's own
    // home (kinds.js expectedOf).
    const home = runHomeOf(e.target, e.run ?? id);
    if (e.expected === true || expectedOf(e.target, home ? { home } : undefined)) { expected++; continue; }
    const k = e.kind ?? "file";
    byKind[k] = (byKind[k] ?? 0) + 1;
    if (k !== "system") denied++;
    if (!e.action || !e.target) continue;
    const key = `${e.action}\u0000${e.target}`;
    let g = groups.get(key);
    if (!g) {
      const { nowOwners, ...c } = classes.get(key) ?? {};
      g = { about: k, action: e.action, target: e.target, times: 0, owners: e.owners ?? [], ...c };
      Object.defineProperty(g, "_now", { value: { owners: nowOwners ?? [], roles: new Set() } });
    }
    if (e.role) g._now.roles.add(e.role);
    g.times++;
    groups.set(key, g);
  }
  // Today's policy gives this path to every role that was denied it: granted since, so
  // history rather than another role's territory or anything to look at. One role still
  // without it keeps it where it stood.
  for (const g of groups.values())
    if (g._now.roles.size && [...g._now.roles].every((r) => g._now.owners.includes(r))) g.class = "granted";
  const causes = [...groups.values()].sort((a, b) => b.times - a.times);
  // Every denial in one of the five classes; a cause the policy could not be
  // asked about (no policy, an old log) is a decision until something says not.
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  byClass.expected = expected;
  for (const g of causes) if (g.about !== "system" && g.class !== "granted") byClass[g.class ?? "decide"] += g.times;
  const retried = causes.reduce((n, g) => n + (g.about === "system" ? 0 : g.times - 1), 0);
  const hosts = causes.filter((g) => g.about === "network").slice(0, 10).map(({ target, times }) => ({ target, times }));
  // Batches of kernel messages the system log threw away during the run: its
  // walls may be missing some. The boundary held; the record did not.
  const dropped = all.filter((e) => e.event === "log-dropped").reduce((n, e) => n + (Number(e.batches) || 0), 0);
  const canaries = all.filter((e) => e.event === "canary");
  const canary = canaries.length ? canaries[canaries.length - 1] : null;
  const outcome = canaries.some((e) => e.confined === false) ? "refused"
    : denied ? "denied"
    : canaries.some((e) => e.confined === true) ? "clean"
    : "no-record";
  return {
    started_at: all.find((e) => e.at)?.at ?? null,
    ended_at: [...all].reverse().find((e) => e.at)?.at ?? null,
    outcome,
    sandbox: canary?.sandbox ?? null,
    entries: all.length,
    denied,
    expected,
    byKind,
    byClass,
    retried,
    hosts,
    // Kept whole for the sum across runs, cut to RUN_CAUSES when sent.
    causes,
    canary: canary ? { confined: canary.confined === true, reasons: canary.reasons ?? [] } : null,
    dropped,
  };
}

/** Summaries kept by run id, with the signature they were made from. */
const cache = new Map();

/** Every run under `dir`, summarized, re-read only where a file moved. */
export function scanRuns(dir) {
  const ids = runFolders(dir);
  const seen = new Set(ids);
  for (const k of cache.keys()) if (k.startsWith(`${dir}\u0000`) && !seen.has(k.slice(dir.length + 1))) cache.delete(k);
  const sigs = [];
  const runs = ids.map((id) => {
    const sig = signatureOf(dir, id);
    sigs.push(`${id}=${sig}`);
    const k = `${dir}\u0000${id}`;
    const hit = cache.get(k);
    if (hit && hit.sig === sig) return hit.summary;
    const summary = summarize(dir, id);
    cache.set(k, { sig, summary });
    return summary;
  });
  return { runs, sig: sigs.join("\n") };
}

/** The filters the global view takes, from a query string. Unknown keys are ignored. */
export const FILTERS = ["team", "role", "work_item", "status", "outcome"];

export function filtersOf(query) {
  const q = new URLSearchParams(query ?? "");
  const out = {};
  for (const f of FILTERS) { const v = q.get(f); if (v) out[f] = v; }
  const text = q.get("q");
  if (text) out.q = text.toLowerCase();
  // A window back from now (`7d`) or a date: the runs that started in it. One
  // that does not parse is no filter, as the MCP's `since` is.
  // To the minute, so the poll every two seconds asks the same question twice
  // and the memo below answers it.
  const since = parseSince(q.get("since"));
  if (since) out.since = `${since.slice(0, 16)}:00.000Z`;
  // A role of the policy (not the launcher's `role`): every run cut to what
  // that role did in it, so one page reads as that role across its runs.
  const srole = q.get("srole");
  if (srole) out.srole = srole;
  return out;
}

function matches(run, filters) {
  for (const f of FILTERS) if (filters[f] !== undefined && (run[f] ?? "") !== filters[f]) return false;
  if (filters.q) {
    const hay = [run.id, run.run_id, run.work_item, run.repo, run.team, run.role].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(filters.q)) return false;
  }
  // A run that never said when it started is not in any window.
  if (filters.since && !(Date.parse(run.started_at ?? "") >= Date.parse(filters.since))) return false;
  return true;
}

/** How many runs have each value of each filter — over every run, so a filter never hides its siblings. */
function facetsOf(runs) {
  const out = {};
  for (const f of FILTERS) {
    const m = new Map();
    for (const r of runs) { const v = r[f]; if (v) m.set(v, (m.get(v) ?? 0) + 1); }
    out[f] = [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([value, runs]) => ({ value, runs }));
  }
  return out;
}

/**
 * A path under the run's own folder, in the form every run shares: a launcher
 * gives each run a home named after it, so one wall in 364 runs read as 364
 * different paths, and none of them came near the top of the list.
 */
export function sameAcrossRuns(target, id) {
  const mark = `/${id}`;
  const at = String(target).indexOf(mark + "/");
  if (at !== -1) return `$RUN${target.slice(at + mark.length)}`;
  return String(target).endsWith(mark) ? "$RUN" : target;
}

/**
 * A port the system hands out, 32768 and up, is a different number in every
 * run: one cause per run, none of them near the top, though one pilot had it
 * in 2,165 runs of 2,302. Summed across runs as one.
 */
const EPHEMERAL = "tcp:<ephemeral>";
const EPHEMERAL_WHY = "ports the system hands out (32768 and up), a different one in each run: seisin's own canary " +
  "probe in runs from before it was marked expected (0.9.0), or a server the run started itself";
function acrossKey(target, id) {
  const m = /^tcp:(\d{1,5})$/.exec(String(target));
  if (m && Number(m[1]) >= 32768) return EPHEMERAL;
  return sameAcrossRuns(target, id);
}

/**
 * The same refusal across runs is one cause: summed by what was refused, with
 * how many runs hit it and which teams and roles they were.
 */
function causesAcross(runs) {
  const by = new Map();
  for (const r of runs) {
    for (const c of r.causes) {
      const target = acrossKey(c.target, r.id);
      const k = `${c.action}\u0000${target}`;
      const g = by.get(k) ?? { action: c.action, target, about: c.about, owners: c.owners, times: 0, runs: 0, teams: new Set(), roles: new Set(),
        work_items: new Set(), last: null, first: null, classes: new Map(), ids: new Set(), runs: 0 };
      g.times += c.times;
      g.ids.add(r.id);
      if (r.team) g.teams.add(r.team);
      if (r.role) g.roles.add(r.role);
      if (r.work_item) g.work_items.add(r.work_item);
      const t = Date.parse(r.started_at ?? "");
      if (!g.last || (Number.isFinite(t) && !(Date.parse(g.last.at ?? "") >= t))) g.last = { run: r.id, at: r.started_at };
      if (Number.isFinite(t) && (!g.first || t < Date.parse(g.first))) g.first = r.started_at;
      // Each run's policy said where the path stood for it; the word most of
      // them said is the one shown, with its hint.
      const cls = c.class ?? "decide";
      const seen = g.classes.get(cls) ?? { runs: 0, hint: c.hint, kind: c.kind, why: target === EPHEMERAL ? EPHEMERAL_WHY : c.why };
      seen.runs++;
      g.classes.set(cls, seen);
      by.set(k, g);
    }
  }
  return [...by.values()]
    // The OS's own housekeeping last: it is in every run and nobody grants it.
    .sort((a, b) => (a.about === "system") - (b.about === "system") || b.ids.size - a.ids.size || b.times - a.times)
    .map(({ classes, ...g }) => {
      // The word most runs said, except that a run where it still needs a person outranks
      // runs where it is history or the boundary working: a majority granted since must not
      // hide the one role still denied it.
      const ranked = [...classes].sort((a, b) => NEEDS_A_PERSON.has(b[0]) - NEEDS_A_PERSON.has(a[0]) || b[1].runs - a[1].runs);
      const [cls, seen] = ranked[0];
      return {
        ...g, class: cls, runs: g.ids.size,
        ...(seen.kind && { kind: seen.kind }), ...(seen.hint && { hint: seen.hint }), ...(seen.why && { why: seen.why }),
        teams: [...g.teams], roles: [...g.roles], work_items: [...g.work_items].slice(0, 12), work_item_count: g.work_items.size,
        last: g.last?.run ?? null, last_at: g.last?.at ?? null,
      };
    });
}

/**
 * The same thing in many places is one line: a file name that recurs (every
 * `__pycache__` a test run leaves, one per folder) under one class and one
 * action. Measured on one pilot: 5,450 causes that needed a person were 60
 * names, and the fifty-line list was mostly one of them. Network and keys stay
 * as they are; a port is not a name in many places.
 */
function familiesOf(needs) {
  const by = new Map();
  for (const c of needs) {
    const name = c.about === "file" ? (String(c.target).split("/").filter(Boolean).pop() ?? c.target) : null;
    const k = name ? `${c.class}\u0000${c.action}\u0000${name}` : `${c.class}\u0000${c.action}\u0000=${c.target}`;
    const f = by.get(k);
    if (!f) { by.set(k, { ...c, places: [c], runIds: new Set(c.ids ?? []), name }); continue; }
    f.places.push(c);
    for (const id of c.ids ?? []) f.runIds.add(id);
    f.times += c.times;
    for (const t of c.teams) if (!f.teams.includes(t)) f.teams.push(t);
    for (const r of c.roles) if (!f.roles.includes(r)) f.roles.push(r);
    if (c.first && (!f.first || c.first < f.first)) f.first = c.first;
    if (c.last_at && (!f.last_at || c.last_at > f.last_at)) { f.last_at = c.last_at; f.last = c.last; }
  }
  return [...by.values()].map(({ places, runIds, name, ids, ...f }) => {
    if (places.length === 1) return f;
    const items = new Set(places.flatMap((p) => p.work_items));
    return {
      ...f,
      target: `…/${name}`,
      runs: runIds.size,
      places: places.length,
      where: places.sort((a, b) => b.runs - a.runs).slice(0, 8).map((p) => ({ target: p.target, runs: p.runs, times: p.times })),
      work_items: [...items].slice(0, 12),
      work_item_count: Math.max(f.work_item_count ?? 0, items.size),
    };
  }).sort((a, b) => b.runs - a.runs || b.times - a.times);
}

/** How many causes that need a person are sent; the screens show fewer unless asked. */
const ATTENTION_SHOWN = 50;
/** How many days the trend covers, back from today. */
const TREND_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * The first screen: what across these runs needs a person, and whether the
 * boundary held while it ran.
 *
 * Denials are almost all the boundary working — measured over one pilot's
 * 2,302 runs, 27,000 of them, not one on a path nobody owned — so a total said
 * nothing, and 97% of runs read "denied". This sorts them into the five
 * classes and lists only the three that need a person, by how many runs hit
 * them; a cause first seen in the last day is marked new. `now` is a
 * parameter so a test does not depend on the clock.
 */
/** `YYYY-MM-DD` of a time, in the local zone. */
function localDay(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function attentionOf(shown, causes, { now = Date.now(), limit = ATTENTION_SHOWN } = {}) {
  const piles = Object.fromEntries(CLASSES.map((c) => [c, { causes: 0, denials: 0, runs: 0 }]));
  for (const r of shown)
    for (const c of CLASSES) {
      const n = r.byClass?.[c] ?? 0;
      piles[c].denials += n;
      if (n) piles[c].runs++;
    }
  for (const c of causes) if (c.about !== "system" && piles[c.class]) piles[c.class].causes++;
  const health = { runs: shown.length, refused: 0, noRecord: 0, incomplete: 0, clean: 0, unread: 0 };
  for (const r of shown) {
    if (r.outcome === "refused") health.refused++;
    else if (r.outcome === "no-record") health.noRecord++;
    else if (r.outcome === "clean") health.clean++;
    else if (r.outcome === "unread") health.unread++;
    if (r.dropped) health.incomplete++;
  }
  const dayAgo = now - DAY_MS;
  const isNew = (c) => !!(c.first && Date.parse(c.first) >= dayAgo);
  const needs = familiesOf(causes.filter((c) => c.about !== "system" && NEEDS_A_PERSON.has(c.class)));
  const paths = needs.reduce((k, f) => k + (f.places ?? 1), 0);
  const top = needs.slice(0, limit).map((c) => ({ ...c, new: isNew(c) }));
  // The days, oldest first, so a chart reads left to right; a day with no run
  // is a zero, not a gap. Local days: the person reading it lives in one, and
  // in UTC an evening's runs west of Greenwich landed on tomorrow.
  // Calendar days, not 24-hour steps: a change of daylight saving time would drop one or say one twice.
  const days = Array.from({ length: TREND_DAYS }, (_, i) => {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() - (TREND_DAYS - 1 - i));
    return { day: localDay(d.getTime()), runs: 0, needs: 0, boundary: 0, refused: 0 };
  });
  const at = new Map(days.map((d) => [d.day, d]));
  for (const r of shown) {
    const t = Date.parse(r.started_at ?? "");
    const d = Number.isNaN(t) ? null : at.get(localDay(t));
    if (!d) continue;
    d.runs++;
    for (const c of CLASSES) (NEEDS_A_PERSON.has(c) ? (d.needs += r.byClass?.[c] ?? 0) : (d.boundary += r.byClass?.[c] ?? 0));
    if (r.outcome === "refused") d.refused++;
  }
  return {
    piles,
    health,
    needs: needs.length,
    paths,
    fresh: needs.filter(isNew).length,
    top,
    days,
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The global view: the runs that pass the filters, newest first, and what they add up to. */
const views = new Map();

export function runsView(dir, filters = {}, { scanned = scanRuns(dir), limit = ATTENTION_SHOWN } = {}) {
  // The same runs and the same filters are the same answer: the poll asks
  // every two seconds, and summing the causes of six hundred runs was most
  // of what it cost once the runs themselves were remembered.
  // And the minute: what is new and which days the trend covers move with the clock.
  const key = `${dir}\u0000${JSON.stringify(filters)}\u0000${scanned.sig}\u0000${Math.floor(Date.now() / 60_000)}\u0000${limit}`;
  const hit = views.get(key);
  if (hit) return hit;
  const view = viewOf(dir, filters, scanned.runs, { limit });
  views.set(key, view);
  while (views.size > 8) views.delete(views.keys().next().value);
  return view;
}

/** One run as one of its roles saw it: that role's denials, canary and outcome; null when the role did not run. */
function sliceTo(r, role) {
  const p = r.perRole && Object.hasOwn(r.perRole, role) ? r.perRole[role] : null;
  if (!p) return null;
  const { perRole, defs, ...run } = r;
  return { ...run, ...p, started_at: r.started_at ?? p.started_at, ended_at: r.ended_at ?? p.ended_at, srole: role };
}

/**
 * Every role of the policy across the runs a filter leaves: how many runs it
 * had, what in them needs a person, whether its canary held, and what it may
 * do. The console's first screen and its sidebar; a role that never ran is
 * listed too, with nothing against it.
 */
function rolesOf(base, now, policyDefs = null) {
  const names = new Set();
  let newest = null;
  for (const r of base) {
    for (const n of Object.keys(r.perRole ?? {})) names.add(n);
    if (r.defs && Object.keys(r.defs).length && (!newest || (r.started_at ?? "") > (newest.started_at ?? ""))) newest = r;
  }
  // The policy at hand when there is one (a repository's own log); otherwise the newest run's.
  const defs = policyDefs ?? newest?.defs ?? {};
  for (const n of Object.keys(defs)) names.add(n);
  return [...names].map((name) => {
    const runs = base.map((r) => sliceTo(r, name)).filter(Boolean);
    const att = attentionOf(runs, causesAcross(runs), { now });
    const p = att.piles;
    const last = runs.reduce((m, r) => (r.started_at && (!m || r.started_at > m) ? r.started_at : m), null);
    return {
      name,
      runs: runs.length,
      needs: att.needs,
      paths: att.paths,
      fresh: att.fresh,
      denials: { needs: p.decide.denials + p.outside.denials + p.handoff.denials, working: p.protected.denials + p.expected.denials },
      health: att.health,
      last_at: last,
      top: att.top[0] ? { action: att.top[0].action, target: att.top[0].target, class: att.top[0].class, runs: att.top[0].runs } : null,
      def: defs[name] ?? null,
    };
  // The policy's roles first, worst first; one only past runs remember goes last.
  }).sort((a, b) => (!a.def) - (!b.def) || b.needs - a.needs || b.runs - a.runs || a.name.localeCompare(b.name));
}

function viewOf(dir, filters, every, { now = Date.now(), defs = null, limit = ATTENTION_SHOWN } = {}) {
  const { srole, ...rest } = filters;
  const base = every.filter((r) => matches(r, rest));
  const sliced = srole ? every.map((r) => sliceTo(r, srole)).filter(Boolean) : every;
  const shown = sliced.filter((r) => matches(r, filters))
    .sort((a, b) => cmp(b.started_at ?? "", a.started_at ?? "") || cmp(b.id, a.id));
  const totals = { runs: shown.length, denied: 0, retried: 0, expected: 0, byKind: {}, outcome: {}, incomplete: 0 };
  for (const r of shown) {
    totals.denied += r.denied;
    totals.retried += r.retried;
    totals.expected += r.expected;
    for (const [k, n] of Object.entries(r.byKind)) totals.byKind[k] = (totals.byKind[k] ?? 0) + n;
    totals.outcome[r.outcome] = (totals.outcome[r.outcome] ?? 0) + 1;
    if (r.dropped) totals.incomplete++;
  }
  const causes = causesAcross(shown);
  return {
    mode: "runs",
    dir,
    filters,
    total: every.length,
    facets: facetsOf(every),
    totals,
    attention: attentionOf(shown, causes, { now, limit }),
    roles: rolesOf(base, now, defs),
    // `ids` is how a family counts its runs once (familiesOf); no reader needs it.
    causes: causes.slice(0, CAUSES_SHOWN).map(({ ids, ...c }) => c),
    // Without the per-role split and the policy summary: the list does not need them, and they are most of the bytes.
    runs: shown.map(({ perRole, defs, ...r }) => ({ ...r, roles_ran: Object.keys(perRole ?? {}), causes: r.causes.slice(0, RUN_CAUSES) })),
    readOnly: true,
  };
}

/**
 * The runs of one log: a repository with no launcher has no folders of runs,
 * and every line `seisin run` writes names its run. Lines from before that, or
 * from outside a run, belong to none and are left out of this list.
 */
export function runsInLog(all, roles = [], cfg = null) {
  const by = new Map();
  for (const e of all) if (e.run) (by.get(e.run) ?? by.set(e.run, []).get(e.run)).push(e);
  return [...by].map(([id, lines]) => ({
    id, run_id: id, team: null, work_item: null, repo: null, status: null, launcher: null, meta: false,
    role: lines.find((e) => e.role)?.role ?? null,
    roles,
    ...digest(lines, id, cfg),
  }));
}

/** The global view over one log's runs: the same answer a directory of runs gets. */
export function logRunsView(where, all, filters = {}, roles = [], cfg = null, { now = Date.now(), limit = ATTENTION_SHOWN } = {}) {
  return viewOf(where, filters, runsInLog(all, roles, cfg), { now, limit, defs: cfg ? roleDefsOf(cfg) : null });
}

/** How many denials one run's timeline lists before it says how many more. */
const TIMELINE_SHOWN = 200;

/**
 * One run, as one role lived it, in order: the canary, each thing it was
 * denied the first time (with how many times and where it stands), what was
 * dropped from the record, and the end. What opens under a run on a role's
 * page: the run is a moment in a role's life, not a console of its own.
 */
export function timelineOf(all, id, role, cfg = null, { heldFrom = null } = {}) {
  // Only lines that name this run: one with no run (an older log, a command outside
  // a run) belongs to none of them.
  const lines = all.filter((e) => e.run === id && (!role || e.role === role));
  const then = heldOf(cfg, lines, heldFrom);
  const classes = classesOf(cfg, lines);
  const events = [];
  const seen = new Map();
  const canaryAt = new Map();
  let allowed = 0, observed = 0, more = 0, narrowed = null;
  for (const e of lines) {
    if (e.event === "canary") {
      canaryAt.set(e.role, Date.parse(e.at ?? ""));
      events.push({ at: e.at ?? null, type: "canary", role: e.role, confined: e.confined === true, reasons: e.reasons ?? [], sandbox: e.sandbox ?? null });
      continue;
    }
    if (e.event === "log-dropped") { events.push({ at: e.at ?? null, type: "dropped", role: e.role, batches: Number(e.batches) || 0 }); continue; }
    if (e.event === "narrowed") {
      events.push({ at: e.at ?? null, type: "narrowed", role: e.role });
      narrowed ??= { only: e.only ?? [], deny: e.deny ?? [], vars: e.vars ?? [] };
      continue;
    }
    if (e.event) continue;
    if (e.verdict === "allowed") { allowed++; continue; }
    if (e.verdict === "observed") { observed++; continue; }
    if (e.verdict !== "denied" || !e.target) continue;
    const key = `${e.role}\u0000${e.action}\u0000${e.target}`;
    const had = seen.get(key);
    if (had) { had.times++; continue; }
    if (seen.size >= TIMELINE_SHOWN) { more++; continue; }
    const home = runHomeOf(e.target, id);
    const exp = e.expected === true || expectedOf(e.target, home ? { home } : undefined);
    const c = classes.get(`${e.action}\u0000${e.target}`);
    const ev = {
      at: e.at ?? null, type: "denied", role: e.role, action: e.action, target: e.target, about: e.kind ?? "file", times: 1,
      class: exp ? "expected" : c?.nowOwners?.includes(e.role) ? "granted" : c?.class ?? "decide",
      ...(e.probe && { probe: e.probe }),
      // Before 0.9.0 the canary's loopback probe was not marked: a port the
      // system hands out, dialled within two seconds of that role's canary, is
      // said to be most likely it — said, not assumed into a class.
      ...(!e.probe && likelyCanaryProbe(e, canaryAt.get(e.role)) && { likely: "the canary's own probe, from before it was marked" }),
      ...((c?.hint || c?.why) && { why: c.hint ?? c.why }),
    };
    seen.set(key, ev);
    events.push(ev);
  }
  return {
    id, role: role ?? null,
    started_at: lines.find((e) => e.at)?.at ?? null,
    ended_at: [...lines].reverse().find((e) => e.at)?.at ?? null,
    allowed, observed, more, events,
    // What the role could do in this run: the policy it held under, with what
    // --only and --deny took away. What the one-run console used to show.
    held: role && then.cfg?.roles?.[role] ? roleDefsOf(then.cfg)[role] : null,
    // "run": the policy this run held under. "today": the file has changed since and what
    // the run held is not kept, so this is today's — said, never passed off as the run's.
    held_from: role && then.cfg?.roles?.[role] ? then.from : null,
    narrowed,
  };
}

/**
 * The policy a run held under. A run narrowed from one policy kept it in
 * `<state>/policies/<hash>.json`, and every line names that hash; a run whose hash
 * is today's file held today's. Otherwise only today's is at hand, and it is said so.
 */
function heldOf(cfg, lines, heldFrom) {
  if (!cfg) return { cfg: null, from: null };
  if (heldFrom) return { cfg, from: heldFrom };
  const hash = lines.find((e) => e.policy)?.policy ?? null;
  if (hash && /^[0-9a-f]{6,64}$/.test(hash)) {
    const kept = join(stateDir(cfg.root), "policies", `${hash}.json`);
    if (existsSync(kept)) {
      try { return { cfg: loadConfig(kept, undefined, { root: cfg.root }), from: "run" }; } catch {}
    }
    if (hash === policyId(cfg)) return { cfg, from: "run" };
  }
  return { cfg, from: hash ? "today" : "unknown" };
}

function likelyCanaryProbe(e, at) {
  const m = /^tcp:(\d{1,5})$/.exec(String(e.target ?? ""));
  if (!m || Number(m[1]) < 32768 || e.action !== "connect" || !Number.isFinite(at)) return false;
  const t = Date.parse(e.at ?? "");
  return Number.isFinite(t) && t >= at && t - at <= 2000;
}

/** A run's timeline out of a directory of runs, read against the policy it held under. */
export function runTimeline(dir, id, role) {
  if (!isRunId(id)) throw Object.assign(new Error(`not a run id: ${JSON.stringify(id)}`), { status: 400 });
  if (!runFolders(dir).includes(id)) throw Object.assign(new Error(`no run ${id} in ${dir}`), { status: 404 });
  let cfg = null;
  try { cfg = loadConfig(runPolicy(dir, id), undefined, { root: join(dir, id) }); } catch {}
  // The folder is the run: every line of its log is this run, whatever label its lines carry.
  const t = timelineOf(read(logPath(join(dir, id))).map((e) => ({ ...e, run: id })), id, role, cfg, { heldFrom: cfg ? "run" : null });
  // What the run asked for and was not given: asked for where it was launched,
  // never granted from here. Read only: an old queue is an error, never rewritten.
  let asked = [];
  try { asked = pending(requestsPath(join(dir, id)), { readOnly: true }); } catch (e) { asked = [{ error: e.message }]; }
  return { ...t, requests: asked.filter((q) => q.error || !role || q.role === role) };
}

/** One run's summary, by id; throws 404 for a name that is not a run here. */
export function runOf(dir, id) {
  if (!isRunId(id)) throw Object.assign(new Error(`not a run id: ${JSON.stringify(id)}`), { status: 400 });
  if (!runFolders(dir).includes(id)) throw Object.assign(new Error(`no run ${id} in ${dir}`), { status: 404 });
  const { runs } = scanRuns(dir);
  const r = runs.find((x) => x.id === id);
  return { ...r, causes: r.causes.slice(0, RUN_CAUSES) };
}
