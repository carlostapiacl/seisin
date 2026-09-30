/**
 * `seisin log` and `seisin watch` — reading the record.
 *
 * Both are views of one append-only file and nothing else. `watch` is a tail:
 * there is no daemon, because the file already is the shared state, so anything
 * that can read it can follow it.
 *
 * Reading is the easy half. Writing goes through spool.js when the writer is
 * inside a sandbox, so that the record is not editable by what it records.
 */
import { createReadStream, watch as watchDir } from "node:fs";
import { dirname, relative } from "node:path";
import { read, logPath, size, verifyLog, LOG_NAME } from "../log.js";
import { renderEntry, C, out } from "../render.js";

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const VERDICTS = ["allowed", "denied", "observed"];

export function log(config, argv = []) {
  if (argv[0] === "verify") return verify(config);
  const role = flag(argv, "--role");
  const verdict = flag(argv, "--verdict");
  const limit = flag(argv, "--limit") ?? "40";
  // Checked, because a filter that matches nothing reads as an empty log.
  if (verdict !== undefined && !VERDICTS.includes(verdict))
    throw new Error(`unknown verdict "${verdict}" — use allowed, denied or observed`);
  if (!/^[1-9]\d*$/.test(limit)) throw new Error(`--limit takes a positive number, got "${limit}"`);
  // A role that is not in the policy is still a fair question: the log keeps
  // the lines of a role that was renamed or removed. The empty answer says so.
  const entries = read(logPath(config.root), { role, verdict, limit: Number(limit) });

  if (entries.length === 0) {
    // Say which: nothing at all, or nothing for this filter.
    const any = role || verdict ? read(logPath(config.root), { limit: 1000 }) : [];
    if (any.length) {
      const others = [...new Set(any.map((e) => e.role).filter(Boolean))];
      out(`\n  ${C.dim}no entries for ${[role && `role ${role}`, verdict && `verdict ${verdict}`].filter(Boolean).join(", ")} — ` +
        `the log has ${any.length === 1000 ? "1000+" : any.length} for ${others.join(", ") || "other filters"}${C.off}\n\n`);
      return entries;
    }
    out(`\n  ${C.dim}nothing recorded yet — run an agent through "seisin run"${C.off}\n\n`);
    return entries;
  }
  out("\n" + entries.map(renderEntry).join(""));
  const denied = entries.filter((e) => e.verdict === "denied").length;
  out(`\n  ${C.dim}${entries.length} entries · ${denied} denied${C.off}\n\n`);
  return entries;
}

/**
 * `seisin log verify` — does the chain hold?
 *
 * Exit 1 when it does not, so it can sit in CI or a pre-commit hook. Lines from
 * before the chain existed are reported as such, not as tampering.
 */
function verify(config) {
  const r = verifyLog(logPath(config.root));
  if (r.lines === 0) {
    out(`\n  ${C.dim}nothing recorded yet${C.off}\n\n`);
    return r;
  }
  const head = r.unchained ? `${r.unchained} line(s) from before the chain, then ` : "";
  const segs = r.segments > 1 ? ` across ${r.segments} segments` : "";
  // A dropped entry leaves no hole in the chain, so it is reported on its own
  // line rather than as a break: nothing was tampered with, but something is
  // missing, and an intact chain must not read as a complete record.
  const dropped = r.dropped
    ? `  ${C.yellow}${r.dropped} entr${r.dropped === 1 ? "y was" : "ies were"} never written${C.off}  another writer held the lock too long; see ${LOG_NAME}.dropped\n`
    : "";
  // Where the chain starts is only checked once it has been recorded. Until
  // then a log whose chain was stripped or rewritten whole reads like an
  // intact one — so with chained lines and no record this is a warning, not a
  // footnote. A record made after chained lines already stood pins whatever
  // they said by then, and says so.
  let genesis = "";
  if (r.genesis === "unrecorded" && r.chained)
    genesis = `  ${C.yellow}where the chain starts is not recorded${C.off} — a chain stripped or rewritten from its first line would not show here.\n` +
      `  ${C.dim}the next entry records it, marked late: tampering before that cannot be excluded${C.off}\n`;
  else if (r.genesis === "unrecorded" && r.unchained)
    genesis = `  ${C.dim}where the chain starts is not recorded yet — it will be on the next entry${C.off}\n`;
  else if (r.genesis === "pruned")
    genesis = `  ${C.dim}the oldest segments were rotated away; the chain is checked from the oldest one kept${C.off}\n`;
  else if (r.late)
    genesis = `  ${C.yellow}start recorded late${C.off}${r.late.at ? ` (${r.late.at})` : ""}, after ${r.late.after ?? "some"} chained line(s) — earlier tampering cannot be excluded\n`;
  if (!r.breaks.length) {
    out(`\n  ${C.green}intact${C.off}  ${head}${r.chained} chained line(s)${segs}\n${genesis}${dropped}\n`);
    return r;
  }
  out(`\n  ${C.red}broken${C.off}  ${head}${r.chained} chained line(s), ${r.breaks.length} break(s):\n`);
  const foreign = r.breaks.find((b) => b.foreign);
  for (const b of r.breaks.slice(0, 10)) {
    if (b.foreign) out(`    the genesis record belongs to another log: it pins a different start (${LOG_NAME}.genesis)\n`);
    else out(`    line ${b.line}: expected prev ${b.expected}, found ${b.found ?? "none"}\n`);
  }
  if (foreign)
    out(`  ${C.dim}if ${LOG_NAME} was archived or replaced by hand, move ${LOG_NAME}.genesis along with the archived log;\n` +
      `  or remove it, and the next entry records this log's start (marked late). If nobody replaced the log,\n` +
      `  it was rewritten from its first line.${C.off}\n`);
  if (r.breaks.some((b) => !b.foreign))
    out(`  ${C.dim}a line was edited, removed or reordered just before each of these${C.off}\n`);
  out(`${genesis}${dropped}\n`);
  process.exitCode = 1;
  return r;
}

/**
 * Follows the log from wherever it is now.
 *
 * Watches the *directory*, not the file: the log may not exist yet when watch
 * starts, and a watcher on a missing path is a watcher on nothing. The interval
 * is the floor, because filesystem events are advisory on every platform that
 * has them and absent on the ones that do not.
 */
export function watch(config, { interval = 500 } = {}) {
  const file = logPath(config.root);
  let at = size(file);
  out(`\n  ${C.dim}watching ${relative(process.cwd(), file)} — ctrl-c to stop${C.off}\n\n`);

  const drain = () => {
    const end = size(file);
    if (end <= at) { at = end; return; }   // truncated, or nothing new
    const stream = createReadStream(file, { start: at, end: end - 1, encoding: "utf8" });
    at = end;
    let buf = "";
    stream.on("data", (d) => (buf += d));
    stream.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try { out(renderEntry(JSON.parse(line))); } catch { /* half-written line */ }
      }
    });
  };

  try { watchDir(dirname(file), () => drain()); } catch { /* platform without events */ }
  return setInterval(drain, interval);
}
