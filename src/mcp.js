/**
 * An MCP server over stdio. Read-only, by construction.
 *
 * The point of it: configuring a permission tool by hand-editing a config is
 * the reason permission tools get abandoned. Asking your own assistant "who
 * owns src/api, and what is frontend waiting on?" is the version of that people
 * actually do.
 *
 * ── What it cannot do, and how that is enforced ──
 * There is no tool here that changes anything. Not the policy, not the queue,
 * not a proposal file — nothing on disk is opened for writing by this process.
 * `seisin_draft_grant` returns text for a human to read and a command for them
 * to run; it does not stage a file, because a staged file is one `mv` away from
 * being policy and the whole invariant is that the last step belongs to a
 * person in a channel the agent does not have.
 *
 * If granting were a tool here, an agent holding it could widen its own
 * territory and the record would say a human did it. See
 * `docs/permission-requests.md`.
 *
 * ── Why there is no SDK ──
 * The official SDK pulls 91 packages and 26 MB — express, hono, cors, jose —
 * (counted against 1.30.0; it was 94 a version ago, which is the point)
 * for a server that speaks line-delimited JSON on two file descriptors. In a
 * tool people install to reduce their attack surface, that is the wrong trade.
 * The cost of this choice is written down under PROTOCOLS below: we track the
 * spec by hand, and the spec moves.
 */
import { toRepoRelative } from "./paths.js";
import { loadConfig, findConfig } from "./config.js";
import { inspect } from "./inspect.js";
import { explain, explainFileRead, ownersOf, readTarget } from "./owners.js";
import { CREDENTIAL_HOMES, expand } from "./grants.js";
import { settingsFor } from "./srt.js";
import { pending, requestsPath, refuseIfBarred, shellId } from "./requests.js";
import { read, logPath } from "./log.js";
import { causesOf, parseSince, queue as requestQueue, verdicts, wallsByRole } from "./views.js";
import { walls, wasted } from "./walls.js";
import { lineReader } from "./lines.js";

/**
 * Versions this server will agree to.
 *
 * Negotiation is "echo what the client asked for if we know it, otherwise offer
 * our newest". The 2026-07-28 revision made the core stateless and moved the
 * handshake into `_meta`, but for a stdio server exposing four read-only tools
 * the wire shape of `tools/list` and `tools/call` is unchanged — which is the
 * only reason hand-rolling this is defensible. If that stops being true, this
 * list is where it will show up first.
 */
const PROTOCOLS = ["2026-07-28", "2025-11-25", "2025-06-18"];
const NEWEST = PROTOCOLS[0];

