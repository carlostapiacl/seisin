/**
 * Everything that decides how output looks, and nothing that decides anything else.
 *
 * This exists because the commands used to do both. A function that computes a
 * verdict and paints it in the same breath can only be tested by running the
 * binary and matching a regular expression against its stdout — which is what
 * the suite was doing eight times, and which tests the renderer as much as the
 * logic. Split apart, the decision returns data and the test reads a field.
 *
 * Nothing here reads config, touches the filesystem, or exits. If a change to
 * this file could alter what seisin allows, it is in the wrong file.
 */

/**
 * ANSI codes, or empty strings when nobody is watching.
 *
 * Resolved once at import: a pipe does not become a terminal halfway through a
 * command. `NO_COLOR` is honoured because this prints into logs and CI.
 */
export const C =
  process.stdout.isTTY && !process.env.NO_COLOR
    ? {
        dim: "\x1b[2m", b: "\x1b[1m", off: "\x1b[0m",
        red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
      }
    : { dim: "", b: "", off: "", red: "", green: "", yellow: "", blue: "" };

export const out = (s) => process.stdout.write(s);
export const err = (s) => process.stderr.write(s);

/* ── the map ──────────────────────────────────────────────────────────── */

/**
 * A database's sidecars, shown as the database.
 *
 * `writes` carries the expansion because the grant and the sentence have to
 * agree — see config.js. Printing all four is then honest and unreadable: on a
 * real policy it turned eight databases into thirty-two rows of the same name
 * with three suffixes, which is what the expansion existed to remove.
 *
 * So the list is collapsed back for DISPLAY only, and only where the base is
 * present, and it says the sidecars are there rather than hiding them. A
 * sidecar declared without its database still prints on its own line — that is
 * unusual enough to be worth seeing.
 */
const SIDECAR_RE = /-(wal|shm|journal)$/;

export function collapseSidecars(paths) {
  const have = new Set(paths);
  const out = [];
  for (const p of paths) {
    const base = p.replace(SIDECAR_RE, "");
    if (SIDECAR_RE.test(p) && have.has(base)) continue;      // shown on its base
    out.push(SIDECAR_RE.test(p) || !have.has(p + "-wal") ? p : `${p}${C.dim}+wal+shm+journal${C.off}`);
  }
  return out;
}

/** The `check` report, as text. Takes the object `inspect()` returns. */
export function renderReport(report) {
  const lines = [`\n${C.b}${report.where}${C.off}\n\n`];
  const width = Math.max(...report.roles.map((r) => r.name.length), 4);

  for (const r of report.roles) {
    const writes = collapseSidecars(r.writes).join(" ") || `${C.dim}nothing${C.off}`;
    const keys = r.keys.length ? r.keys.join(" ") : `${C.dim}none${C.off}`;
    lines.push(`  ${C.b}${r.name.padEnd(width)}${C.off}  ${C.blue}writes${C.off} ${writes}\n`);
    // Only when present: absent is the default, and a "never_writes nothing" line
    // on every role is noise that teaches the reader to skip the one that matters.
    if (r.neverWrites?.length)
      lines.push(`  ${" ".repeat(width)}  ${C.yellow}never${C.off}  ${r.neverWrites.join(" ")}\n`);
    if (r.localBinding)
      lines.push(`  ${" ".repeat(width)}  ${C.yellow}listen${C.off} local ports (local_binding)\n`);
    lines.push(`  ${" ".repeat(width)}  ${C.green}keys${C.off}   ${keys}\n\n`);
  }

  if (report.providers?.length) {
    lines.push(`  ${C.b}key providers${C.off} ${C.dim}— seisin runs these itself, outside the sandbox, as you${C.off}\n`);
    for (const p of report.providers)
      lines.push(`  ${C.green}${p.name}${C.off}  ${p.command.join(" ")}${p.mode ? `  ${C.dim}(${p.mode})${C.off}` : ""}\n`);
    lines.push("\n");
  }

  for (const w of report.warnings) {
    lines.push(`  ${C.yellow}${w.headline}${C.off}\n`);
    if (w.detail) lines.push(`  ${C.dim}${w.detail}${C.off}\n`);
    lines.push("\n");
  }

  // Dim, and last: a standing limit is not an alarm, but it is not a footnote
  // either — it is the part of the map that is blank.
  for (const l of report.limits ?? []) {
    lines.push(`  ${C.dim}${l.headline}${C.off}\n`);
    if (l.detail) lines.push(`  ${C.dim}${l.detail}${C.off}\n`);
    lines.push("\n");
  }
  return lines.join("");
}

/* ── one verdict ──────────────────────────────────────────────────────── */

