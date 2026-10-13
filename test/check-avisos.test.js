/**
 * Four things a reader was told wrong or told too much:
 *
 *   - Claude Code updating its plugins from inside the sandbox read as a role
 *     stuck on something to grant (walls, review, the console, the end of a run);
 *   - `review` had no window, so old paths led "Denied repeatedly";
 *   - a role that names a file was not told that Claude Code's Edit on it fails;
 *   - `check --verbose` ended with the same paragraphs in every repo.
 *
 * Logs are written by hand: what is tested is what a reader concludes from a
 * history, and building the history directly is the way to state one exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { expectedOf } from "../src/kinds.js";
import { walls, render, wasted } from "../src/walls.js";
import { review } from "../src/review.js";
import { parseSince, causesOf, describeWalls } from "../src/views.js";
import { intake, destinationOf } from "../src/intake.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { loadConfig } from "../src/config.js";
import { pending, requestsPath, refuseIfBarred, grantFor } from "../src/requests.js";
import { scratch, CLI } from "./_tmp.js";

const CACHE = join(homedir(), ".claude", "plugins", "cache", "market", "plugin", "1.2.3", "package.json");

function repo(toml, files = {}) {
  const dir = scratch("seisin-avisos-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return { dir, config: loadConfig(join(dir, "seisin.toml")) };
}

const TOML = '[roles.dev]\nwrites = ["src/**"]\n\n[roles.web]\nwrites = ["web/**"]\n';

function withLog(dir, entries) {
  mkdirSync(join(dir, ".seisin"), { recursive: true });
  writeFileSync(join(dir, ".seisin", "log.jsonl"),
    entries.map((e) => JSON.stringify({ at: "2026-10-10T10:00:00.000Z", verdict: "denied", action: "write", ...e })).join("\n") + "\n");
}

function sh(cwd, ...args) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.SEISIN_ROLE;
  delete env.SEISIN_CONFIG;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/* ── 1. Claude Code's plugin cache is an expected denial ───────────────── */

test("the plugin cache is expected; the rest of ~/.claude/plugins is not", () => {
  assert.equal(expectedOf(CACHE)?.kind, "plugins");
  assert.equal(expectedOf(join(homedir(), ".claude", "plugins", "installed_plugins.json")), null);
  assert.equal(expectedOf(".claude/plugins/cache/x"), null, "a project's .claude is not the updater's");
  assert.equal(expectedOf("/cfg/plugins/cache/a", { env: { CLAUDE_CONFIG_DIR: "/cfg" } })?.kind, "plugins");
});

test("walls marks it, the agent is not told about it, and it is no retry", () => {
  const { dir, config } = repo(TOML);
  withLog(dir, [{ role: "dev", target: CACHE }, { role: "dev", target: CACHE }, { role: "dev", target: CACHE },
    { role: "dev", target: "web/a.ts" }, { role: "dev", target: "web/a.ts" }]);
  const list = walls(config, "dev", { file: join(dir, ".seisin", "log.jsonl") });
  const cache = list.find((w) => w.target === CACHE);
  assert.equal(cache.expected?.kind, "plugins");
  assert.equal(list.find((w) => w.target === "web/a.ts").expected, undefined);
  assert.equal(wasted(list), 1, "only web/a.ts was retried");
  assert.doesNotMatch(render(list), /plugins/);
  assert.match(render(list), /web\/a\.ts/);
  const shown = describeWalls(config, { dev: list }, []).dev.find((w) => w.target === CACHE);
  assert.equal(shown.retried, 0);
});

test("seisin walls says it as expected and exits 0 when it is the only wall", () => {
  const { dir } = repo(TOML);
  withLog(dir, [{ role: "dev", target: CACHE }, { role: "dev", target: CACHE }]);
  const r = sh(dir, "walls", "dev");
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /expected · Claude Code updating its plugins/);
});

test("review lists it apart, never as repeated denials, and does not exit 1 over it", () => {
  const { dir, config } = repo(TOML);
  withLog(dir, Array.from({ length: 5 }, () => ({ role: "dev", target: CACHE })));
  const r = review(config);
  assert.equal(r.friction.length, 0);
  assert.equal(r.expected.length, 1);
  assert.equal(r.expected[0].times, 5);
  const cli = sh(dir, "review");
  assert.equal(cli.code, 0, cli.out + cli.err);
  assert.match(cli.out, /Denied as expected/);
  assert.doesNotMatch(cli.out, /Denied repeatedly/);
});

