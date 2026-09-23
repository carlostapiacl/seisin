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
import { pending, requestsPath, settle, applyGrant, refuseIfBarred } from "./requests.js";
import { walls } from "./walls.js";
import { explain } from "./owners.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Everything the page needs, read fresh on each request.
 *
 * Read fresh rather than cached because the file on disk is the truth and the
 * page is a view of it — someone editing seisin.toml in an editor should see
 * the console change, not wonder why it disagrees.
 */
/**
 * Today's denials, grouped by what was denied rather than by who asked.
 *
 * Called `causes` and not `friction`: `seisin review` already has a `friction`
 * that counts something narrower — repeated denials that are not about keys —
 * and two screens of one product reporting different numbers under one label
 * is the kind of thing nobody notices until they are compared.
 *
 * The console used to show them per role, which is the same list a hundred
 * times over: measured on one deployment, 1,080 of 1,422 refusals were a
 * single lock file across six repositories, and per-role that reads as six
 * hundred identical rows instead of one sentence. Grouped, the shape of the
 * day is visible at a glance and it is almost never a territory dispute.
 *
 * `stillRefused` is recomputed against the policy as it stands, not read out
 * of the log — a cause that has been granted since is history, not friction,
 * and leaving it on the page sends somebody to fix what is already fixed.
 */
export function causesOf(cfg, entries) {
  const by = new Map();
  for (const e of entries) {
    if (e.verdict !== "denied" || !e.target || !e.action) continue;
    const k = `${e.action}\u0000${e.target}`;
    const g = by.get(k) ?? { action: e.action, target: e.target, times: 0, roles: new Set(), owners: e.owners ?? [] };
    g.times++;
    g.roles.add(e.role);
    by.set(k, g);
  }
  const total = [...by.values()].reduce((n, g) => n + g.times, 0);

  /**
   * The same grouping again, one level coarser: by the NAME at the end of the
   * path rather than the path.
   *
   * Grouping by path alone gets the most important reading backwards. Measured
   * here: six of the top seven causes were `.git/index.lock` in six different
   * repositories, no single one above 17% — so "no cause dominates" is what the
   * arithmetic says and the opposite of what is true. Three quarters of the
   * window was one *kind* of thing, and that is a tooling problem with a
   * mechanical fix, not a territory question anybody needs to rule on.
   *
   * By last segment, and nothing cleverer. A regex that recognised lock files,
   * caches and build outputs would be a list of guesses about other people's
   * toolchains that quietly goes stale; a repeated filename is a fact about
   * this log.
   */
  const fams = new Map();
  for (const g of by.values()) {
    const name = g.target.split("/").filter(Boolean).pop() ?? g.target;
    const f = fams.get(name) ?? { name, times: 0, paths: 0, where: [], roles: new Set() };
    f.times += g.times;
    f.paths++;
    // The places, so the console can show what a name is made of instead of
    // asserting a percentage the reader has to take on faith.
    f.where.push({ target: g.target, times: g.times });
    for (const r of g.roles) f.roles.add(r);
    fams.set(name, f);
  }
  const families = [...fams.values()]
    .sort((a, b) => b.times - a.times)
    .map((f) => ({
      name: f.name, times: f.times, paths: f.paths,
      share: total ? f.times / total : 0,
      roles: [...f.roles].sort(),
      where: f.where.sort((a, b) => b.times - a.times).slice(0, 20),
    }));

  /**
   * What a `grep` over the log cannot tell you.
   *
   * The headline used to be "74% of it is one name", and a field review
   * applied this project's own test to it: *did the number tell you something
   * you did not know?* For somebody who reads the raw log, no — they had
   * already counted that. The console was repeating the log back.
   *
   * These two are different, because they need the **policy** and the log does
   * not contain it. `unowned` is the count of causes on paths no role claims:
   * no grant resolves those until somebody decides who owns them, which is a
   * decision rather than a number. `settled` is friction that has since been
   * granted — real yesterday, noise today.
   */
  const live = [...by.values()];
  const unowned = live.filter((g) => !(g.owners ?? []).length).length;

  return {
    total,
    unowned,
    // The real number of distinct causes, not the length of the list below.
    // The page says "over N distinct paths" and the list is capped at twelve,
    // so taking N from the list reported the cap as if it were the count —
    // a wrong number stated confidently, which is worse than no number.
    distinct: by.size,
    families: families.slice(0, 8),
    causes: [...by.values()]
      .sort((a, b) => b.times - a.times)
      .slice(0, 12)
      .map((g) => ({
        action: g.action,
        target: g.target,
        times: g.times,
        share: total ? g.times / total : 0,
        roles: [...g.roles].sort(),
        owners: g.owners,
        // How many of the roles that hit this would still hit it. `some` and
        // not `every`: two roles out of three still blocked is still friction,
        // and requiring all of them would quietly retire a live cause the day
        // one role got a grant.
        stillRefused: [...g.roles].filter((r) => cfg.roles[r] && !explain(cfg, r, g.action, g.target).allowed).length,
      })),
  };
}

