#!/usr/bin/env node
/**
 * seisin — give each agent its own folders and its own keys.
 *
 *   seisin run <role> -- <command...>   run a command as that role
 *   seisin check [role]                 print the map, run nothing
 *   seisin explain <role> <r|w> <path>  ask one question
 *   seisin init                         propose a seisin.toml for this repo
 *   seisin ui                           open the console
 *
 * Enforcement is not ours. @anthropic-ai/sandbox-runtime asks the operating
 * system — Seatbelt on macOS, bubblewrap on Linux — and the kernel does not
 * care how a command was spelled. What seisin adds is the part a kernel can
 * never know: which role a path belongs to, and therefore who to ask next.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, loadConfig, CONFIG_NAME } from "./config.js";
import { settingsFor, RUNTIME_WRITES, expand } from "./srt.js";
import { explain, ownersOf } from "./owners.js";
import { buildEnv } from "./env.js";
import { secretsOf, redactor } from "./redact.js";
import { scan } from "./scan.js";
import { decide } from "./hook.js";
import { append, read, logPath, size, observed, generalise } from "./log.js";
import { createReadStream, watch as watchFile } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , command, ...rest] = process.argv;

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: "\x1b[2m", b: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", off: "\x1b[0m" }
  : { dim: "", b: "", red: "", green: "", yellow: "", blue: "", off: "" };

function die(message, code = 2) {
  process.stderr.write(`${C.red}seisin:${C.off} ${message}\n`);
  process.exit(code);
}

function config() {
  const path = findConfig();
  if (!path) die(`no ${CONFIG_NAME} found here or above. Run "seisin init" to write one.`);
  try {
    return loadConfig(path);
  } catch (e) {
    die(e.message);
  }
}

/* ── run ──────────────────────────────────────────────────────────────── */