const TOOLS = [
  {
    name: "seisin_state",
    description:
      "The map: every role, its territory (the folders it may write), the keys it may read, " +
      "and every way the policy silently does not hold. Read-only.",
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", description: "narrow to one role" } },
    },
  },
  {
    name: "seisin_explain",
    description:
      "Whether a role may read or write a path, and whose it is if not; or, with action mcp, " +
      "whether it may load an MCP server. Use this before suggesting an agent touch a file. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string" },
        action: { type: "string", enum: ["read", "write", "mcp"] },
        target: { type: "string", description: "path; key filename for a read; server name for mcp" },
      },
      required: ["role", "action", "target"],
    },
  },
  {
    name: "seisin_requests",
    description:
      "Requests: access agents asked for and cannot have yet, waiting on a person, with how many " +
      "times each was asked. A denial files one of these automatically, so this is where " +
      "to look after being denied rather than retrying. Read-only — granting is not " +
      "available here, by design.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "seisin_activity",
    description: "Recent log entries — allowed, denied or observed — newest last. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string" },
        verdict: { type: "string", enum: ["allowed", "denied", "observed"] },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "seisin_causes",
    description:
      "Denials grouped by what was denied — by path, and one level coarser by the name at " +
      "the end of it — over the whole log, or since an ISO date. The counts are history: " +
      "what was denied. What is measured against the policy as it stands is where each " +
      "path is now — `standing`: unowned (a decision nobody has made), owned, protected " +
      "(closed to every role on purpose, nothing to grant) or outside (a port, a key, or " +
      "outside the repository) — and, per cause, `stillRefused`, how many of the roles " +
      "that hit it would hit it today. An unowned cause also carries `kind` and `hint`: " +
      "git (lock or metadata), credential, temporary, build or territory, and the move " +
      "that fits it (`standing.unowned.kinds` counts them). Only `territory` is a question " +
      "of who owns what; do not propose an owner for the others — a lock, a test's scratch " +
      "or a credential given to whoever asked widens a role. " +
      "`seisin_activity` has the raw events; this has " +
      "them read against the policy. Reach for it before proposing a change: a day that " +
      "is three quarters one filename is a tooling problem, and the same volume spread " +
      "across unrelated unowned paths is a question about who owns what. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        since: { type: "string", description: "ISO date; only denials at or after it" },
      },
    },
  },
  {
    name: "seisin_walls",
    description:
      "What a role keeps being denied AND would still be denied today, with the calls it " +
      "spent retrying. Recomputed against the policy rather than read out of the log, so " +
      "something granted since is not listed. Use it to find out whether an agent is stuck " +
      "rather than slow. Omit `role` for every role that has one. Read-only.",
    inputSchema: { type: "object", properties: { role: { type: "string" } } },
  },
  {
    name: "seisin_draft_grant",
    description:
      "Draft the change a pending request would make, as text, plus the command a person " +
      "runs to apply it. Reach for this after a denial: it is already in " +
      "seisin_requests, and this turns it into a concrete proposal a person can grant. " +
      "Read-only, and it is the tool where that matters most: the name says grant and it " +
      "does not grant. Granting is a person's action, in another channel.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "the request's id from seisin_requests — preferred: it does not move when the queue does" },
        number: { type: "number", description: "position in seisin_requests (legacy; the draft still names the id)" },
      },
    },
  },
];

/* ── the tools ────────────────────────────────────────────────────────── */

function config() {
  const path = findConfig();
  if (!path) throw new Error('no seisin.toml found. Run "seisin init" in the repo first.');
  return loadConfig(path);
}

