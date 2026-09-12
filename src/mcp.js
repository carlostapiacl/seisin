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
 * The official SDK pulls 94 packages and 26 MB — express, hono, cors, jose —
 * for a server that speaks line-delimited JSON on two file descriptors. In a
 * tool people install to reduce their attack surface, that is the wrong trade.
 * The cost of this choice is written down under PROTOCOLS below: we track the
 * spec by hand, and the spec moves.
 */
import { loadConfig, findConfig } from "./config.js";
import { inspect } from "./inspect.js";
import { explain, ownersOf } from "./owners.js";
import { settingsFor } from "./srt.js";
import { pending, requestsPath, grantFor } from "./requests.js";
import { read, logPath } from "./log.js";

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
      "Permissions agents were refused and are waiting on a human for, with how many " +
      "times each was asked. Read-only — approving is not available here, by design.",
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
    name: "seisin_draft_grant",
    description:
      "Draft the change a pending request would make, as text, plus the command a person " +
      "runs to apply it. Writes nothing: the approval is a human action in another channel.",
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
    const cfg = config();
    if (!cfg.roles[role])
      return { error: `unknown role "${role}"`, known: Object.keys(cfg.roles) };
    const verdict = explain(cfg, role, action, target);
    return { ...verdict, alsoOwnedBy: action === "write" ? ownersOf(cfg, target) : undefined };
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

  seisin_activity({ role, verdict, limit }) {
    const cfg = config();
    return { entries: read(logPath(cfg.root), { role, verdict, limit: limit ?? 30 }) };
  },

  seisin_draft_grant({ number }) {
    const cfg = config();
    const req = pending(requestsPath(cfg.root))[Number(number) - 1];
    if (!req) throw new Error(`no pending request #${number}`);

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
