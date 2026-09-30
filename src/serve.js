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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { read, logPath, logSegments } from "./log.js";
import { settingsFor } from "./srt.js";
import { pending, requestsPath, settle, applyGrant, refuseIfBarred, editPolicy, cleanReason } from "./requests.js";
import { causesOf, describeWalls, parseSince, queue, verdicts, wallsByRole } from "./views.js";
import { planEdit, hashOf } from "./controls.js";

// Moved to views.js, which the MCP server shares; kept importable from here.
export { causesOf } from "./views.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * `?since=<ISO date>`, or null for no filter. Anything that does not parse is
 * ignored rather than refused: a bad filter should show everything, not an error.
 */
export function sinceOf(url) {
  return parseSince(new URLSearchParams((url ?? "").split("?")[1] ?? "").get("since"));
}

/**
 * The files the state is made of, as they are on disk now: the policy's text,
 * and the size and mtime of every log segment and of the queue.
 *
 * It was read fresh on every request, because the file on disk is the truth
 * and the page is a view of it — someone editing seisin.toml in an editor
 * should see the console change. That still holds: anything that changes one
 * of these files changes the signature. What no longer happens is recomputing
 * 1–2 s of causes and walls every two seconds to find nothing had moved
 * (measured on the portfolio's log, 7,728 lines, 32 roles).
 */
const memo = { path: null, hash: null, bucket: null, cfg: null, logSig: null, all: null, derived: new Map(), bodies: new Map() };

/**
 * How long a loaded config and what was derived from it are trusted.
 *
 * Not everything the page shows is a function of these files. Some of it is
 * the disk around them — a key directory that became a symlink, a provider's
 * executable that appeared, a control file that now exists (settingsFor, the
 * walls' "would still be refused today") — and with the key made of file
 * signatures alone, that stayed as it was first seen for the server's life,
 * defeating the one-minute memory views.verdicts keeps for the same reason.
 * A minute is that memory's own span.
 */
const MEMO_SPAN = 60_000;

/** How many causes the page is sent; it shows twelve and says how many more. */
const CAUSES_SHOWN = 200;