const HANDLERS = {
  seisin_state({ role }) {
    const cfg = config();
    const report = inspect(cfg, role ?? null, cfg.path);
    return {
      config: cfg.path,
      keyDirectories: cfg.keyDirs,
      roles: report.roles.map((r) => ({
        ...r,
        sandbox: settingsFor(cfg, r.name).filesystem,
      })),
      warnings: report.warnings,
      // The blank parts of the map travel with it. A model that can see the
      // policy and not its limits will confidently tell someone a file is safe.
      limits: report.limits,
    };
  },

  seisin_explain({ role, action, target }) {
    // The schema says enum: [read, write]. Nothing was checking, so anything
    // that was not "read" fell into the write branch — including a typo, which
    // would answer the wrong question confidently. A declared schema that is
    // not enforced is documentation.
    if (action !== "read" && action !== "write" && action !== "mcp")
      throw new Error(`action must be "read", "write" or "mcp", got ${JSON.stringify(action)}`);
    if (typeof role !== "string" || !role)
      throw new Error("role must be a non-empty string");
    if (typeof target !== "string" || !target)
      throw new Error("target must be a non-empty path");
    const cfg = config();
    if (!cfg.roles[role])
      return { error: `unknown role "${role}"`, known: Object.keys(cfg.roles) };
    if (action === "mcp") return explain(cfg, role, "mcp", target);
    // A read of a file outside every key dir is open, as it is for the CLI.
    // The server has no working directory of its own, so the root stands in.
    if (action === "read") {
      const asked = readTarget(cfg, target, cfg.root);
      return asked.key
        ? explain(cfg, role, "read", asked.target)
        : explainFileRead(cfg, role, asked.target, CREDENTIAL_HOMES.map(expand));
    }
    const rel = toRepoRelative(cfg, target);
    const verdict = explain(cfg, role, action, rel);
    return { ...verdict, alsoOwnedBy: action === "write" ? ownersOf(cfg, rel) : undefined };
  },

  seisin_requests() {
    const cfg = config();
    const queue = requestQueue(cfg.root, read(logPath(cfg.root)), cfg.keyDirs);
    return {
      pending: queue.map((r, i) => ({
        number: i + 1, id: r.key, role: r.role, action: r.action,
        wants: r.grant, ownedBy: r.owners, asked: r.times, lastAsked: r.last,
        ...(r.stale ? { stale: `not asked again in ${r.stale.runs} runs of ${r.role} since` } : {}),
      })),
      // Said in the payload and not only in the tool description, because a
      // model reading this is deciding what to do next.
      note: queue.length
        ? "Granting is not available through MCP. Ask a person to run: seisin grant '<id>'"
        : "nothing waiting",
    };
  },

  /**
   * The same arithmetic the console's front page does.
   *
   * It lives here as well as there because the two readers are different and
   * neither can do the other's work: a person opens the console, an agent
   * calls this. Giving the agent only `seisin_activity` hands it the raw log
   * and asks it to re-derive the grouping — without the policy, which is the
   * half that makes the grouping mean anything.
   */
  seisin_causes({ limit, since }) {
    const cfg = config();
    // The whole log, as the console reads it. This read the last 4000 lines
    // after the console had stopped doing so, and the two then disagreed about
    // the same log — 3,999 refusals here against 6,630 there, measured — with
    // nothing telling the agent its window was half of the person's.
    const from = parseSince(since);
    const c = causesOf(cfg, read(logPath(cfg.root), from ? { since: from } : {}), { ask: verdicts(cfg) });
    return {
      total: c.total,
      distinct: c.distinct,
      ...(from && { since: from }),
      unowned: c.unowned,
      standing: c.standing,
      families: c.families,
      causes: typeof limit === "number" ? c.causes.slice(0, limit) : c.causes,
    };
  },

  seisin_walls({ role }) {
    const cfg = config();
    if (role && !cfg.roles[role]) throw new Error(`unknown role "${role}"`);
    // One read of the log for every role, not one per role (32 on a real policy).
    const denied = read(logPath(cfg.root), { verdict: "denied" });
    const ask = verdicts(cfg);
    const byRole = role
      ? Object.fromEntries([[role, walls(cfg, role, { entries: denied, ask })]].filter(([, w]) => w.length))
      : wallsByRole(cfg, denied, { ask });
    const out = {};
    for (const [r, w] of Object.entries(byRole)) out[r] = { walls: w, spentRetrying: wasted(w) };
    return { roles: out, spentRetrying: Object.values(out).reduce((n, x) => n + x.spentRetrying, 0) };
  },

  seisin_activity({ role, verdict, limit }) {
    if (verdict !== undefined && !["allowed", "denied", "observed"].includes(verdict))
      throw new Error(`verdict must be allowed, denied or observed, got ${JSON.stringify(verdict)}`);
    const n = limit === undefined ? 30 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("limit must be 1..1000");
    const cfg = config();
    return { entries: read(logPath(cfg.root), { role, verdict, limit: n }) };
  },

  seisin_draft_grant({ id, number } = {}) {
    const cfg = config();
    const queue = pending(requestsPath(cfg.root), { keyDirs: cfg.keyDirs });
    let req;
    if (typeof id === "string" && id) {
      req = queue.find((r) => r.key === id);
      if (!req) throw new Error(`request ${id} is not pending`);
    } else {
      if (!Number.isInteger(Number(number)) || Number(number) < 1)
        throw new Error("id (preferred) or number from seisin_requests is required");
      req = queue[Number(number) - 1];
      if (!req) throw new Error(`no pending request #${number}`);
    }
    // The command is written against the id, whatever was asked with: a
    // number is a position in a queue agents keep writing to, and the person
    // runs this later, against the queue as it is then.
    const ref = shellId(req.key);

    // The same refusal `seisin grant` and the console apply, asked here first.
    // Without it this drafted, as approvable, a request that `never_writes`
    // cancels — and `grant` then refused what the draft had offered.
    try {
      refuseIfBarred(cfg, req);
    } catch (e) {
      return {
        barred: e.message,
        ownedBy: req.owners,
        applyWith: null,
        note: "Not approvable as it stands: never_writes wins over writes. Decline it with " +
          `\`seisin decline ${ref}\`, or remove the never_writes entry if the subtraction is wrong.`,
      };
    }
    const field = req.action === "read" ? "keys" : "writes";
    return {
      wouldAdd: { role: req.role, field, value: req.grant },
      preview: `[roles.${req.role}]\n${field} = [ …, "${req.grant}" ]   # asked ${req.times}×`,
      ownedBy: req.owners,
      id: req.key,
      applyWith: `seisin grant ${ref} --reason "<why>"`,
      note: "Not applied. seisin's MCP server writes nothing — a person runs the command above.",
    };
  },
};

