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
import { read, logPath, size } from "../log.js";
import { renderEntry, C, out } from "../render.js";

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

export function log(config, argv = []) {
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
