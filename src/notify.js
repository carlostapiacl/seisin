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
 *     a credential — whoever can read it can send the person a fake "approve
 *     #3". So it lives in a key directory no role declares (`url_file`), or in
 *     the parent's environment, and never as a plain value in seisin.toml,
 *     which every role can read.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { keyOf, pending, requestsPath, grantFor } from "./requests.js";

export const FORMATS = ["text", "json", "slack"];
export const ENV_URL = "SEISIN_NOTIFY_URL";

/** The URL to notify, or null. Read in the parent only. */
export function notifyUrl(config, env = process.env) {
  if (env[ENV_URL]) return env[ENV_URL].trim();
  if (!config.notify?.urlFile) return null;
  try {
    const url = readFileSync(join(config.root, config.notify.urlFile), "utf8").trim();
    return url || null;
  } catch {
    return null;
  }
}

/** The body for one request, in the chosen format. */
export function message(config, req, number, format = "text") {
  const owner = req.owners?.length ? `It belongs to ${req.owners.join(", ")}.` : "Nobody owns it.";
  const text =
    `seisin (${basename(config.root)}): ${req.role} was refused ${req.action} on ${req.target}. ${owner} ` +
    `Approve: seisin grant ${number} · decline: seisin decline ${number}`;
  if (format === "slack") return { type: "application/json", body: JSON.stringify({ text }) };
  if (format === "json")
    return {
      type: "application/json",
      body: JSON.stringify({
        text, repo: basename(config.root), number, role: req.role, action: req.action,
        target: req.target, owners: req.owners ?? [], grant: grantFor(req),
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
    const queue = pending(file);
    const number = queue.findIndex((p) => p.key === key) + 1;
    if (number < 1) return false;
    const { type, body } = message(config, { ...req, owners: req.owners ?? queue[number - 1].owners }, number, format);
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
        .catch((e) => failures.push(e.name === "TimeoutError" ? "timed out" : e.message)),
    );
    return true;
  }

  async function settle(capMs = timeoutMs + 500) {
    if (!inflight.length) return failures;
    await Promise.race([Promise.allSettled(inflight), new Promise((ok) => setTimeout(ok, capMs))]);
    return failures;
  }

  return { enabled: !!url, maybe, settle };
}

/**
 * `[notify]` from seisin.toml, refused rather than guessed when it would leak.
 * Called by the config loader.
 */
export function readNotify(table, { path, root, keyDirs, roles, own }) {
  if (table === undefined) return null;
  if (own(table, "url") !== undefined)
    throw new Error(
      `${path}: [notify] url is readable by every role — seisin.toml is not a secret. ` +
      `Put the URL in a file inside a key directory no role declares and name it with url_file, ` +
      `or set ${ENV_URL} in the environment that starts seisin.`);
  const urlFile = own(table, "url_file");
  const format = own(table, "format") ?? "text";
  if (!FORMATS.includes(format))
    throw new Error(`${path}: [notify] format = "${format}" is not one of ${FORMATS.join(", ")}`);
  if (urlFile === undefined) return { urlFile: null, format };
  if (typeof urlFile !== "string" || !urlFile.trim() || urlFile.startsWith("/") || urlFile.split("/").includes(".."))
    throw new Error(`${path}: [notify] url_file must be a path inside the repo`);
  const inKeyDir = keyDirs.some((d) => urlFile.startsWith(d.replace(/\/+$/, "") + "/"));
  if (!inKeyDir)
    throw new Error(
      `${path}: [notify] url_file "${urlFile}" is not inside a key directory, so every role can read ` +
      `it. Move it under ${keyDirs[0] ?? "a [keys] dir"}.`);
  // A file key is written bare (`netlify.txt`, meaning the first key directory)
  // or with its directory (`shared/api.txt`) — the same resolution settingsFor uses.
  const resolve = (raw) => (raw.includes("/") ? raw : join(keyDirs[0] ?? "", raw));
  const holders = Object.entries(roles)
    .filter(([, r]) => r.keyEntries?.some((k) => k.kind === "file" && resolve(k.raw) === urlFile))
    .map(([n]) => n);
  if (holders.length)
    throw new Error(
      `${path}: [notify] url_file "${urlFile}" is declared as a key by ${holders.join(", ")} — ` +
      `that role could read it and send the person a fake "approve". No role may hold it.`);
  return { urlFile, format };
}
