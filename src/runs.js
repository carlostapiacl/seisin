/**
 * `seisin ui --runs <dir>`: the console over many runs, each with its own policy.
 *
 * A launcher that lends each run a territory of its own (wapentake does) has no
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
import { loadConfig } from "./config.js";
import { read } from "./log.js";
import { STATE_DIR, LOG_NAME } from "./layout.js";
import { expectedOf } from "./kinds.js";

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
  return existsSync(toml) || !existsSync(json) ? toml : json;
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
 *   clean   — it ran and was denied neither (system denials, the OS's own
 *             housekeeping, and the canary's expected probes do not count);
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
  try { cfg = loadConfig(runPolicy(dir, id)); }
  catch (e) {
    return { ...base, outcome: "unread", error: e.code === "ENOENT" ? "no seisin.toml (or seisin.json) in this run's folder" : e.message,
      roles: [], denied: 0, byKind: {}, expected: 0, retried: 0, causes: [], hosts: [], entries: 0, canary: null, dropped: 0 };
  }
  const all = read(logPath(cfg.root));
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
    // macOS framework housekeeping counts as expected even in a log written
    // before seisin said so (kinds.js expectedOf).
    if (e.expected === true || (e.kind === "system" && expectedOf(e.target))) { expected++; continue; }
    const k = e.kind ?? "file";
    byKind[k] = (byKind[k] ?? 0) + 1;
    if (k !== "system") denied++;
    if (!e.action || !e.target) continue;
    const key = `${e.action}\u0000${e.target}`;
    const g = groups.get(key) ?? { about: k, action: e.action, target: e.target, times: 0, owners: e.owners ?? [] };
    g.times++;
    groups.set(key, g);
  }
  const causes = [...groups.values()].sort((a, b) => b.times - a.times);
  const retried = causes.reduce((n, g) => n + (g.about === "system" ? 0 : g.times - 1), 0);
  const hosts = causes.filter((g) => g.about === "network").slice(0, 10).map(({ target, times }) => ({ target, times }));
  // Batches of kernel messages the system log threw away during the run: its
  // walls may be missing some. The boundary held; the record did not.
  const dropped = all.filter((e) => e.event === "log-dropped").reduce((n, e) => n + (Number(e.batches) || 0), 0);
  const canaries = all.filter((e) => e.event === "canary");
  const canary = canaries.length ? canaries[canaries.length - 1] : null;
  const outcome = canaries.some((e) => e.confined === false) ? "refused" : denied ? "denied" : "clean";
  return {
    ...base,
    // A run.json that did not say when it started: the log's first line did.
    started_at: base.started_at ?? all.find((e) => e.at)?.at ?? null,
    ended_at: base.ended_at ?? [...all].reverse().find((e) => e.at)?.at ?? null,
    outcome,
    roles: Object.keys(cfg.roles),
    sandbox: canary?.sandbox ?? null,
    entries: all.length,
    denied,
    expected,
    byKind,
    retried,
    hosts,
    // Kept whole for the sum across runs, cut to RUN_CAUSES when sent.
    causes,
    canary: canary ? { confined: canary.confined !== false, reasons: canary.reasons ?? [] } : null,
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
  return out;
}

function matches(run, filters) {
  for (const f of FILTERS) if (filters[f] !== undefined && (run[f] ?? "") !== filters[f]) return false;
  if (filters.q) {
    const hay = [run.id, run.run_id, run.work_item, run.repo, run.team, run.role].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(filters.q)) return false;
  }
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
 * The same refusal across runs is one cause: summed by what was refused, with
 * how many runs hit it and which teams and roles they were.
 */
function causesAcross(runs) {
  const by = new Map();
  for (const r of runs) {
    for (const c of r.causes) {
      const k = `${c.action}\u0000${c.target}`;
      const g = by.get(k) ?? { action: c.action, target: c.target, about: c.about, owners: c.owners, times: 0, runs: 0, teams: new Set(), roles: new Set(), last: null };
      g.times += c.times;
      g.runs++;
      if (r.team) g.teams.add(r.team);
      if (r.role) g.roles.add(r.role);
      if (!g.last || (r.started_at && r.started_at > g.last.at)) g.last = { run: r.id, at: r.started_at };
      by.set(k, g);
    }
  }
  return [...by.values()]
    // The OS's own housekeeping last: it is in every run and nobody grants it.
    .sort((a, b) => (a.about === "system") - (b.about === "system") || b.runs - a.runs || b.times - a.times)
    .slice(0, CAUSES_SHOWN)
    .map((g) => ({ ...g, teams: [...g.teams], roles: [...g.roles], last: g.last?.run ?? null }));
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The global view: the runs that pass the filters, newest first, and what they add up to. */
const views = new Map();

export function runsView(dir, filters = {}, { scanned = scanRuns(dir) } = {}) {
  // The same runs and the same filters are the same answer: the poll asks
  // every two seconds, and summing the causes of six hundred runs was most
  // of what it cost once the runs themselves were remembered.
  const key = `${dir}\u0000${JSON.stringify(filters)}\u0000${scanned.sig}`;
  const hit = views.get(key);
  if (hit) return hit;
  const view = viewOf(dir, filters, scanned.runs);
  views.set(key, view);
  while (views.size > 8) views.delete(views.keys().next().value);
  return view;
}

function viewOf(dir, filters, every) {
  const shown = every.filter((r) => matches(r, filters))
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
  return {
    mode: "runs",
    dir,
    filters,
    total: every.length,
    facets: facetsOf(every),
    totals,
    causes: causesAcross(shown),
    runs: shown.map((r) => ({ ...r, causes: r.causes.slice(0, RUN_CAUSES) })),
    readOnly: true,
  };
}

/** One run's summary, by id; throws 404 for a name that is not a run here. */
export function runOf(dir, id) {
  if (!isRunId(id)) throw Object.assign(new Error(`not a run id: ${JSON.stringify(id)}`), { status: 400 });
  if (!runFolders(dir).includes(id)) throw Object.assign(new Error(`no run ${id} in ${dir}`), { status: 404 });
  const { runs } = scanRuns(dir);
  const r = runs.find((x) => x.id === id);
  return { ...r, causes: r.causes.slice(0, RUN_CAUSES) };
}
