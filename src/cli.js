#!/usr/bin/env node
/**
 * keyward — give each agent its own folders and its own keys.
 *
 *   keyward run <role> -- <command...>   run a command as that role
 *   keyward check [role]                 print the map, run nothing
 *   keyward explain <role> <r|w> <path>  ask one question
 *   keyward init                         propose a keyward.toml for this repo
 *   keyward ui                           open the console
 *
 * Enforcement is not ours. @anthropic-ai/sandbox-runtime asks the operating
 * system — Seatbelt on macOS, bubblewrap on Linux — and the kernel does not
 * care how a command was spelled. What keyward adds is the part a kernel can
 * never know: which role a path belongs to, and therefore who to ask next.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findConfig, loadConfig, CONFIG_NAME } from "./config.js";
import { settingsFor } from "./srt.js";
import { explain, ownersOf } from "./owners.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , command, ...rest] = process.argv;

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: "\x1b[2m", b: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", off: "\x1b[0m" }
  : { dim: "", b: "", red: "", green: "", yellow: "", blue: "", off: "" };

function die(message, code = 2) {
  process.stderr.write(`${C.red}keyward:${C.off} ${message}\n`);
  process.exit(code);
}

function config() {
  const path = findConfig();
  if (!path) die(`no ${CONFIG_NAME} found here or above. Run "keyward init" to write one.`);
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
  if (!role || cmd.length === 0) die("usage: keyward run <role> -- <command...>");

  const cfg = config();
  let settings;
  try {
    settings = settingsFor(cfg, role);
  } catch (e) {
    die(e.message);
  }

  const dir = join(cfg.root, ".keyward");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.json`);
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

  const srt = resolveSrt();
  if (!srt) die("sandbox runtime not found. Install it with: npm i -g @anthropic-ai/sandbox-runtime");

  process.stderr.write(
    `${C.dim}keyward: ${role} · writes ${settings.filesystem.allowWrite.length} path(s) · ` +
    `reads ${settings.filesystem.allowRead.length} key(s)${C.off}\n`
  );

  const child = spawn(srt, ["--settings", file, ...cmd], { stdio: "inherit" });
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
    process.stdout.write(`  ${C.dim}Overlap is allowed — keyward will name every owner. It is listed so it stays a decision.${C.off}\n\n`);
  }
  if (!cfg.keyDir && Object.values(cfg.roles).some((r) => r.keys.length))
    process.stdout.write(`  ${C.yellow}keys are listed but [keys] dir is unset — nothing will be scoped${C.off}\n\n`);
}

/* ── explain ──────────────────────────────────────────────────────────── */

function explainCmd(argv) {
  const [role, action, target] = argv;
  if (!role || !action || !target) die("usage: keyward explain <role> <read|write> <path-or-key>");
  const verb = action.startsWith("r") ? "read" : "write";
  const cfg = config();
  if (!cfg.roles[role]) die(`unknown role "${role}"`);

  const v = explain(cfg, role, verb, target);
  const head = v.allowed ? `${C.green}allowed${C.off}` : `${C.yellow}denied${C.off}`;
  process.stdout.write(`\n  ${head}  ${C.b}${role}${C.off} ${verb} ${target}\n  ${C.dim}${v.reason}${C.off}\n\n`);
  process.exit(v.allowed ? 0 : 1);
}

/* ── init ─────────────────────────────────────────────────────────────── */

function init() {
  const target = join(process.cwd(), CONFIG_NAME);
  if (existsSync(target)) die(`${CONFIG_NAME} already exists here. Delete it first if you meant to start over.`);

  const found = discover(process.cwd());
  writeFileSync(target, render(found));
  process.stdout.write(
    `\n  wrote ${C.b}${CONFIG_NAME}${C.off} with ${found.roles.length} role(s) from ${found.source}\n` +
    `  ${C.dim}These are a proposal, not a policy. Read them before you run anything.${C.off}\n\n` +
    `  next:  keyward check\n\n`
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
    "# keyward — which folders each agent writes, and which keys it may read.",
    "#",
    `# Proposed from: ${found.source}`,
    "# Nothing here is enforced until you run the agent through `keyward run`.",
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

/* ── ui ───────────────────────────────────────────────────────────────── */

function ui() {
  const file = join(HERE, "..", "ui", "index.html");
  if (!existsSync(file)) die("the console is missing from this install");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [file], { stdio: "ignore", shell: process.platform === "win32" });
  process.stdout.write(`\n  opened ${file}\n\n`);
}

/* ── dispatch ─────────────────────────────────────────────────────────── */

const USAGE = `
${C.b}keyward${C.off} — give each agent its own folders and its own keys

  keyward run <role> -- <command...>    run a command as that role
  keyward check [role]                  print the map, run nothing
  keyward explain <role> read|write <path>
  keyward init                          propose a ${CONFIG_NAME} for this repo
  keyward ui                            open the console

Enforcement comes from @anthropic-ai/sandbox-runtime, which asks the OS.
keyward decides what to ask for, and says whose file it was when the answer is no.
`;

switch (command) {
  case "run": run(rest); break;
  case "check": check(rest); break;
  case "explain": explainCmd(rest); break;
  case "init": init(); break;
  case "ui": ui(); break;
  case "-v": case "--version":
    process.stdout.write(JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version + "\n"); break;
  default: process.stdout.write(USAGE); process.exit(command ? 2 : 0);
}
