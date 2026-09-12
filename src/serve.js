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
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { read, logPath } from "./log.js";
import { settingsFor } from "./srt.js";
import { pending, requestsPath, settle, applyGrant } from "./requests.js";

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
    requests: pending(requestsPath(cfg.root)),
    // The file itself, not a regeneration of it. The page can render a policy
    // from its own model, and that model has no comments — so showing it under
    // the heading "seisin.toml" next to "copy this back" invites someone to
    // paste away the provenance a grant just wrote.
    toml: readFileSync(cfg.path, "utf8"),
    keyDirs: cfg.keyDirs,
    allowedDomains: cfg.allowedDomains,
    roles,
    log: entries.slice(-60).reverse(),
    live: true,
  };
}

/**
 * Approve or refuse one pending request, as a person.
 *
 * This is the only thing in seisin that writes policy, and it lives here rather
 * than in the MCP server for one reason: an agent cannot reach this. Measured,
 * not assumed — a confined role curling this port gets the same nothing it gets
 * from a domain outside its allowlist, because the egress proxy does not make
 * an exception for loopback. That is what lets the console hold the half the
 * MCP server deliberately does not.
 */
function decide(configPath, { number, decision, reason }) {
  const cfg = loadConfig(configPath);
  const file = requestsPath(cfg.root);
  const req = pending(file)[Number(number) - 1];
  if (!req) throw new Error(`no pending request #${number}`);
  if (decision !== "granted" && decision !== "denied")
    throw new Error(`decision must be granted or denied`);

  if (decision === "granted") {
    // The config is edited as text, so comments and order survive. Written
    // before the queue is settled: if this throws, the request is still open
    // rather than marked done against a file that never changed.
    const { toml, changed } = applyGrant(readFileSync(cfg.path, "utf8"), req, reason);
    if (changed) writeFileSync(cfg.path, toml);
  }
  settle(file, req.key, decision, reason ?? "");
  return { ok: true, role: req.role, grant: req.grant, decision };
}

/** The body of a POST, capped: this endpoint takes three short fields. */
function readBody(req) {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c) => {
      s += c;
      if (s.length > 4096) { fail(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => ok(s));
  });
}

export function serve(configPath, port = 4178) {
  const page = join(HERE, "..", "ui", "index.html");
  if (!existsSync(page)) throw new Error("the console is missing from this install");

  /**
   * One secret per run, handed to the page and demanded back on every write.
   *
   * Loopback is not a boundary against the browser: any site the operator has
   * open can POST to 127.0.0.1. It cannot read this token, and asking for it in
   * a custom header also forces a preflight that this server never answers. So
   * the page can approve and a tab from somewhere else cannot.
   */
  const token = randomBytes(24).toString("hex");

  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/decide") {
      if (req.headers["x-seisin-token"] !== token) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "bad or missing token" }));
      }
      try {
        const out = decide(configPath, JSON.parse((await readBody(req)) || "{}"));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }
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
      // Inlined rather than put in the URL: a fragment survives in history, in
      // a screenshot, and in whatever the operator pastes into a chat.
      const html = readFileSync(page, "utf8")
        .replace("</head>", `<script>window.SEISIN_TOKEN=${JSON.stringify(token)}</script></head>`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
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