function run(argv) {
  const split = argv.indexOf("--");
  const role = argv[0];
  const cmd = split === -1 ? argv.slice(1) : argv.slice(split + 1);
  if (!role || cmd.length === 0) die("usage: seisin run <role> -- <command...>");

  const cfg = config();
  let settings;
  try {
    settings = settingsFor(cfg, role);
  } catch (e) {
    die(e.message);
  }

  const dir = join(cfg.root, ".seisin");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.json`);
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

  const srt = resolveSrt();
  if (!srt) die("sandbox runtime not found. Install it with: npm i -g @anthropic-ai/sandbox-runtime");

  // The hook runs inside the child and has to know which role it is. These are
  // the only variables seisin injects, and they carry no secret.
  const observe = argv.includes("--observe");
  const { env, dropped } = buildEnv(process.env, cfg.roles[role]);
  env.SEISIN_ROLE = role;
  env.SEISIN_CONFIG = cfg.path;
  if (observe) env.SEISIN_OBSERVE = "1";
  if (argv.includes("--debug-env"))
    process.stderr.write(`${C.dim}seisin: dropped ${dropped.join(" ")}${C.off}\n`);

  process.stderr.write(
    `${C.dim}seisin: ${role} · writes ${settings.filesystem.allowWrite.length} path(s) · ` +
    `reads ${settings.filesystem.allowRead.length} key(s) · ` +
    `env ${Object.keys(env).length} kept, ${dropped.length} dropped${observe ? " · OBSERVING, nothing denied" : ""}${C.off}\n`
  );

  // Redaction needs the output to pass through this process, and piping breaks
  // anything that draws its own screen. So it turns itself off on a terminal
  // and on for the runs that end up in a log, which is where a leaked key
  // actually survives. Say so rather than deciding it quietly.
  const wantRedact = cfg.redact !== false && cfg.roles[role].keys.length > 0;
  const canRedact = wantRedact && !process.stdout.isTTY;
  if (wantRedact && !canRedact)
    process.stderr.write(`${C.dim}seisin: redaction off — interactive terminal${C.off}\n`);

  const secrets = canRedact ? secretsOf(settings, readFileSync) : [];
  const out = secrets.length ? redactor(secrets) : null;
  const err = secrets.length ? redactor(secrets) : null;
  if (out) { out.pipe(process.stdout); err.pipe(process.stderr); }

  const child = spawn(srt, ["--settings", file, ...cmd], {
    stdio: out ? ["inherit", "pipe", "pipe"] : "inherit",
    env,
  });
  if (out) { child.stdout.pipe(out); child.stderr.pipe(err); }
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
  child.on("error", (e) => die(`could not start the sandbox: ${e.message}`));
}

/** The bundled runtime first, a global one second. Never a silent fallback to no sandbox. */
function resolveSrt() {
  const local = join(HERE, "..", "node_modules", ".bin", "srt");
  if (existsSync(local)) return local;
  const found = spawnSync("command", ["-v", "srt"], { shell: true, encoding: "utf8" });
  const path = (found.stdout || "").trim();
  return path && existsSync(path) ? path : null;
}

/* ── check ────────────────────────────────────────────────────────────── */

function check(argv) {
  const cfg = config();
  const only = argv[0];
  const roles = only ? [cfg.roles[only]].filter(Boolean) : Object.values(cfg.roles);
  if (only && roles.length === 0) die(`unknown role "${only}"`);

  process.stdout.write(`\n${C.b}${relative(process.cwd(), cfg.path) || CONFIG_NAME}${C.off}\n\n`);
  const width = Math.max(...roles.map((r) => r.name.length), 4);

  for (const r of roles) {
    process.stdout.write(`  ${C.b}${r.name.padEnd(width)}${C.off}  ${C.blue}writes${C.off} ${r.writes.join(" ") || C.dim + "nothing" + C.off}\n`);
    const keys = r.keys.length ? r.keys.join(" ") : `${C.dim}none${C.off}`;
    process.stdout.write(`  ${" ".repeat(width)}  ${C.green}keys${C.off}   ${keys}\n\n`);
  }

  const unowned = [];
  for (const r of roles) for (const g of r.writes) if (ownersOf(cfg, g.replace(/\/\*\*$/, "")).length > 1) unowned.push(g);
  const shared = [...new Set(unowned)];
  if (shared.length) {
    process.stdout.write(`  ${C.yellow}${shared.length} path(s) claimed by more than one role:${C.off} ${shared.join(" ")}\n`);
    process.stdout.write(`  ${C.dim}Overlap is allowed — seisin will name every owner. It is listed so it stays a decision.${C.off}\n\n`);
  }
  // Scratch space is granted to everybody, so a repo sitting inside it is
  // writable by every role no matter what the territory says. Saying so is the
  // difference between a limitation and a trap.
  const scratch = (cfg.runtimeWrites ?? RUNTIME_WRITES).map(expand);
  const inside = scratch.filter((s) => resolve(cfg.root).startsWith(s + "/"));
  if (inside.length) {
    process.stdout.write(`  ${C.yellow}this repo lives inside shared scratch space (${inside[0]})${C.off}\n`);
    process.stdout.write(`  ${C.dim}Every role can write scratch, so territory does not hold here. Move the repo, or set [runtime] writes = [].${C.off}\n\n`);
  }

  if (cfg.keyDirs.length === 0 && Object.values(cfg.roles).some((r) => r.keys.length))
    process.stdout.write(`  ${C.yellow}keys are listed but [keys] dir is unset — nothing will be scoped${C.off}\n\n`);
}

/* ── explain ──────────────────────────────────────────────────────────── */

function explainCmd(argv) {
  const [role, action, target] = argv;
  if (!role || !action || !target) die("usage: seisin explain <role> <read|write> <path-or-key>");
  const verb = action.startsWith("r") ? "read" : "write";
  const cfg = config();
  if (!cfg.roles[role]) die(`unknown role "${role}"`);

  const v = explain(cfg, role, verb, target);
  const head = v.allowed ? `${C.green}allowed${C.off}` : `${C.yellow}denied${C.off}`;
  process.stdout.write(`\n  ${head}  ${C.b}${role}${C.off} ${verb} ${target}\n  ${C.dim}${v.reason}${C.off}\n\n`);
  process.exit(v.allowed ? 0 : 1);
}

/* ── init ─────────────────────────────────────────────────────────────── */

function init(argv = []) {
  if (argv.includes("--from-observations")) return initFromLog();
  const target = join(process.cwd(), CONFIG_NAME);
  if (existsSync(target)) die(`${CONFIG_NAME} already exists here. Delete it first if you meant to start over.`);

  const found = discover(process.cwd());
  writeFileSync(target, render(found));
  process.stdout.write(
    `\n  wrote ${C.b}${CONFIG_NAME}${C.off} with ${found.roles.length} role(s) from ${found.source}\n` +
    `  ${C.dim}These are a proposal, not a policy. Read them before you run anything.${C.off}\n\n` +
    `  next:  seisin check\n\n`
  );
}

/**
 * Three places a repo already says who does what, in order of how much it
 * actually means. None of them is a policy, so all of them are proposals: the
 * file lands with the roles commented in, and a human decides.
 */
function discover(root) {
  const agents = join(root, ".claude", "agents");
  if (existsSync(agents)) {
    const roles = readdirSync(agents)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f.replace(/\.md$/, ""), writes: [], keys: [] }));
    if (roles.length) return { source: ".claude/agents/", roles };
  }

  for (const p of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const file = join(root, p);
    if (!existsSync(file)) continue;
    const paths = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0])
      .filter((g) => g && g !== "*");
    if (paths.length)
      return {
        source: p,
        roles: [...new Set(paths)].slice(0, 8).map((g, i) => ({
          name: g.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || `role-${i + 1}`,
          writes: [g.endsWith("/") ? g + "**" : g],
          keys: [],
        })),
      };
  }

  return {
    source: "nothing to read — this is a blank start",
    roles: [
      { name: "frontend", writes: ["src/web/**"], keys: [] },
      { name: "backend", writes: ["src/api/**"], keys: [] },
    ],
  };
}

function render(found) {
  const head = [
    "# seisin — which folders each agent writes, and which keys it may read.",
    "#",
    `# Proposed from: ${found.source}`,
    "# Nothing here is enforced until you run the agent through `seisin run`.",
    "# Anything not listed is denied. There is no permissive default.",
    "",
    "# [keys]",
    '# dir = ".secrets"      # every key lives here; roles name the files they may read',
    "",
    "[network]",
    'allow = ["github.com", "*.github.com"]',
    "",
  ];
  for (const r of found.roles) {
    head.push(`[roles.${r.name}]`);
    head.push(`writes = [${r.writes.map((w) => `"${w}"`).join(", ")}]`);
    head.push(`keys   = [${r.keys.map((k) => `"${k}"`).join(", ")}]`);
    head.push("");
  }
  return head.join("\n");
}