/** The `explain` answer, as text. Takes what `owners.explain()` returns. */
export function renderVerdict(role, action, target, verdict) {
  const head = verdict.allowed ? `${C.green}allowed${C.off}` : `${C.yellow}denied${C.off}`;
  return `\n  ${head}  ${C.b}${role}${C.off} ${action} ${target}\n  ${C.dim}${verdict.reason}${C.off}\n\n`;
}

/* ── the log ──────────────────────────────────────────────────────────── */

/**
 * One log entry, one line, always the same shape.
 *
 * Denials are amber and not red on purpose: a role stopped at its own border is
 * the system working, and painting routine correctness as an error teaches
 * people to stop reading the colour.
 */
export function renderEntry(e) {
  const mark =
    e.verdict === "denied" ? `${C.yellow}denied ${C.off}`
    : e.verdict === "observed" ? `${C.dim}seen   ${C.off}`
    : `${C.green}allowed${C.off}`;
  const owners =
    e.owners?.length && e.verdict === "denied" ? `  ${C.dim}→ ${e.owners.join(", ")}${C.off}` : "";
  // Which writer saw this. The hook reports an attempt and can be talked
  // around; the kernel reports a refusal and cannot. When the two disagree
  // about a run, a reader needs to know which line is which without going to
  // the file — so the one that carries more weight is the one that is marked.
  const from = e.source === "kernel" ? `  ${C.dim}[kernel]${C.off}` : "";
  return `  ${C.dim}${(e.at ?? "").slice(11, 19)}${C.off}  ${mark}  ${C.b}${e.role}${C.off} ${e.action} ${e.target}${owners}${from}\n`;
}

/* ── the scan ─────────────────────────────────────────────────────────── */

/**
 * Two lists, never one.
 *
 * A provider-issued string and a line that merely mentions a password are
 * different claims. Merging them is how a scanner earns a reputation for crying
 * wolf, and the first real run of this one returned 200 findings of which 2
 * mattered. The split is the whole reason the output is readable.
 */
export function renderScan(result, keyDirs) {
  const { certain, review, skipped, truncated } = result;
  const links = result.links ?? [];
  const where = keyDirs.length ? keyDirs.join(", ") : `${C.yellow}nowhere — [keys] dir is unset${C.off}`;
  const lines = [`\n  ${C.dim}protected: ${where}${C.off}\n\n`];

  if (certain.length === 0 && review.length === 0 && links.length === 0) {
    lines.push(`  ${C.green}nothing credential-shaped outside the declared directories${C.off}\n\n`);
    return lines.join("");
  }

  if (certain.length) {
    lines.push(`  ${C.red}${certain.length} credential(s)${C.off} — these shapes are issued, not written by accident\n\n`);
    for (const h of certain) lines.push(`    ${C.b}${h.file}${C.off}${C.dim}:${h.line}${C.off}  ${h.shape}\n`);
    lines.push("\n");
  }

  if (review.length) {
    const byFile = new Map();
    for (const h of review) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    lines.push(`  ${C.yellow}${review.length} line(s) to look at${C.off} in ${byFile.size} file(s) — a secret-shaped name with a literal value\n\n`);
    for (const [file, n] of [...byFile].slice(0, 15))
      lines.push(`    ${file}${C.dim}${n > 1 ? `  ×${n}` : ""}${C.off}\n`);
    if (byFile.size > 15) lines.push(`    ${C.dim}… and ${byFile.size - 15} more file(s)${C.off}\n`);
    lines.push("\n");
  }

  // Links are their own finding, not a line with a secret-shaped name in it.
  // What is reported is that the link leaves the repo — the destination is
  // named and never opened, because the point is that it exists.
  if (links.length) {
    lines.push(`  ${C.yellow}${links.length} symlink(s) out of the repo${C.off} — present in the tree, stored somewhere else\n\n`);
    for (const h of links.slice(0, 15)) lines.push(`    ${C.b}${h.file}${C.off} ${C.dim}→${C.off} ${h.shape}\n`);
    lines.push("\n");
  }

  // What was thrown away matters as much as what was kept: it is the only way
  // to tell a quiet scan from a broken one.
  const quiet = [];
  if (skipped.reference) quiet.push(`${skipped.reference} value(s) read from the environment`);
  if (skipped.placeholder) quiet.push(`${skipped.placeholder} placeholder(s)`);
  if (skipped.ignored) quiet.push(`${skipped.ignored} ignored path(s)`);
  if (skipped.protectedDirs) quiet.push(`${skipped.protectedDirs} inside declared key dir(s)`);
  if (quiet.length) lines.push(`  ${C.dim}not reported: ${quiet.join(" · ")}${C.off}\n`);
  if (truncated) lines.push(`  ${C.yellow}stopped at the limit — there are more${C.off}\n`);
  lines.push(`  ${C.dim}seisin does not move these. Where a credential lives is your call.${C.off}\n\n`);
  return lines.join("");
}
