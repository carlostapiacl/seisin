/**
 * A local server for the console, and the one place seisin keeps a process alive.
 *
 * Everything else here is a launcher: it runs, it exits, there is no state to
 * corrupt and nothing to restart. That property is worth protecting, so this is
 * scoped hard — the server is a **foreground command you start and stop**, it
 * serves one page and one JSON document, and nothing in the enforcement path
 * touches it. If it is not running, seisin loses a window, not a boundary.
 *
 * It binds to loopback only, and that is not decoration: the page shows which
 * key each role can read, which is a map of where the credentials live.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { read, logPath } from "./log.js";
import { settingsFor } from "./srt.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Everything the page needs, read fresh on each request.
 *
 * Read fresh rather than cached because the file on disk is the truth and the
 * page is a view of it — someone editing seisin.toml in an editor should see
 * the console change, not wonder why it disagrees.
 */
function state(configPath) {
  const cfg = loadConfig(configPath);
  const entries = read(logPath(cfg.root), { limit: 200 });

  const roles = Object.values(cfg.roles).map((r) => ({
    name: r.name,
    writes: r.writes,
    keys: r.keys,
    env: r.env,
    blocks: entries.filter((e) => e.role === r.name && e.verdict === "denied").length,
    settings: settingsFor(cfg, r.name),
  }));

  return {
    root: cfg.root,
    config: cfg.path,
    keyDirs: cfg.keyDirs,
    allowedDomains: cfg.allowedDomains,
    roles,
    log: entries.slice(-60).reverse(),
    live: true,
  };
}

export function serve(configPath, port = 4178) {
  const page = join(HERE, "..", "ui", "index.html");
  if (!existsSync(page)) throw new Error("the console is missing from this install");

  const server = createServer((req, res) => {
    if (req.url === "/api/state") {
      let body;
      try {
        body = JSON.stringify(state(configPath));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
      // The page polls, so tell every cache in between to stay out of it.
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(body);
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(page));
    }
    res.writeHead(404).end("not found");
  });

  return new Promise((ok, fail) => {
    // Loopback only. The page maps where every credential lives; it has no
    // business being reachable from the network the laptop happens to be on.
    server.listen(port, "127.0.0.1", () => ok(server));
    server.on("error", (e) =>
      fail(e.code === "EADDRINUSE"
        ? new Error(`port ${port} is busy — pass another with: seisin ui --port <n>`)
        : e));
  });
}