test("the console counts it apart and says it on the cause", () => {
  const { config } = repo(TOML);
  const c = causesOf(config, [
    { role: "dev", action: "write", target: CACHE, verdict: "denied" },
    { role: "dev", action: "write", target: CACHE, verdict: "denied" },
    { role: "dev", action: "write", target: "web/a.ts", verdict: "denied" },
  ]);
  assert.deepEqual(c.expected, { paths: 1, denials: 2 });
  assert.equal(c.causes.find((x) => x.target === CACHE).expected.kind, "plugins");
  assert.equal(c.causes.find((x) => x.target === "web/a.ts").expected, undefined);

  // The page's own sentence for a cause, run as the page runs it.
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const src = /function causeSays\(c\)\{[\s\S]*?\n  \}/.exec(html)[0];
  const causeSays = new Function(`${src}; return causeSays;`)();
  assert.match(causeSays({ about: "file", standing: "protected", why: ".claude", expected: { hint: "H" } }), /^expected · H$/);
});

test("the end of a run counts the expected ones", () => {
  const { config } = repo(TOML);
  const settings = { filesystem: { allowWrite: [join(homedir(), ".claude")], denyWrite: [], allowRead: [], denyRead: [] } };
  const take = intake({ config, role: "dev", runId: "r", settings });
  take.fromKernel({ action: "write", path: CACHE, operation: "file-write-create" });
  take.fromKernel({ action: "write", path: join(config.root, "web", "a.ts"), operation: "file-write-create" });
  assert.equal(take.stats.expected, 1);
});

/* ── 2. review --since ─────────────────────────────────────────────────── */

test("parseSince reads a duration back from now, and a date", () => {
  const now = Date.parse("2026-10-12T00:00:00.000Z");
  assert.equal(parseSince("7d", now), "2026-10-05T00:00:00.000Z");
  assert.equal(parseSince("12h", now), "2026-10-11T12:00:00.000Z");
  assert.equal(parseSince("2w", now), "2026-09-28T00:00:00.000Z");
  assert.equal(parseSince("2026-10-01", now), "2026-10-01T00:00:00.000Z");
  assert.equal(parseSince("soon", now), null);
});

test("review --since leaves out what came before", () => {
  const { dir, config } = repo(TOML);
  withLog(dir, [
    ...Array.from({ length: 4 }, () => ({ role: "dev", target: "old/x.ts", at: "2026-01-01T00:00:00.000Z" })),
    ...Array.from({ length: 3 }, () => ({ role: "dev", target: "web/a.ts", at: new Date().toISOString() })),
  ]);
  assert.deepEqual(review(config).friction.map((f) => f.where), ["old", "web"]);
  assert.deepEqual(review(config, { since: "2026-06-01T00:00:00.000Z" }).friction.map((f) => f.where), ["web"]);
  const cli = sh(dir, "review", "--since", "7d");
  assert.match(cli.out, /web/);
  assert.doesNotMatch(cli.out, /old/);
  assert.match(cli.out, /\(since \d{4}-\d{2}-\d{2}\)/);
  const bad = sh(dir, "review", "--since", "yesterday-ish");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--since takes a date/);
});

/* ── 3. a file granted by name, and Claude Code's temporary file ───────── */