/* ── the wire ─────────────────────────────────────────────────────────── */

/**
 * One session's state: where to write, and what version to claim.
 *
 * Injected rather than read from the process, because a server that writes to a
 * global cannot be exercised without patching the process it runs in — and a
 * test that patches `process.stdout` also captures the test runner's own
 * output, which is how these tests failed the first time they were written.
 */
function handle(message, { write, version }) {
  const send = (m) => write(JSON.stringify(m) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, msg) => send({ jsonrpc: "2.0", id, error: { code, message: msg } });

  const { id, method } = message;
  // `?? {}` so an explicit null params (not just missing) does not crash the
  // dispatcher and leave the request unanswered.
  const params = message.params ?? {};

  // A notification has no id and takes no answer. Replying to one is a protocol
  // error that some clients tolerate and others hang on.
  if (id === undefined) return;

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : NEWEST,
        capabilities: { tools: {} },
        serverInfo: { name: "seisin", title: "seisin — folders and keys per agent", version },
        instructions:
          "Read-only view of this repo's roles, territories and keys. Ask seisin_explain before " +
          "suggesting an agent edit a file it may not own. Granting is not available " +
          "here: surface seisin_requests and let a person run `seisin grant`.",
      });
    }
    case "ping":
      return reply(id, {});
    case "server/discover":            // 2026-07-28 clients ask up front
      return reply(id, { capabilities: { tools: {} }, tools: TOOLS });
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      // hasOwn, not a bare lookup: `params.name` of "constructor" or
      // "hasOwnProperty" would otherwise resolve to a function on Object's
      // prototype and be invoked as a tool.
      const fn = Object.hasOwn(HANDLERS, params.name) ? HANDLERS[params.name] : null;
      if (typeof fn !== "function") return fail(id, -32602, `unknown tool ${JSON.stringify(params.name)}`);
      try {
        const result = fn(params.arguments ?? {});
        // Content, not a bare object: every client renders `content`, and only
        // some read `structuredContent`. Both are sent.
        return reply(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        // A failing tool is an error the model should see and work around, not
        // a transport error that kills the session.
        return reply(id, { content: [{ type: "text", text: `seisin: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

/** Reads line-delimited JSON-RPC until the input closes. */
export function serveMcp(version = "0.0.0", input = process.stdin, output = process.stdout) {
  const ctx = { version, write: (s) => output.write(s) };
  input.setEncoding("utf8");
  input.on("data", lineReader((line) => {
    try {
      handle(JSON.parse(line), ctx);
    } catch {
      // Unparseable input has no id to answer to, so there is nobody to tell.
      // Staying alive is the only useful response.
    }
  }));

  return new Promise((done) => input.on("end", done));
}

export { TOOLS, HANDLERS, PROTOCOLS };
