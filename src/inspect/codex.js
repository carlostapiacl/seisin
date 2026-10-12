import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

/**
 * How Codex is signed in on this machine: "chatgpt", "apikey", or null.
 *
 * Read from `auth.json` in `CODEX_HOME` or `~/.codex`, by the parent, which
 * `check` is. Only the shape is looked at — which fields are set — and
 * nothing from the file is kept or printed.
 */
export function codexSignIn(env = process.env) {
  const home = env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(homedir(), ".codex");
  let auth;
  try { auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8")); } catch { return null; }
  if (!auth || typeof auth !== "object") return null;
  if (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) return "apikey";
  if (auth.tokens && typeof auth.tokens === "object" && auth.tokens.refresh_token) return "chatgpt";
  return null;
}

/**
 * A role that looks set up for OpenAI and would leave Codex hanging.
 *
 * Signed in with ChatGPT, Codex talks to `chatgpt.com` for the model and to
 * `auth.openai.com` to renew the sign-in — never to `api.openai.com` (measured
 * 2026-09-30, codex 0.150.1: 0 connections). Without `chatgpt.com` it does not
 * fail: it retries without end and prints nothing, which reads as an agent
 * thinking. And the proxy's refusal does not reach seisin's log.
 *
 * `check` does not know which CLI a role runs, so the signal is the two facts
 * it can see: this machine's Codex is signed in with ChatGPT, and the role's
 * list names something under `openai.com` — a list written for OpenAI — but
 * not `chatgpt.com`. A role whose `env` passes `OPENAI_API_KEY` is left out:
 * it is set up for the API, where `api.openai.com` is right. Wrong costs a
 * sentence, never a run, the same trade as the model-endpoint warning above.
 */
export function codexSignInWarnings(config, roles, env = process.env) {
  if (codexSignIn(env) !== "chatgpt") return [];
  const reaches = (list, host) => list.some((d) => d === "*" || d === host ||
    (d.startsWith("*.") && host.endsWith(d.slice(1))));
  const out = [];
  for (const r of roles) {
    const list = r.network ?? config.allowedDomains ?? [];
    if (!list.some((d) => /(^|\.)openai\.com$/i.test(d))) continue;
    if ((r.env ?? []).includes("OPENAI_API_KEY")) continue;
    const missing = ["chatgpt.com", "auth.openai.com"].filter((h) => !reaches(list, h));
    if (!missing.length) continue;
    out.push({
      kind: "codex-chatgpt-endpoint",
      headline: `${r.name} allows ${list.filter((d) => /openai\.com$/i.test(d)).join(" ")} but not ${missing.join(" ")}`,
      detail:
        "Codex on this machine is signed in with ChatGPT, and with that sign-in it talks to " +
        "chatgpt.com for the model and to auth.openai.com to renew the sign-in, never to " +
        "api.openai.com. " +
        (missing.includes("chatgpt.com")
          ? "Without chatgpt.com a Codex run does not fail: it retries without end and prints " +
            "nothing, and the proxy's denial does not reach seisin's log. "
          : "Without auth.openai.com a Codex run works until the sign-in has to be renewed. ") +
        `If ${r.name} runs Codex, add ${missing.join(" and ")}; if it does not, this is not about it.`,
    });
  }
  return out;
}