test("check tells the role that names a file that Claude Code's Edit on it fails", () => {
  const { config } = repo(
    '[roles.dev]\nwrites = ["src/**", "notes/BACKLOG.md"]\n\n[roles.web]\nwrites = ["web/**", "web/a.ts"]\n',
    { "notes/BACKLOG.md": "x\n", "web/a.ts": "x\n", "src/.keep": "" });
  const ws = inspect(config).warnings.filter((w) => w.kind === "claude-atomic-write");
  assert.equal(ws.length, 1, "web/a.ts is inside web/**, whose grant covers its neighbours");
  assert.match(ws[0].headline, /^dev: writes notes\/BACKLOG\.md by name — Claude Code's Edit and Write on it fail \(EPERM\)/);
  assert.match(ws[0].detail, /\.tmp\./);
  assert.match(ws[0].detail, /notes\/\*\*/);
  assert.match(ws[0].detail, /shell/);
});

test("a file at the root is told to move, not to grant the whole repo", () => {
  const { config } = repo('[roles.dev]\nwrites = ["BACKLOG.md"]\n', { "BACKLOG.md": "x\n" });
  const w = inspect(config).warnings.find((x) => x.kind === "claude-atomic-write");
  assert.match(w.detail, /repo root/);
  assert.doesNotMatch(w.detail, /\(\*\*\)/);
});

/* ── 4. check --verbose says this repo; the limits are `help limits` ───── */

test("check --verbose no longer prints the standing limits; help limits does", () => {
  const { dir } = repo(TOML, { "src/a.ts": "", "web/b.ts": "" });
  const long = sh(dir, "check", "--verbose");
  assert.equal(long.code, 0, long.out + long.err);
  assert.doesNotMatch(long.out, /writes and deletes are one permission to the kernel/);
  assert.match(long.out, /standing limit\(s\) apply to every repo: seisin help limits/);
  const short = sh(dir, "check");
  assert.match(short.out, /seisin help limits/);
  const limits = sh(dir, "help", "limits");
  assert.equal(limits.code, 0);
  assert.match(limits.out, /a role can delete inside its own territory/);
  assert.match(limits.out, /writes and deletes are one permission to the kernel/);
});

test("a warning's list prints one entry per line", () => {
  const text = renderReport({
    where: "x", roles: [{ name: "dev", writes: ["src/**"], keys: [] }], protected: [], limits: [],
    warnings: [{ kind: "path-shut-by-territory", headline: "dev: 2 PATH entries are unreadable", detail: "d", items: ["~/a/bin", "~/b/bin"] }],
  }, { verbose: true });
  assert.match(text, /\n {4}~\/a\/bin\n {4}~\/b\/bin\n/);
});

/* ── 5. a temporary file is not a request, and a request is never the repo ── */

test("a kernel denial on a temporary file is logged and queues no request", () => {
  const { dir, config } = repo(TOML);
  const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };
  const take = intake({ config, role: "dev", runId: "r", settings });
  take.fromKernel({ action: "write", path: join(dir, "BACKLOG.md.tmp.32029.0123456789ab"), operation: "file-write-create" });
  take.fromKernel({ action: "write", path: join(dir, "web", "a.ts"), operation: "file-write-create" });
  const queued = pending(requestsPath(dir));
  // Not the temporary file itself — its name changes every save — but the file the save was replacing.
  assert.deepEqual(queued.map((r) => r.target).sort(), ["BACKLOG.md", "web/a.ts"]);
  assert.ok(!queued.some((r) => r.target.includes(".tmp.")), "the temporary file is never the request");
  const lines = readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const tmp = lines.find((l) => l.target.startsWith("BACKLOG.md.tmp."));
  assert.equal(tmp.verdict, "denied");
  assert.equal(tmp.nature, "temporary");
  assert.equal(tmp.destination, "BACKLOG.md");
});

test("an atomic save refused beside another role's file asks for that file", () => {
  const { dir, config } = repo(TOML);
  const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };
  const take = intake({ config, role: "dev", runId: "r", settings });
  take.fromKernel({ action: "write", path: join(dir, "web", "health.ts.tmp.48213.3fa9c1d2e0b4"), operation: "file-write-create" });
  const [r] = pending(requestsPath(dir));
  assert.equal(r.target, "web/health.ts");
  assert.deepEqual(r.owners, ["web"]);
  assert.deepEqual(take.stats.atomic, []);
});

test("an atomic save refused beside this role's own file queues nothing and is counted for the end of the run", () => {
  const { dir, config } = repo(TOML);
  const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };
  const take = intake({ config, role: "dev", runId: "r", settings });
  take.fromKernel({ action: "write", path: join(dir, "src", "health.ts.tmp.48213.3fa9c1d2e0b4"), operation: "file-write-create" });
  assert.deepEqual(pending(requestsPath(dir)), [], "nothing a grant could name");
  assert.deepEqual(take.stats.atomic, ["src/health.ts"]);
});

test("destinationOf reads the file a write-then-rename was replacing", () => {
  assert.equal(destinationOf("src/health.ts.tmp.48213.3fa9c1d2e0b4"), "src/health.ts");
  assert.equal(destinationOf("BACKLOG.md.tmp.32029.0123456789ab"), "BACKLOG.md");
  assert.equal(destinationOf("build/cache.tmp"), null);
  assert.equal(destinationOf("tmp/x.ts"), null);
});

test("a request never grants the whole repository", () => {
  const { config } = repo(TOML);
  for (const target of [".", "**"]) {
    const req = { role: "dev", action: "write", target, grant: grantFor({ action: "write", target }) };
    assert.throws(() => refuseIfBarred(config, req), /whole repository/);
  }
  assert.throws(() => refuseIfBarred(config, { role: "dev", action: "write", target: "x", grant: "**" }), /whole repository/);
  assert.doesNotThrow(() => refuseIfBarred(config, { role: "dev", action: "write", target: "web/a.ts", grant: "web/**" }));
});