/**
 * Writes the policy from what actually happened.
 *
 * This is the answer to the question every permission tool dodges: where does
 * the first policy come from? Written by hand it is a guess, and the first
 * unjustified denial is when the tool gets uninstalled. Observed first, written
 * second — the same order you would use on a colleague's code.
 */
function initFromLog() {
  const cfg = config();
  const entries = read(logPath(cfg.root), { verdict: "observed" });
  if (entries.length === 0)
    die(`nothing observed yet. Run: seisin run <role> --observe -- <command>`);

  const roles = observed(entries);
  const out = [
    `# ${CONFIG_NAME} — written from ${entries.length} observed action(s).`,
    `#`,
    `# This is what your agents actually did, generalised to directories. Read it`,
    `# before you trust it: an agent that touched a file once by mistake asked for`,
    `# that directory here, and observation cannot tell intent from accident.`,
    ``,
  ];
  if (cfg.keyDirs.length) out.push(`[keys]`, `dir = [${cfg.keyDirs.map((d) => `"${d}"`).join(", ")}]`, ``);
  out.push(`[network]`, `allow = [${cfg.allowedDomains.map((d) => `"${d}"`).join(", ")}]`, ``);

  for (const [name, seen] of roles) {
    const writes = generalise([...seen.writes]);
    const keys = [...seen.keys].map((k) => k.replace(/^.*\//, ""));
    out.push(`[roles.${name}]`);
    out.push(`writes = [${writes.map((w) => `"${w}"`).join(", ")}]`);
    out.push(`keys   = [${[...new Set(keys)].map((k) => `"${k}"`).join(", ")}]`);
    out.push(`# observed: ${seen.writes.size} path(s) written, ${seen.keys.size} key(s) read`);
    out.push(``);
  }

  const file = join(cfg.root, CONFIG_NAME + ".observed");
  writeFileSync(file, out.join("\n"));
  process.stdout.write(
    `\n  wrote ${C.b}${relative(process.cwd(), file)}${C.off} from ${entries.length} observation(s), ${roles.size} role(s)\n` +
    `  ${C.dim}Not ${CONFIG_NAME} — a policy generated behind your back is not a policy. Diff it, then move it.${C.off}\n\n`
  );
}

/* ── ui ───────────────────────────────────────────────────────────────── */

function ui() {
  const file = join(HERE, "..", "ui", "index.html");
  if (!existsSync(file)) die("the console is missing from this install");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [file], { stdio: "ignore", shell: process.platform === "win32" });
  process.stdout.write(`\n  opened ${file}\n\n`);
}

/* ── scan ─────────────────────────────────────────────────────────────── */

function scanCmd() {
  const cfg = config();
  const { hits, skipped, truncated } = scan(cfg.root, cfg.keyDirs, cfg.scanIgnore);

  const certain = hits.filter((h) => h.level === "certain");
  const review = hits.filter((h) => h.level === "review");
  const where = cfg.keyDirs.length ? cfg.keyDirs.join(", ") : `${C.yellow}nowhere — [keys] dir is unset${C.off}`;

  process.stdout.write(`\n  ${C.dim}protected: ${where}${C.off}\n\n`);

  if (certain.length === 0 && review.length === 0) {
    process.stdout.write(`  ${C.green}nothing credential-shaped outside the declared directories${C.off}\n\n`);
    return;
  }

  // Two lists, never one. A provider-issued string and a line that merely
  // mentions a password are different claims, and merging them is how a
  // scanner earns the reputation of crying wolf.
  if (certain.length) {
    process.stdout.write(`  ${C.red}${certain.length} credential(s)${C.off} — these shapes are issued, not written by accident\n\n`);
    for (const h of certain) process.stdout.write(`    ${C.b}${h.file}${C.off}${C.dim}:${h.line}${C.off}  ${h.shape}\n`);
    process.stdout.write("\n");
  }

  if (review.length) {
    const byFile = new Map();
    for (const h of review) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
    process.stdout.write(`  ${C.yellow}${review.length} line(s) to look at${C.off} in ${byFile.size} file(s) — a secret-shaped name with a literal value\n\n`);
    for (const [file, n] of [...byFile].slice(0, 15))
      process.stdout.write(`    ${file}${C.dim}${n > 1 ? `  ×${n}` : ""}${C.off}\n`);
    if (byFile.size > 15) process.stdout.write(`    ${C.dim}… and ${byFile.size - 15} more file(s)${C.off}\n`);
    process.stdout.write("\n");
  }

  // What was thrown away matters as much as what was kept: it is the only way
  // to tell a quiet scan from a broken one.
  const q = [];
  if (skipped.reference) q.push(`${skipped.reference} value(s) read from the environment`);
  if (skipped.placeholder) q.push(`${skipped.placeholder} placeholder(s)`);
  if (skipped.ignored) q.push(`${skipped.ignored} ignored path(s)`);
  if (skipped.protectedDirs) q.push(`${skipped.protectedDirs} inside declared key dir(s)`);
  if (q.length) process.stdout.write(`  ${C.dim}not reported: ${q.join(" · ")}${C.off}\n`);
  if (truncated) process.stdout.write(`  ${C.yellow}stopped at the limit — there are more${C.off}\n`);
  process.stdout.write(`  ${C.dim}seisin does not move these. Where a credential lives is your call.${C.off}\n\n`);

  // Only a certain finding fails. Otherwise this cannot go in a build.
  if (certain.length) process.exit(1);
}

/* ── hook ─────────────────────────────────────────────────────────────── */

/**
 * Reads a PreToolUse event on stdin, records it, and answers.
 *
 * Claude Code runs this per tool call, so it opens no files it does not need
 * and exits without ceremony. A hook that is slow is a hook that gets removed.
 */
async function hookCmd() {
  const role = process.env.SEISIN_ROLE;
  if (!role) process.exit(0); // not launched by seisin: say nothing, block nothing

  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let event;
  try {
    event = JSON.parse(raw || "{}");
  } catch {
    process.exit(0); // an unreadable event is not grounds to block work
  }

  let cfg;
  try {
    cfg = loadConfig(process.env.SEISIN_CONFIG ?? findConfig());
  } catch {
    process.exit(0);
  }
  if (!cfg.roles[role]) process.exit(0);

  const out = decide(cfg, role, event, { observe: process.env.SEISIN_OBSERVE === "1" });
  if (out.hookSpecificOutput) process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
}

/* ── log ──────────────────────────────────────────────────────────────── */

function logCmd(argv) {
  const cfg = config();
  const pick = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const entries = read(logPath(cfg.root), {
    role: pick("--role"),
    verdict: pick("--verdict"),
    limit: Number(pick("--limit") ?? 40),
  });

  if (entries.length === 0) {
    process.stdout.write(`\n  ${C.dim}nothing recorded yet — run an agent through "seisin run"${C.off}\n\n`);
    return;
  }
  process.stdout.write("\n");
  for (const e of entries) process.stdout.write(line(e));
  const denied = entries.filter((e) => e.verdict === "denied").length;
  process.stdout.write(`\n  ${C.dim}${entries.length} entries · ${denied} denied${C.off}\n\n`);
}

function line(e) {
  const mark = e.verdict === "denied" ? `${C.yellow}denied ${C.off}`
    : e.verdict === "observed" ? `${C.dim}seen   ${C.off}`
    : `${C.green}allowed${C.off}`;
  const who = e.owners?.length && e.verdict === "denied"
    ? `  ${C.dim}→ ${e.owners.join(", ")}${C.off}` : "";
  return `  ${C.dim}${(e.at ?? "").slice(11, 19)}${C.off}  ${mark}  ${C.b}${e.role}${C.off} ${e.action} ${e.target}${who}\n`;
}

/* ── watch ────────────────────────────────────────────────────────────── */

/**
 * Follows the log. This is the whole "live" feature: no daemon, no socket —
 * the file already is the shared state, so anything that can read it can watch.
 */
function watchCmd() {
  const cfg = config();
  const file = logPath(cfg.root);
  let at = size(file);
  process.stdout.write(`\n  ${C.dim}watching ${relative(process.cwd(), file)} — ctrl-c to stop${C.off}\n\n`);

  const drain = () => {
    const end = size(file);
    if (end <= at) { at = end; return; } // truncated or unchanged
    const s = createReadStream(file, { start: at, end: end - 1, encoding: "utf8" });
    at = end;
    let buf = "";
    s.on("data", (d) => (buf += d));
    s.on("end", () => {
      for (const l of buf.split("\n")) {
        if (!l.trim()) continue;
        try { process.stdout.write(line(JSON.parse(l))); } catch { /* half-written */ }
      }
    });
  };
  try { watchFile(dirname(file), () => drain()); } catch { /* fall back to polling */ }
  setInterval(drain, 500);
}

/* ── dispatch ─────────────────────────────────────────────────────────── */

const USAGE = `
${C.b}seisin${C.off} — give each agent its own folders and its own keys

  seisin run <role> -- <command...>    run a command as that role
  seisin check [role]                  print the map, run nothing
  seisin explain <role> read|write <path>
  seisin scan                           find secrets outside the declared key dirs\n  seisin run <role> --observe -- <cmd>  record, deny nothing
  seisin init [--from-observations]     propose a ${CONFIG_NAME} for this repo
  seisin log [--role r] [--verdict denied]   what the agents tried
  seisin watch                          follow it live
  seisin ui                             open the console

Enforcement comes from @anthropic-ai/sandbox-runtime, which asks the OS.
seisin decides what to ask for, and says whose file it was when the answer is no.
`;

switch (command) {
  case "run": run(rest); break;
  case "check": check(rest); break;
  case "explain": explainCmd(rest); break;
  case "hook": await hookCmd(); break;
  case "log": logCmd(rest); break;
  case "watch": watchCmd(); break;
  case "scan": scanCmd(); break;
  case "init": init(rest); break;
  case "ui": ui(); break;
  case "-v": case "--version":
    process.stdout.write(JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version + "\n"); break;
  default: process.stdout.write(USAGE); process.exit(command ? 2 : 0);
}
