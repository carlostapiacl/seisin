/**
 * Tell a person when a request is filed.
 *
 * The queue is where a refusal becomes a handoff, and a queue only works if
 * somebody looks at it. It was asynchronous with nothing to say it had moved:
 * the handoff existed and the person did not know. This sends one message per
 * new request — the role, the path, whose it is, and the command that answers
 * it — to wherever the operator reads things (ntfy, Slack, a webhook).
 *
 * Approving is still a person at a terminal. This only notifies; it does not
 * accept an answer, so it changes nothing about who decides. (Accepting one —
 * nono's `approval-webhook-v1` — would, and is a separate decision.)
 *
 * Two rules, both from the review that found a role approving its own request
 * through the console:
 *   - the POST leaves from the parent, never from the role: the role's process
 *     never holds the URL, and `SEISIN_NOTIFY_URL` is dropped from its
 *     environment even if the role names it;
 *   - the URL is not readable from any territory. A ntfy topic or a webhook is
 *     a credential — whoever can read it can send the person a fake "grant
 *     #3". So it lives in a key directory no role declares (`url_file`), or in
 *     the parent's environment, and never as a plain value in seisin.toml,
 *     which every role can read.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { keyOf, pending, requestsPath, grantFor, shellId, queueOf, withHandoffs } from "./requests.js";
import { describeHandoff } from "./handoff.js";

import { ENV_URL, FORMATS } from "./notify-config.js";

export { readNotify } from "./notify-config.js";

/** The URL to notify, or null. Read in the parent only. */
function notifyUrl(config, env = process.env) {
  if (env[ENV_URL]) return env[ENV_URL].trim();
  if (!config.notify?.urlFile) return null;
  try {
    const url = readFileSync(join(config.root, config.notify.urlFile), "utf8").trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * The body for one request, in the chosen format.
 *
 * Whose it is and where it goes are the queue's decision (handoff.js), the
 * same one `seisin requests` prints; a request handed in without one is
 * decided here by the same function, never described from its stored owners.
 */
export function message(config, req, number, format = "text") {
  const d = req.handoff ?? withHandoffs(config, [{ ...req, key: keyOf(req) }])[0].handoff;
  const owners = d.owners ?? [];
  const where = describeHandoff(d, req.attempt);
  const owner = (owners.length ? `It belongs to ${owners.join(", ")}.` : "Nobody owns it.") +
    (where ? ` ${where[0].toUpperCase()}${where.slice(1)}.` : "");
  const text =
    `seisin (${basename(config.root)}): ${req.role} was denied ${req.action} on ${req.target}. ${owner} ` +
    `Grant: seisin grant ${shellId(keyOf(req))} · decline: seisin decline ${shellId(keyOf(req))}`;
  // Slack reads `<url|label>` as a link and `<!channel>` as a mention, and the
  // path is chosen by the agent: `<https://evil|approve here>` in a target
  // would arrive as a clickable link in the channel a person approves from.
  // Its own escaping, and only these three characters, is what it asks for.
  if (format === "slack")
    return { type: "application/json", body: JSON.stringify({ text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }) };
  if (format === "json")
    return {
      type: "application/json",
      body: JSON.stringify({
        text, repo: basename(config.root), number, id: keyOf(req), role: req.role, action: req.action,
        target: req.target, owners, grant: grantFor(req), handoff: d,
      }),
    };
  return { type: "text/plain; charset=utf-8", body: text };
}

/**
 * One per run. `maybe(req)` after a request is recorded; `settle()` before the
 * run exits, so a message still in flight is not cut off.
 *
 * Only the first time a request appears — the queue already counts repeats,
 * and a person pinged on every retry stops reading the pings.
 */
export function notifier(config, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const url = notifyUrl(config, env);
  const format = env.SEISIN_NOTIFY_FORMAT && FORMATS.includes(env.SEISIN_NOTIFY_FORMAT)
    ? env.SEISIN_NOTIFY_FORMAT
    : config.notify?.format ?? "text";
  const file = requestsPath(config.root);
  const known = url ? new Set(pending(file).map((p) => p.key)) : new Set();
  const inflight = [];
  const failures = [];

  function maybe(req) {
    if (!url) return false;
    const key = keyOf(req);
    if (known.has(key)) return false;
    known.add(key);
    const queue = queueOf(config);
    const number = queue.findIndex((p) => p.key === key) + 1;
    if (number < 1) return false;
    const { type, body } = message(config, queue[number - 1], number, format);
    inflight.push(
      fetchImpl(url, {
        method: "POST",
        headers: { "content-type": type },
        body,
        // A redirect would send the request to a place nobody configured.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then((r) => { if (!r.ok) failures.push(`HTTP ${r.status}`); })
        // Native fetch errors can embed the whole URL, including a webhook
        // credential. Only report known categories, never the raw message.
        .catch((e) => failures.push(notificationFailure(e))),
    );
    return true;
  }

  async function settle(capMs = timeoutMs + 500) {
    if (!inflight.length) return failures;
    let timer;
    try {
      await Promise.race([Promise.allSettled(inflight), new Promise((ok) => { timer = setTimeout(ok, capMs); })]);
    } finally {
      clearTimeout(timer);
    }
    return failures;
  }

  return { enabled: !!url, maybe, settle };
}

function notificationFailure(error) {
  if (error?.name === "TimeoutError") return "timed out";
  if (error?.name === "AbortError") return "aborted";
  const code = error?.cause?.code ?? error?.code;
  if (code === "ERR_INVALID_URL") return "invalid URL";
  if (code === "ENOTFOUND") return "host not found";
  if (code === "ECONNREFUSED") return "connection unavailable";
  return "request failed";
}