function statSig(p) {
  try { const s = statSync(p); return `${p}:${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return `${p}:-`; }
}

function snapshot(configPath) {
  const text = readFileSync(configPath, "utf8");
  const hash = createHash("sha256").update(text).digest("hex");
  const bucket = Math.floor(Date.now() / MEMO_SPAN);
  if (memo.path !== configPath || memo.hash !== hash || memo.bucket !== bucket) {
    Object.assign(memo, { path: configPath, hash, bucket, cfg: loadConfig(configPath), logSig: null, all: null });
    memo.derived.clear();
    memo.bodies.clear();
  }
  const cfg = memo.cfg;
  const file = logPath(cfg.root);
  const logSig = logSegments(file).map(statSig).join("|");
  if (logSig !== memo.logSig) {
    memo.all = read(file);
    memo.logSig = logSig;
    memo.derived.clear();
  }
  return { cfg, text, all: memo.all, key: `${hash}|${bucket}|${logSig}|${statSig(requestsPath(cfg.root))}` };
}

/** Keeps the last few entries of a memo map. */
function remember(map, key, value, max = 4) {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

/**
 * Everything the page needs.
 *
 * Without each role's generated settings: they were 70 % of the 749 KB the
 * page downloaded every two seconds and it drew none of them. One role's are
 * served on demand by /api/settings.
 */
export function state(configPath, { since = null, snap = snapshot(configPath) } = {}) {
  const { cfg, text, all } = snap;

  // The date filter narrows everything read from the log: activity, causes,
  // walls and the per-role counts. Not the request queue, which is what is
  // waiting now whatever the window. (An entry with no `at` is kept, as
  // read({ since }) always did.)
  const derived = memo.derived.get(since) ?? remember(memo.derived, since, (() => {
    const win = since ? all.filter((e) => !(e.at < since)) : all;
    const blocks = new Map();
    for (const e of win) if (e.verdict === "denied") blocks.set(e.role, (blocks.get(e.role) ?? 0) + 1);
    const ask = verdicts(cfg);
    return {
      blocks,
      log: win.slice(-60).reverse(),
      // The whole window, not a tail. "All" used to mean the last 4000 lines, so a
      // 30-day window could show more denials than "all" did (6k against 4k on a
      // real log). Every count on the page comes from this list.
      // More than the MCP's twelve: the page lists twelve and offers the rest,
      // rather than cutting the list without saying so.
      causes: causesOf(cfg, win, { ask, limit: CAUSES_SHOWN }),
      // What each role keeps being refused AND would still be refused today.
      // Empty for a role that has hit nothing twice, which is most of them.
      walls: describeWalls(cfg, wallsByRole(cfg, win, { ask }), win),
    };
  })());

  const roles = Object.values(cfg.roles).map((r) => ({
    name: r.name,
    writes: r.writes,
    keys: r.keys,
    env: r.env,
    neverWrites: r.neverWritesDeclared ?? r.neverWrites ?? [],
    localBinding: r.localBinding === true,
    localPorts: r.localPorts ?? [],
    mcp: r.mcp ?? null,
    trustd: r.trustd === true,
    controlFiles: r.controlFiles ?? [],
    // Counted over the same window as the causes, so the KPI and the screen it
    // links to agree.
    blocks: derived.blocks.get(r.name) ?? 0,
  }));

  return {
    root: cfg.root,
    config: cfg.path,
    // Staleness is about the role's whole history, never the window: a request
    // is not old just because the filter hides the runs that made it old. The
    // whole log, every verdict, as `seisin requests` and the MCP read it — this
    // counted runs over denials only, and marked differently from both.
    requests: queue(cfg.root, all),
    since,
    // The file itself, not a regeneration of it. The page can render a policy
    // from its own model, and that model has no comments — so showing it under
    // the heading "seisin.toml" next to "copy this back" invites someone to
    // paste away the provenance a grant just wrote.
    toml: text,
    keyDirs: cfg.keyDirs,
    protect: { instructions: cfg.protect?.instructions === true },
    // What the control-files preview is computed against; a save sends it back
    // so a policy edited in between is not overwritten by a stale decision.
    base: hashOf(text),
    allowedDomains: cfg.allowedDomains,
    roles,
    causes: derived.causes,
    walls: derived.walls,
    log: derived.log,
    live: true,
  };
}

/**
 * `state` as the response body, the same string for as long as nothing on disk
 * moved — and a tag naming it, so a poll that already has it gets a 304 and
 * no body at all.
 */
function stateBody(configPath, since) {
  // One snapshot for the tag and the body. Each used to take its own, so a
  // file that moved between the two calls got a body filed under the tag of
  // what was there before — and a 304 for it until something else moved.
  const snap = snapshot(configPath);
  const k = `${snap.key}|${since}`;
  return memo.bodies.get(k) ?? remember(memo.bodies, k, {
    body: JSON.stringify(state(configPath, { since, snap })),
    etag: `"${createHash("sha256").update(k).digest("hex").slice(0, 24)}"`,
  });
}

/** One role's generated sandbox settings — what `seisin run` would hand the runtime. */
function settingsOf(configPath, role) {
  const { cfg } = snapshot(configPath);
  if (typeof role !== "string" || !Object.hasOwn(cfg.roles, role))
    throw Object.assign(new Error(`unknown role ${JSON.stringify(role)}`), { status: 404 });
  return settingsFor(cfg, role);
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
function decide(configPath, { key, decision, reason }) {
  /**
   * By the request's id, never by its place in the queue.
   *
   * It took a row number, counted against the queue as it stood when the
   * request arrived — not when the person read the page. Agents keep writing
   * to that queue, and another channel can settle an entry in between, so
   * "grant #2" could grant whatever had moved into second place, with the
   * reason typed for something else. Re-sending the POST granted the next one.
   * The CLI stopped doing this long ago; the console had not.
   */
  if (typeof key !== "string" || !key) throw bad("key is required — the id of the request on screen");
  /**
   * A person declines; the boundary denies. The console sends "declined".
   * "denied" is still accepted from anything that scripted against the old
   * value, and is what the queue stores either way — renaming a stored value
   * is a breaking change, listed in docs/glossary.md, not made here.
   */
  if (decision === "denied") decision = "declined";
  if (decision !== "granted" && decision !== "declined")
    throw bad(`decision must be granted or declined`);
  /**
   * A reason, always. A decision from the console used to be one click with an
   * optional box beside it, so most grants reached seisin.toml with no word of
   * why — and the provenance comment is the only record a later reader has.
   * The CLI can still be terse; a click is too easy to be.
   */
  if (typeof reason !== "string" || !cleanReason(reason))
    throw bad("a reason is required — it is written next to the decision");
  // It grants the folder the request is keyed by (docs/api.md asked, docs/**
  // granted), and the page says so before the click. Granting the one file
  // instead would need the queue to key by file: a later ask for a sibling
  // folds into this settled request and would never reach the queue.
  const cfg = loadConfig(configPath);
  const file = requestsPath(cfg.root);

  /**
   * Looked up, applied and settled under one lock — the policy's, the one
   * every grant takes (editPolicy). The lookup used to happen before it and
   * the settle after it, so the console and `seisin grant` could both find the
   * same request pending and both act on it. A decline takes the lock as well,
   * though it writes no policy, for the same reason.
   *
   * The config is edited as text, so comments and order survive, and it is
   * written before the queue is settled: if the write throws, the request is
   * still open rather than marked done against a file that never changed.
   */
  let req = null;
  let result = null;
  try {
    result = editPolicy(cfg, (before) => {
      req = pending(file).find((r) => r.key === key);
      if (!req) throw bad(`request ${key} is no longer pending — reload to see the queue as it is now`);
      if (decision !== "granted") return { toml: before, changed: false };
      refuseIfBarred(cfg, req);
      return applyGrant(before, req, reason);
    }, { after: () => settle(file, req.key, decision === "granted" ? "granted" : "denied", reason) });
  } catch (e) {
    if (e.code === "ELOCKED") throw Object.assign(new Error("another grant is in progress — try again in a moment"), { status: 503 });
    throw e;
  }
  return {
    ok: true, role: req.role, grant: req.grant, decision,
    // The line the grant wrote, and where, so the page can say exactly what
    // changed instead of "done". Null when nothing was written (a decline, or
    // a grant the policy already held).
    line: decision === "granted" && result?.changed ? grantLine(result.toml, req.grant) : null,
  };
}

/** Where a grant landed in the policy: the text of its line and its number. */
function grantLine(toml, grant) {
  const lines = toml.split("\n");
  for (let i = lines.length - 1; i >= 0; i--)
    if (lines[i].includes(`"${grant}"`) && lines[i].includes("# granted")) return { text: lines[i].trim(), number: i + 1 };
  return null;
}

/**
 * The lines an edit changes, and where: what the preview shows before a save
 * and the confirmation names after it. The file is edited in one place, so a
 * common head and tail leave exactly the lines that moved.
 */
export function lineDiff(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { at: head + 1, removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) };
}

/**
 * Hand a role a family of control files, or protect instruction files — the
 * second thing a person can change from the console, and the same kind of
 * write as a grant: through editPolicy, under the policy's lock, atomically,
 * with a stamp saying it came from here and when.
 *
 * `dryRun` answers what the edit would do — the denyWrite entries each role's
 * profile gains or loses, and who could then write each family — and writes
 * nothing. The page shows that and asks before it sends the real one. `base`
 * is the hash of the text the preview was computed from: a policy that moved
 * in between (a grant, an editor) is a 409, not a save over a decision the
 * person never saw.
 *
 * One edit per call: `{ role, families }` for a role, or `{ protect }` for
 * `[protect] instructions`. The families are config.js's own list; asking
 * for `.claude` or git hooks is a 400, as it is in the file.
 */
function controlFiles(configPath, args, { lockWaitMs = 10000 } = {}) {
  const { role, families, protect, reason, dryRun, base } = args;
  const forRole = role !== undefined || families !== undefined;
  if (forRole === (protect !== undefined))
    throw bad("send either { role, families } or { protect } — one edit at a time");
  if (reason !== undefined && typeof reason !== "string") throw bad("reason must be text");
  // Strictly a boolean: "true" as a string must not be read as a save.
  if (dryRun !== undefined && typeof dryRun !== "boolean") throw bad("dryRun must be true or false");
  if (base !== undefined && typeof base !== "string") throw bad("base must be the hash the preview returned");
  const edit = forRole ? { kind: "role", role, families, reason } : { kind: "protect", on: protect, reason };
  const cfg = loadConfig(configPath);
  // The roles an edit reaches, and of those the ones whose profile it leaves
  // as it is — named, so a preview that lists two roles does not read as
  // "the other five were forgotten".
  const reached = () => edit.kind === "role" ? [edit.role] : Object.keys(cfg.roles);
  const unaffected = (p) => p.changed ? reached(p).filter((r) => !p.diff.some((d) => d.role === r)) : [];
  if (dryRun === true) {
    const before = readFileSync(configPath, "utf8");
    const { toml, ...plan } = planEdit(cfg, before, edit);
    return { ok: true, dryRun: true, ...plan, unaffected: unaffected(plan), lines: plan.changed ? lineDiff(before, toml) : null };
  }
  let plan = null;
  let lines = null;
  try {
    editPolicy(cfg, (before) => {
      if (base !== undefined && hashOf(before) !== base)
        throw Object.assign(new Error("the policy changed since this preview — look at it again before saving"), { status: 409 });
      // Planned against the text under the lock, and against a config loaded
      // from it: a grant that landed a moment ago is kept, not overwritten.
      plan = planEdit(loadConfig(configPath, before), before, edit);
      if (plan.changed) lines = lineDiff(before, plan.toml);
      return { toml: plan.toml, changed: plan.changed };
    }, { waitMs: lockWaitMs });
  } catch (e) {
    if (e.code === "ELOCKED") throw Object.assign(new Error("another edit of the policy is in progress — try again in a moment"), { status: 503 });
    throw e;
  }
  const { toml, ...rest } = plan;
  return { ok: true, dryRun: false, ...rest, unaffected: unaffected(plan), lines };
}

/** An error that is the request's fault. */
function bad(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * The status for an error thrown while answering: its own when it has one; a
 * failed read or write of a file (it carries a syscall) is the server's; what
 * is left — a bad field, a grant the policy refuses — is the request's.
 */
function statusOf(e) {
  if (Number.isInteger(e?.status)) return e.status;
  return e?.syscall ? 500 : 400;
}

/**
 * A request body, capped. The cap is per route: one decision is a few hundred
 * bytes, but "decline all" carries every key on screen — 109 of them were
 * 9.3 KB, over the old flat 4 KB, and the connection was cut with nothing but
 * "Failed to fetch" in the browser. Found by Carlos on the first real use.
 *
 * Over the cap it is refused with 413, not cut: the caller answers first and
 * the connection is closed after the answer has gone (see `answer`).
 */
function readBody(req, max = 4096) {
  return new Promise((ok, fail) => {
    let s = "";
    let over = false;
    req.setEncoding("utf8");
    req.on("data", (c) => {
      if (over) return;
      s += c;
      if (Buffer.byteLength(s) > max) {
        over = true;
        s = "";
        fail(Object.assign(new Error(`body too large — this route takes at most ${max} bytes`), { status: 413 }));
      }
    });
    req.on("end", () => { if (!over) ok(s); });
    req.on("error", (e) => { if (!over) fail(Object.assign(e, { status: 400 })); });
  });
}

/**
 * Decline every request the page was showing, in one go.
 *
 * Only declining. There is no "grant all" and there will not be: a grant is a
 * decision about one path and one owner, and doing forty of them without
 * reading them is the permissive default this tool exists to stand against.
 * Declining in bulk is safe — it grants nothing and changes no policy — and it
 * is what a queue full of noise from a bug already fixed needs.
 *
 * By key, not "whatever is pending now": a request that arrived after the page
 * drew is one the person has not seen, and it stays. Under the policy lock,
 * like a single decision, so a grant from another channel cannot land between
 * the lookup and the settle.
 */
function declineAll(configPath, { keys, reason }) {
  if (!Array.isArray(keys) || !keys.length) throw bad("keys must list the requests on screen");
  if (typeof reason !== "string" || !cleanReason(reason))
    throw bad("a reason is required — it is written next to every request declined");
  const cfg = loadConfig(configPath);
  const file = requestsPath(cfg.root);
  const wanted = new Set(keys.map(String));
  let declined = 0;
  try {
    editPolicy(cfg, (before) => ({ toml: before, changed: false }), {
      after: () => {
        for (const req of pending(file)) {
          if (!wanted.has(req.key)) continue;
          settle(file, req.key, "denied", reason);
          declined++;
        }
      },
    });
  } catch (e) {
    if (e.code === "ELOCKED") throw Object.assign(new Error("another grant is in progress — try again in a moment"), { status: 503 });
    throw e;
  }
  return { ok: true, declined };
}

export function serve(configPath, port = 4178, { lockWaitMs = 10000 } = {}) {
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
  // Constant-time compare: `===` on a secret leaks its length and a prefix
  // through timing. Loopback with a Host check makes it near-theoretical, but a
  // role with local_binding can reach this port, so it is not free.
  const tokenBuf = Buffer.from(token);
  const authorized = (req) => {
    const got = req.headers["x-seisin-token"];
    if (typeof got !== "string") return false;
    const gotBuf = Buffer.from(got);
    return gotBuf.length === tokenBuf.length && timingSafeEqual(gotBuf, tokenBuf);
  };

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
    /**
     * A JSON answer. On an error the connection is closed once the answer has
     * gone: a body refused half-read would otherwise be parsed as the next
     * request on a keep-alive socket.
     */
    const answer = (status, obj, close = false) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(close && { connection: "close" }) });
      res.end(JSON.stringify(obj), () => { if (close) req.socket?.destroy(); });
    };
    const post = async (max, fn) => {
      let body;
      try { body = await readBody(req, max); }
      catch (e) { return answer(e.status ?? 400, { error: e.message }, true); }
      try {
        let args;
        try { args = JSON.parse(body || "{}"); } catch { throw bad("the body is not JSON"); }
        return answer(200, fn(args ?? {}));
      } catch (e) {
        return answer(statusOf(e), { error: e.message });
      }
    };
    // ~85 bytes per key: 1 MB is ten thousand requests on one screen.
    if (req.method === "POST" && pathOf(req.url) === "/api/decline-all")
      return post(1024 * 1024, (args) => declineAll(configPath, args));
    if (req.method === "POST" && pathOf(req.url) === "/api/decide")
      return post(4096, (args) => decide(configPath, args));
    if (req.method === "POST" && pathOf(req.url) === "/api/control-files")
      return post(4096, (args) => controlFiles(configPath, args, { lockWaitMs }));
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    if (pathOf(req.url).startsWith("/api/")) {
      // HEAD computed the whole state and threw the body away — a request that
      // cost what a GET does and answered nothing. The API is GET only.
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" });
        return res.end();
      }
      if (pathOf(req.url) === "/api/state") {
        let got;
        try {
          got = stateBody(configPath, sinceOf(req.url));
        } catch (e) {
          return answer(500, { error: e.message });
        }
        // The page polls, so tell every cache in between to stay out of it;
        // the page itself sends the tag back and is told when nothing moved.
        const head = { "content-type": "application/json", "cache-control": "no-store", etag: got.etag };
        if (req.headers["if-none-match"] === got.etag) { res.writeHead(304, head); return res.end(); }
        res.writeHead(200, head);
        return res.end(got.body);
      }
      if (pathOf(req.url) === "/api/settings") {
        try {
          const role = new URLSearchParams(req.url.split("?")[1] ?? "").get("role");
          return answer(200, { role, settings: settingsOf(configPath, role) });
        } catch (e) {
          return answer(e.status ?? 500, { error: e.message });
        }
      }
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
        // Keep the code on the rejection: `seisin ui` reads it to tell "a
        // console is already here, reopen its link" from any other failure.
        ? Object.assign(new Error(`port ${port} is busy — pass another with: seisin ui --port <n>`), { code: "EADDRINUSE" })
        : e));
  });
}
