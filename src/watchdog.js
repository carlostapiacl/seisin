/**
 * What happens to the agent when `seisin run` is killed outright.
 *
 * SIGKILL runs no handler, and the agent sits in a process group of its own, so
 * a kill of seisin's group leaves it running with nobody holding its record. A
 * process outside the group and the sandbox holds a pipe from the run: the pipe
 * closing with no "stop" on it means the run is gone, and it kills what it has
 * followed down from the runtime.
 *
 * Followed by parent pid, so a process that has already left the tree when it is
 * looked at (a double fork) is not found: that is a limit, said in docs/runs.md.
 * A pid is remembered with its start time, so a pid the system has handed to
 * something else since is never signalled.
 *
 * It gets an empty environment: a run's keys are in the parent's and have no
 * business here.
 */
import { spawn, execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCAN_MS = 2_000;

/** [{ pid, ppid, start }] of every process, by /proc where there is one, else ps. */
export function processTable(done) {
  if (process.platform === "linux") {
    const rows = [];
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // The name in parentheses may hold spaces: the fields count from its end.
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        rows.push({ pid: Number(name), ppid: Number(f[1]), start: f[19] });
      } catch {}                       // gone between the listing and the read
    }
    return done(rows);
  }
  execFile("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { env: { LC_ALL: "C" }, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
    if (e) return done([]);
    done(out.split("\n").flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] }] : [];
    }));
  });
}

/**
 * What is followed so far, with this table added: `known` is pid → start.
 * A pid whose start has changed is another process, and is dropped.
 */
export function follow(known, table) {
  const now = new Map(table.map((r) => [r.pid, r]));
  for (const [pid, start] of known) if (now.has(pid) && now.get(pid).start !== start) known.delete(pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of table)
      if (known.has(r.ppid) && !known.has(r.pid)) { known.set(r.pid, r.start); grew = true; }
  }
  return known;
}

/** The ones in `known` still alive as the same process. */
export const alive = (known, table) => table.filter((r) => known.get(r.pid) === r.start).map((r) => r.pid);

/** Started by the run, for its runtime's pid. `stop()` when the runtime has exited. */
export function startWatchdog(rootPid) {
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), String(rootPid)], {
      detached: true, env: {}, cwd: "/", stdio: ["pipe", "ignore", "ignore"],
    });
  } catch { return { stop() {} }; }
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.unref();
  child.stdin.unref?.();
  return { stop() { try { child.stdin.end("stop\n"); } catch {} } };
}

function main(rootPid) {
  const known = new Map();
  let scanning = false;
  const scan = (then) => {
    if (scanning && !then) return;
    scanning = true;
    processTable((table) => {
      scanning = false;
      if (known.size === 0) {
        const root = table.find((r) => r.pid === rootPid);
        if (root) known.set(rootPid, root.start);
      }
      follow(known, table);
      then?.(table);
    });
  };
  const timer = setInterval(scan, SCAN_MS);
  scan();

  let said = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { said += d; });
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => {
    clearInterval(timer);
    if (said.includes("stop")) process.exit(0);
    // A round for what was forked while the first was being killed.
    let rounds = 3;
    const sweep = () => scan((table) => {
      for (const pid of alive(known, table)) {
        if (pid === process.pid) continue;
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      if (--rounds > 0) setTimeout(sweep, 100);
      else process.exit(0);
    });
    sweep();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(Number(process.argv[2]));
