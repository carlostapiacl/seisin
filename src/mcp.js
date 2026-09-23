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
import { explain, ownersOf } from "./owners.js";
import { settingsFor } from "./srt.js";
import { pending, requestsPath, grantFor, refuseIfBarred } from "./requests.js";
import { read, logPath } from "./log.js";
import { causesOf } from "./serve.js";
import { walls, wasted } from "./walls.js";

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
      "The permission map: every role, the folders it may write, the keys it may read, " +
      "and every way the policy silently does not hold. Read-only.",
    inputSchema: {
      type: "object",
      properties: { role: { type: "string", description: "narrow to one role" } },
    },
  },
  {
    name: "seisin_explain",
    description:
      "Whether a role may read or write a path, and whose it is if not. " +
      "Use this before suggesting an agent touch a file. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string" },
        action: { type: "string", enum: ["read", "write"] },
        target: { type: "string", description: "path, or key filename for a read" },
      },
      required: ["role", "action", "target"],
    },
  },
  {
    name: "seisin_requests",
    description:
      "Permissions agents asked for and cannot have yet, waiting on a human, with how many " +
      "times each was asked. A refusal files one of these automatically, so this is where " +
      "to look after being denied rather than retrying. Read-only — approving is not " +
      "available here, by design.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "seisin_activity",
    description: "Recent allow/deny decisions, newest last. Read-only.",
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
      "the end of it — with how many are on paths no role owns. This is the question " +
      "`seisin_activity` cannot answer: the raw log has the events, this has them counted " +
      "against the policy as it stands, so a cause that has been granted since stops " +
      "counting. Reach for it before proposing a change: a day that is three quarters one " +
      "filename is a tooling problem, and the same volume spread across unrelated paths is " +
      "a question about who owns what. Read-only.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
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
      "runs to apply it. Reach for this after a refusal: the denial is already in " +
      "seisin_requests, and this turns it into a concrete proposal someone can approve. " +
      "Read-only, and it is the tool where that matters most: the name says grant and it " +
      "does not grant. The approval is a human action in another channel.",
    inputSchema: {
      type: "object",
      properties: { number: { type: "number", description: "position in seisin_requests" } },
      required: ["number"],
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
    if (action !== "read" && action !== "write")
      throw new Error(`action must be "read" or "write", got ${JSON.stringify(action)}`);
    if (typeof target !== "string" || !target)
      throw new Error("target must be a non-empty path");
    const cfg = config();
    if (!cfg.roles[role])
      return { error: `unknown role "${role}"`, known: Object.keys(cfg.roles) };
    const rel = toRepoRelative(cfg, target);
    const verdict = explain(cfg, role, action, rel);
    return { ...verdict, alsoOwnedBy: action === "write" ? ownersOf(cfg, rel) : undefined };
  },

  seisin_requests() {
    const cfg = config();
    const queue = pending(requestsPath(cfg.root));
    return {
      pending: queue.map((r, i) => ({
        number: i + 1, role: r.role, action: r.action,
        wants: r.grant, ownedBy: r.owners, asked: r.times, lastAsked: r.last,
      })),
      // Said in the payload and not only in the tool description, because a
      // model reading this is deciding what to do next.
      note: queue.length
        ? "Approving is not available through MCP. Tell the operator to run: seisin grant <number>"
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
  seisin_causes({ limit }) {
    const cfg = config();
    const c = causesOf(cfg, read(logPath(cfg.root), { limit: 4000 }));
    return {
      total: c.total,
      distinct: c.distinct,
      unowned: c.unowned,
      families: c.families,
      causes: typeof limit === "number" ? c.causes.slice(0, limit) : c.causes,
    };
  },

  seisin_walls({ role }) {
    const cfg = config();
    const file = logPath(cfg.root);
    const names = role ? [role] : Object.keys(cfg.roles);
    if (role && !cfg.roles[role]) throw new Error(`unknown role "${role}"`);
    const out = {};
    for (const r of names) {
      const w = walls(cfg, r, { file });
      if (w.length) out[r] = { walls: w, spentRetrying: wasted(w) };
    }
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

  seisin_draft_grant({ number }) {
    if (!Number.isInteger(Number(number)) || Number(number) < 1)
      throw new Error("number must be a positive integer from seisin_requests");
    const cfg = config();
    const req = pending(requestsPath(cfg.root))[Number(number) - 1];
    if (!req) throw new Error(`no pending request #${number}`);

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
          `\`seisin decline ${number}\`, or remove the never_writes entry if the subtraction is wrong.`,
      };
    }
    const field = req.action === "read" ? "keys" : "writes";
    return {
      wouldAdd: { role: req.role, field, value: req.grant },
      preview: `[roles.${req.role}]\n${field} = [ …, "${req.grant}" ]   # asked ${req.times}×`,
      ownedBy: req.owners,
      applyWith: `seisin grant ${number} --reason "<why>"`,
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

  const { id, method, params = {} } = message;

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
          "Read-only view of this repo's agent permissions. Ask seisin_explain before " +
          "suggesting an agent edit a file it may not own. Granting is not available " +
          "here: surface seisin_requests and let the operator run `seisin grant`.",
      });
    }
    case "ping":
      return reply(id, {});
    case "server/discover":            // 2026-07-28 clients ask up front
      return reply(id, { capabilities: { tools: {} }, tools: TOOLS });
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const fn = HANDLERS[params.name];
      if (!fn) return fail(id, -32602, `unknown tool "${params.name}"`);
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
  let buffer = "";

  input.on("data", (chunk) => {
    buffer += chunk;
    // A megabyte with no newline in it is not a JSON-RPC message, it is a
    // client — or something wearing one — filling this process's memory.
    // spool.js already caps its input; this one did not.
    if (buffer.length > 1_000_000) {
      buffer = "";
      return;
    }
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line), ctx);
      } catch {
        // Unparseable input has no id to answer to, so there is nobody to tell.
        // Staying alive is the only useful response.
      }
    }
  });

  return new Promise((done) => input.on("end", done));
}

export { TOOLS, HANDLERS, PROTOCOLS };
