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
import { read, logPath, size, verifyChain } from "../log.js";
import { renderEntry, C, out } from "../render.js";

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

export function log(config, argv = []) {
  if (argv[0] === "verify") return verify(config);
  const entries = read(logPath(config.root), {
    role: flag(argv, "--role"),
    verdict: flag(argv, "--verdict"),
    limit: Number(flag(argv, "--limit") ?? 40),
  });

  if (entries.length === 0) {
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
  const r = verifyChain(logPath(config.root));
  if (r.lines === 0) {
    out(`\n  ${C.dim}nothing recorded yet${C.off}\n\n`);
    return r;
  }
  const head = r.unchained ? `${r.unchained} line(s) from before the chain, then ` : "";
  if (!r.breaks.length) {
    out(`\n  ${C.green}intact${C.off}  ${head}${r.chained} chained line(s)\n\n`);
    return r;
  }
  out(`\n  ${C.red}broken${C.off}  ${head}${r.chained} chained line(s), ${r.breaks.length} break(s):\n`);
  for (const b of r.breaks.slice(0, 10))
    out(`    line ${b.line}: expected prev ${b.expected}, found ${b.found ?? "none"}\n`);
  out(`  ${C.dim}a line was edited, removed or reordered just before each of these${C.off}\n\n`);
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