function state(configPath) {
  const cfg = loadConfig(configPath);
  const entries = read(logPath(cfg.root), { limit: 200 });
  // A wider window than the activity tail, because grouping by cause is an
  // arithmetic question and 200 lines of a busy day is one role's morning.
  const forShape = read(logPath(cfg.root), { limit: 4000 });

  const roles = Object.values(cfg.roles).map((r) => ({
    name: r.name,
    writes: r.writes,
    keys: r.keys,
    env: r.env,
    neverWrites: r.neverWritesDeclared ?? r.neverWrites ?? [],
    localBinding: r.localBinding === true,
    trustd: r.trustd === true,
    blocks: entries.filter((e) => e.role === r.name && e.verdict === "denied").length,
    settings: settingsFor(cfg, r.name),
  }));

  // Read once for every role's walls, rather than once per role.
  const whole = read(logPath(cfg.root), { verdict: "denied" });
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
    causes: causesOf(cfg, forShape),
    // What each role keeps being refused AND would still be refused today.
    // Empty for a role that has hit nothing twice, which is most of them.
    walls: Object.fromEntries(
      Object.keys(cfg.roles)
        .map((r) => [r, walls(cfg, r, { entries: whole })])
        .filter(([, w]) => w.length)),
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
    refuseIfBarred(cfg, req);
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

/**
 * Refuse every request the page was showing, in one go.
 *
 * Only refusing. There is no "approve all" and there will not be: a grant is a
 * decision about one path and one owner, and doing forty of them without
 * reading them is the permissive default this tool exists to stand against.
 * Refusing in bulk is safe — it grants nothing and changes no policy — and it
 * is what a queue full of noise from a bug already fixed needs.
 *
 * By key, not "whatever is pending now": a request that arrived after the page
 * drew is one the person has not seen, and it stays.
 */
function declineAll(configPath, { keys, reason }) {
  if (!Array.isArray(keys) || !keys.length) throw new Error("keys must list the requests on screen");
  const cfg = loadConfig(configPath);
  const file = requestsPath(cfg.root);
  const wanted = new Set(keys.map(String));
  let declined = 0;
  for (const req of pending(file)) {
    if (!wanted.has(req.key)) continue;
    settle(file, req.key, "denied", reason ?? "");
    declined++;
  }
  return { ok: true, declined };
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

  /**
   * Every route under /api/ asks for the token, reads included.
   *
   * The page used to be the only thing that carried the token and /api/state
   * answered anyone. Both rested on "an agent cannot reach loopback", and
   * `local_binding = true` on macOS makes that false: the runtime lets that
   * role connect to every localhost port, and loopback bypasses the egress
   * proxy. Reproduced end to end by a read-only review on 2026-09-22 — a role
   * read the token off `GET /`, posted to /api/decide, and approved its own
   * request into another role's territory. /api/state handed it the policy, the
   * log and where every key lives, with no token at all.
   *
   * So the token no longer travels in any response. `seisin ui` puts it in the
   * URL fragment, which a browser never sends to a server; the page takes it
   * from there, keeps it for the tab, and removes it from the address bar and
   * the history entry. Anything that fetches `/` gets a page with no token in it.
   */
  const authorized = (req) => req.headers["x-seisin-token"] === token;

  /**
   * The Host header has to name this server.
   *
   * A page on the operator's browser can point a hostname it controls at
   * 127.0.0.1 (DNS rebinding) and then read responses as same-origin. It still
   * could not produce the token, but the check is one line and makes the
   * question moot: the only names this server answers to are its own.
   */
  const hostOk = (req, port) => {
    const h = String(req.headers.host ?? "");
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };

  /**
   * The path, without whatever came after `?`.
   *
   * `req.url` is the raw request target, so a query string made every route
   * miss: `http://localhost:4178/?anything` answered 404 on the one page this
   * server has. Harmless until a launcher appends a parameter or a link is
   * shared with a suffix on it, and then the console just looks broken.
   */
  const pathOf = (u) => (u ?? "/").split("?")[0];

  const server = createServer(async (req, res) => {
    if (!hostOk(req, server.address()?.port)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("wrong host");
    }
    if (pathOf(req.url).startsWith("/api/") && !authorized(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "bad or missing token — open the URL `seisin ui` printed" }));
    }
    if (req.method === "POST" && pathOf(req.url) === "/api/decline-all") {
      try {
        const out = declineAll(configPath, JSON.parse((await readBody(req)) || "{}"));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }
    if (req.method === "POST" && pathOf(req.url) === "/api/decide") {
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
    if (pathOf(req.url) === "/api/state") {
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
    if (pathOf(req.url) === "/" || pathOf(req.url) === "/index.html") {
      // No token in here. It used to be inlined, which handed it to anything
      // that could GET this page — see `authorized` above.
      const html = readFileSync(page, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }
    res.writeHead(404).end("not found");
  });

  return new Promise((ok, fail) => {
    // Loopback only. The page maps where every credential lives; it has no
    // business being reachable from the network the laptop happens to be on.
    server.listen(port, "127.0.0.1", () => {
      // For `seisin ui`, which builds the URL, and for tests. Never sent.
      Object.defineProperty(server, "seisinToken", { value: token });
      ok(server);
    });
    server.on("error", (e) =>
      fail(e.code === "EADDRINUSE"
        ? new Error(`port ${port} is busy — pass another with: seisin ui --port <n>`)
        : e));
  });
}
