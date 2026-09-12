/**
 * The parts that can be checked without touching the operating system.
 * The sandbox itself is exercised by test/sandbox.test.js, which is slower and
 * skips where the runtime is missing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml } from "../src/config.js";
import { covers, ownersOf, keyHolders, explain } from "../src/owners.js";
import { realpathSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnv } from "../src/env.js";
import { redactor } from "../src/redact.js";
import { scan } from "../src/scan.js";
import { targetsOf, decide } from "../src/hook.js";
import { read, generalise } from "../src/log.js";
import { tmpdir } from "node:os";
import { inspect, sharedPaths } from "../src/inspect.js";
import { renderReport, renderVerdict } from "../src/render.js";
import { renderConfig } from "../src/commands/init.js";
import * as publica from "../src/index.js";
import { record, settle, pending, applyGrant, grantFor } from "../src/requests.js";
import { Readable } from "node:stream";
import { serveMcp, TOOLS, HANDLERS, PROTOCOLS } from "../src/mcp.js";
import { serve } from "../src/serve.js";
import { spool, send, flush } from "../src/spool.js";
import { settingsFor, RUNTIME_WRITES } from "../src/srt.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

test("a quoted value keeps its first character", () => {
  // Regression. The first parser chained two slices and turned ".secrets" into
  // "secrets". Nothing failed loudly: denyRead pointed at a path that did not
  // exist, so every key stayed readable by every role. A permission tool that
  // is wrong in this direction is worse than no tool, so this test exists.
  assert.equal(parseToml('[keys]\ndir = ".secrets"').keys.dir, ".secrets");
  assert.equal(parseToml('[keys]\ndir = "..hidden"').keys.dir, "..hidden");
});

test("a comment inside a string is not a comment", () => {
  assert.deepEqual(parseToml('[roles.a]\nwrites = ["a#b.ts"]').roles.a.writes, ["a#b.ts"]);
});

test("an array may span several lines", () => {
  const t = parseToml('[roles.a]\nwrites = [\n  "one",\n  "two"\n]');
  assert.deepEqual(t.roles.a.writes, ["one", "two"]);
});

test("unreadable input names its line", () => {
  assert.throws(() => parseToml("[roles.a]\nwrites = one"), /:2:/);
});

test("a subtree glob covers the directory it was granted", () => {
  assert.ok(covers("src/web/**", "src/web"));
  assert.ok(covers("src/web/**", "src/web/deep/a.ts"));
  assert.ok(!covers("src/web/**", "src/webx/a.ts"));
});

test("a star does not cross a slash, and a dotfile is not special", () => {
  assert.ok(covers("*.md", "README.md"));
  assert.ok(!covers("*.md", "docs/README.md"));
  // Deliberate: shell globs hide dotfiles, a permission tool must not.
  assert.ok(covers("*.env", ".env"));
});

test("a denial names the owner", () => {
  const v = explain(cfg, "frontend", "write", "src/api/server.ts");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.owners, ["backend"]);
  assert.match(v.reason, /belongs to backend/);
});

test("an unowned path is reported as a hole, not as a denial", () => {
  const v = explain(cfg, "frontend", "write", "scripts/deploy.sh");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.owners, []);
  assert.match(v.reason, /no owner/);
});

test("a key matches with or without its extension", () => {
  assert.deepEqual(keyHolders(cfg, "netlify"), ["frontend"]);
  assert.deepEqual(keyHolders(cfg, "netlify.txt"), ["frontend"]);
});

test("two roles may claim the same path, and both are named", () => {
  const shared = { ...cfg, roles: { ...cfg.roles, hotfix: { name: "hotfix", writes: ["src/**"], keys: [], network: null } } };
  assert.deepEqual(ownersOf(shared, "src/api/server.ts").sort(), ["backend", "hotfix"]);
});

test("the emitted settings carry every field the runtime requires", () => {
  // The runtime refuses to start on a partial settings file rather than falling
  // back to its defaults. Emitting the whole object is what makes that safe.
  const s = settingsFor(cfg, "frontend");
  assert.deepEqual(Object.keys(s.network).sort(), ["allowLocalBinding", "allowUnixSockets", "allowedDomains", "deniedDomains"]);
  assert.deepEqual(Object.keys(s.filesystem).sort(), ["allowRead", "allowWrite", "denyRead", "denyWrite"]);
});

test("the key directory is denied wholesale and re-allowed one file at a time", () => {
  const s = settingsFor(cfg, "frontend");
  assert.deepEqual(s.filesystem.denyRead, ["/repo/.secrets"]);
  assert.deepEqual(s.filesystem.allowRead, ["/repo/.secrets/netlify.txt"]);
});

test("a write glob becomes a directory, because the kernel grants subtrees", () => {
  // Passing `src/web/**` straight through would ask the OS for a directory
  // literally named `**`, which grants nothing and says nothing.
  assert.equal(settingsFor(cfg, "frontend").filesystem.allowWrite[0], "/repo/src/web");
});

test("every role also gets the scratch space an agent cannot run without", () => {
  // Territory alone is correct and unusable: an agent writes its session state
  // under its own config dir and its tools write to the temp dir. Measured
  // against a real config — with territory only, nothing started.
  const w = settingsFor(cfg, "frontend").filesystem.allowWrite;
  assert.equal(w.length, 1 + RUNTIME_WRITES.length);     // territory + scratch, and nothing else
  assert.ok(w.some((p) => p.endsWith("/.claude")));
  // The literal "/tmp" is deliberately NOT what lands: on macOS it is a symlink
  // and the sandbox enforces on the destination, so the grant is resolved first.
  assert.ok(w.some((p) => p.endsWith("/tmp")));
  assert.ok(!w.includes("/tmp") || realpathSync("/tmp") === "/tmp");
});

test("the scratch grants can be turned off, and then territory is all there is", () => {
  // Turning off scratch is a choice about the agent's toolchain. Nothing else
  // is smuggled back in — the audit directory is not here either, because the
  // instrument no longer needs a hole to write through.
  const strict = { ...cfg, runtimeWrites: [] };
  assert.deepEqual(settingsFor(strict, "frontend").filesystem.allowWrite, ["/repo/src/web"]);
});

test("the scratch grants never include the home directory itself", () => {
  // A grant that reaches ~ would hand over the shell profile, the ssh config
  // and every dotfile with a token in it. Scratch space is not a back door.
  const home = settingsFor(cfg, "frontend").filesystem.allowWrite.filter((p) => /\/Users\/[^/]+$|^\/home\/[^/]+$/.test(p));
  assert.deepEqual(home, []);
});

test("an unknown role fails loudly", () => {
  assert.throws(() => settingsFor(cfg, "nope"), /unknown role/);
});

test("the built environment drops what the policy did not name", () => {
  // Measured before this existed: 93 variables crossed into every turn, a
  // planted secret among them. denyRead guards files; an environment variable
  // is not a file.
  const parent = { PATH: "/bin", HOME: "/h", MY_API_TOKEN: "tok", RANDOM_THING: "x" };
  const { env, dropped } = buildEnv(parent, cfg.roles.frontend);
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
  assert.ok(dropped.includes("MY_API_TOKEN"));
});

test("a role can name the one variable it needs, and only that one", () => {
  const parent = { PATH: "/bin", BUILD_ID: "42", OTHER: "no" };
  const role = { ...cfg.roles.frontend, env: ["BUILD_ID"] };
  assert.deepEqual(Object.keys(buildEnv(parent, role).env).sort(), ["BUILD_ID", "PATH"]);
});

test("naming a credential explicitly works; sweeping one up does not", () => {
  // The block is on accident, not on intent. A role that says DEPLOY_TOKEN gets
  // it; what cannot happen is a credential riding along because nobody looked.
  const parent = { PATH: "/bin", DEPLOY_TOKEN: "t" };
  assert.ok(!("DEPLOY_TOKEN" in buildEnv(parent, cfg.roles.frontend).env));
  const named = { ...cfg.roles.frontend, env: ["DEPLOY_TOKEN"] };
  assert.equal(buildEnv(parent, named).env.DEPLOY_TOKEN, "t");
});

test("a secret split across two chunks is still masked", () => {
  // The first implementation masked only the part about to be emitted, so a
  // value straddling the cut left in two innocent halves. Caught on first run.
  const r = redactor(["tok-super-secreto-1234"]);
  let out = "";
  r.on("data", (d) => (out += d));
  r.write("the token is tok-super-");
  r.write("secreto-1234 and on\n");
  r.end();
  return new Promise((done) => r.on("end", () => {
    assert.ok(!out.includes("tok-super-secreto-1234"));
    assert.match(out, /‹redacted›/);
    done();
  }));
});

test("scan reports loose credentials and skips the protected directory", () => {
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "scan-"));
  mkdirSync(join(box, ".secrets"), { recursive: true });
  writeFileSync(join(box, ".secrets", "ok.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(box, "loose.env"), "API_TOKEN=abcdefghijklmnop\n");
  writeFileSync(join(box, "fine.env"), "API_TOKEN=changeme\n");
  const { hits } = scan(box, [".secrets"]);
  rmSync(box, { recursive: true, force: true });
  assert.deepEqual(hits.map((h) => h.file), ["loose.env"]);
});

test("a value read from the environment is not a finding", () => {
  // Measured on a real tree: 46 of 159 loose findings were exactly this, so the
  // scanner was flagging the correct way to handle a secret.
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "scan-"));
  writeFileSync(join(box, "good.py"), 'API_TOKEN = os.environ["API_TOKEN"]\n');
  writeFileSync(join(box, "good.ts"), "const API_TOKEN = process.env.API_TOKEN;\n");
  writeFileSync(join(box, "bad.env"), "API_TOKEN=abcdefghijklmnop\n");
  const { hits, skipped } = scan(box, []);
  rmSync(box, { recursive: true, force: true });
  // Assert the outcome, not the counter. Only one of the two good lines reaches
  // the reference check at all — `os.environ[` stops at the quote and falls
  // under the length floor — and both are correctly absent either way.
  assert.deepEqual(hits.map((h) => h.file), ["bad.env"]);
  assert.ok(skipped.reference >= 1);
});

test("findings are split by how much the shape alone proves", () => {
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "scan-"));
  writeFileSync(join(box, "issued.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(box, "maybe.env"), "DB_PASSWORD=hunter2hunter2hunter2\n");
  const { hits } = scan(box, []);
  rmSync(box, { recursive: true, force: true });
  assert.deepEqual(hits.filter((h) => h.level === "certain").map((h) => h.file), ["issued.txt"]);
  assert.deepEqual(hits.filter((h) => h.level === "review").map((h) => h.file), ["maybe.env"]);
});

test("caches and .bak copies are ignored by default", () => {
  // Both were most of the noise in the first real run: a scraped page carrying
  // someone else's API key, and one config repeated across five backups.
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "scan-"));
  mkdirSync(join(box, "_cache"), { recursive: true });
  writeFileSync(join(box, "_cache", "page.html"), "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(box, "settings.json.bak-2026"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const { hits } = scan(box, []);
  rmSync(box, { recursive: true, force: true });
  assert.deepEqual(hits, []);
});

test("the hook reads a file tool's target, and a shell redirect's", () => {
  assert.deepEqual(targetsOf("Write", { file_path: "src/a.ts" }), [{ action: "write", path: "src/a.ts" }]);
  assert.deepEqual(targetsOf("Bash", { command: "echo x > src/api/hack.ts" }),
    [{ action: "write", path: "src/api/hack.ts" }]);
  assert.deepEqual(targetsOf("Bash", { command: "cat a && tee out.txt" }),
    [{ action: "write", path: "out.txt" }]);
});

test("a command whose target the hook cannot see goes unexplained, not unblocked", () => {
  // The point of the split: this returns nothing, and the kernel still refuses
  // the write. An enforcer with this hole would be broken; an explainer is not.
  assert.deepEqual(targetsOf("Bash", { command: "python -c \"open('src/api/x','w')\"" }), []);
});

test("the hook denies with the owner's name, and says something different for a key", () => {
  const cfg2 = { ...cfg, root: "/repo" };
  const noop = () => true;
  const w = decide(cfg2, "frontend", { tool_name: "Write", tool_input: { file_path: "src/api/s.ts" } }, { now: noop });
  assert.match(w.hookSpecificOutput.permissionDecisionReason, /belongs to backend/);
  const r = decide(cfg2, "frontend", { tool_name: "Read", tool_input: { file_path: ".secrets/database.txt" } }, { now: noop });
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /declared for backend/);
  assert.doesNotMatch(r.hookSpecificOutput.permissionDecisionReason, /to change/);
});

test("observe records the same decisions and returns none of them", () => {
  const seen = [];
  const out = decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Write", tool_input: { file_path: "src/api/s.ts" } },
    { observe: true, now: (_f, e) => seen.push(e) });
  assert.equal(out.decision, null);
  assert.equal(out.hookSpecificOutput, undefined);
  assert.equal(seen[0].verdict, "observed");
});

test("observed paths collapse to directories, not to the whole tree", () => {
  // Two files under src/api must not generalise to src/**: that hands over the
  // repo on the strength of two writes.
  assert.deepEqual(generalise(["src/api/a.ts", "src/api/b.ts", "src/api/deep/c.ts"]), ["src/api/**"]);
  assert.deepEqual(generalise(["src/api/a.ts", "docs/x.md"]).sort(), ["docs/**", "src/api/**"]);
});

test("a half-written log line is skipped, not fatal", () => {
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "log-"));
  const f = join(box, "log.jsonl");
  writeFileSync(f, '{"role":"a","target":"x","action":"write","verdict":"denied"}\n{"role":"b",\n');
  const entries = read(f);
  rmSync(box, { recursive: true, force: true });
  assert.equal(entries.length, 1);
});

test("the audit directory is not writable from inside the box", () => {
  // It used to be, because the hook runs inside and has to record what it
  // decided — which made the log and the queue writable by the process they
  // are a record of. An external review named it: nothing enforced the word
  // "append-only" that those files use about themselves.
  const w = settingsFor(cfg, "frontend").filesystem.allowWrite;
  assert.ok(!w.some((p) => p.endsWith("/.seisin")), ".seisin is reachable from inside");
});

test("the audit socket is granted by path, and only when there is one", () => {
  // The replacement for that grant: the hook sends a line to the parent, which
  // holds the file. One socket, named, not "unix sockets are on now".
  assert.deepEqual(settingsFor(cfg, "frontend").network.allowUnixSockets, []);
  const s = settingsFor(cfg, "frontend", "/tmp/seisin-1.sock");
  assert.deepEqual(s.network.allowUnixSockets, ["/tmp/seisin-1.sock"]);
  // and it does not quietly become a filesystem grant
  assert.ok(!s.filesystem.allowWrite.includes("/tmp/seisin-1.sock"));
});

test("reading an ordinary file is never denied", () => {
  // Territory divides who may change something. An agent that cannot read the
  // rest of the repo cannot work, and the hook denying a plain Read produced a
  // log full of tidy `denied` lines that looked exactly like success.
  const seen = [];
  const out = decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Read", tool_input: { file_path: "src/api/server.ts" } },
    { now: (_f, e) => seen.push(e) });
  assert.equal(out.decision, null);
  assert.deepEqual(seen, []);
});

test("reading a key still is a policy question", () => {
  const seen = [];
  const out = decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Read", tool_input: { file_path: ".secrets/database.txt" } },
    { now: (_f, e) => seen.push(e) });
  assert.equal(out.decision, "deny");
  assert.equal(seen[0].verdict, "denied");
});

test("shell debris does not become a log entry", () => {
  // Reading a command with regular expressions picks up things that are not
  // paths. Each one is a line claiming a role was denied something it never
  // asked for, and a log with invented entries in it stops being read.
  const junk = targetsOf("Bash", { command: 'if [ -w x ] && test -f y; then echo a 2>&1 > /dev/null; fi' });
  assert.deepEqual(junk.map((t) => t.path).filter((p) => ["test", "2>", "2>&1", "/dev/null"].includes(p)), []);
  // and a real target still comes through
  assert.deepEqual(targetsOf("Bash", { command: "echo x > src/api/real.ts" }),
    [{ action: "write", path: "src/api/real.ts" }]);
});

test("scratch covers the XDG dirs, and never ~/.config", () => {
  // The first list named ~/.claude and ~/.codex and stopped there, so the first
  // agent that was neither — opencode, logging to ~/.local/share — died at
  // startup. ~/.config stays out on purpose: that is where gh keeps its token.
  const w = settingsFor(cfg, "frontend").filesystem.allowWrite;
  assert.ok(w.some((p) => p.endsWith("/.local/share")));
  assert.ok(!w.some((p) => p.endsWith("/.config")));
});

/* ── lo que el refactor hizo alcanzable ───────────────────────────────── */

test("inspect names a path two roles claim", () => {
  // Antes esto sólo se podía comprobar lanzando el binario y buscando texto en
  // su stdout, que prueba el renderizador tanto como la lógica.
  const shared = { ...cfg, roles: { ...cfg.roles,
    hotfix: { name: "hotfix", writes: ["src/**"], keys: [], env: [] } } };
  const r = inspect(shared, null, "seisin.toml");
  assert.ok(r.warnings.some((w) => w.kind === "shared"));
  // `src/**` NO aparece: su raíz `src` la cubre un solo rol. Lo compartido son
  // los dos territorios que quedan adentro del de hotfix.
  assert.deepEqual(sharedPaths(shared).sort(), ["src/api/**", "src/web/**"]);
});

test("inspect warns when the repo sits inside shared scratch", () => {
  // El aviso más valioso de `check`, y el que un test no podía tocar: el propio
  // banco de pruebas vivía en el temp dir y hacía pasar una prueba de frontera
  // por la razón equivocada.
  const enScratch = { ...cfg, root: join(realpathSync(tmpdir()), "algun-repo") };
  const r = inspect(enScratch, null, "seisin.toml");
  assert.ok(r.warnings.some((w) => w.kind === "scratch"));
});

test("inspect warns when keys are declared with nowhere to scope them", () => {
  const sinDir = { ...cfg, keyDirs: [] };
  assert.ok(inspect(sinDir, null, "x").warnings.some((w) => w.kind === "keys-unscoped"));
});

test("asking about a role that does not exist is an error, not an empty report", () => {
  // Contestar un typo con silencio es como un typo se convierte en una creencia.
  assert.throws(() => inspect(cfg, "no-existe", "x"), /unknown role/);
});

test("the renderer never decides anything", () => {
  // Contrato del módulo: mismo dato, mismo texto, sin leer nada de afuera.
  const informe = inspect(cfg, null, "seisin.toml");
  assert.equal(renderReport(informe), renderReport(informe));
  assert.match(renderReport(informe), /frontend/);
});

test("a denial renders with its owner, an allow does not", () => {
  const no = renderVerdict("frontend", "write", "src/api/s.ts",
    explain(cfg, "frontend", "write", "src/api/s.ts"));
  assert.match(no, /denied/);
  assert.match(no, /belongs to backend/);
  assert.match(renderVerdict("backend", "write", "src/api/s.ts",
    explain(cfg, "backend", "write", "src/api/s.ts")), /allowed/);
});

test("the proposed config leads with the agent's own API", () => {
  // Sin esto el agente no se autentica y falla con un 403 del proxy antes de
  // trabajar, que se lee como instalación rota y no como política estricta.
  const toml = renderConfig({ source: "prueba", roles: [{ name: "a", writes: ["x/**"], keys: [] }] });
  assert.match(toml, /api\.anthropic\.com/);
  assert.match(toml, /\[roles\.a\]/);
});

test("the public API exposes decisions, not rendering", () => {
  // La línea que hace refactorizable el resto: lo que no está acá es interno.
  assert.ok(publica.explain && publica.settingsFor && publica.inspect && publica.scan);
  assert.equal(publica.renderReport, undefined);
  assert.equal(publica.run, undefined);
});

/* ── pedidos de permiso ───────────────────────────────────────────────── */

test("many denials in one directory are one request, not many", () => {
  // Un agente frenado en a.ts y después en b.ts no hace dos preguntas, y una
  // cola que dice que sí se vuelve una cola que nadie lee.
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "req-"));
  const f = join(box, "requests.jsonl");
  for (const t of ["src/api/a.ts", "src/api/b.ts", "src/api/a.ts"])
    record(f, { role: "frontend", action: "write", target: t, owners: ["backend"] });
  const q = pending(f);
  rmSync(box, { recursive: true, force: true });
  assert.equal(q.length, 1);
  assert.equal(q[0].times, 3);
  assert.equal(q[0].grant, "src/api/**");
  assert.deepEqual(q[0].owners, ["backend"]);
});

test("a settled request leaves the queue but not the file", () => {
  // Append-only: una decisión que se puede reescribir no es evidencia.
  const box = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "req-"));
  const f = join(box, "requests.jsonl");
  record(f, { role: "qa", action: "write", target: "docs/x.md", owners: [] });
  const [req] = pending(f);
  settle(f, req.key, "denied", "no es suyo");
  const abiertos = pending(f);
  const todos = pending(f, { includeSettled: true });
  const lineas = readFileSync(f, "utf8").trim().split("\n").length;
  rmSync(box, { recursive: true, force: true });
  assert.equal(abiertos.length, 0);
  assert.equal(todos[0].state, "denied");
  assert.equal(todos[0].reason, "no es suyo");
  assert.equal(lineas, 2);
});

test("a grant lands in the right role, with its provenance", () => {
  const toml = '[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\n';
  const req = { role: "frontend", action: "write", grant: "src/api/**", times: 3 };
  const { toml: after, changed } = applyGrant(toml, req, "se lleva el checkout");
  assert.ok(changed);
  assert.match(after, /"src\/web\/\*\*",/);
  assert.match(after, /"src\/api\/\*\*"\s+# granted .* asked 3× · "se lleva el checkout"/);
  // y no tocó al otro rol
  assert.match(after, /\[roles\.backend\]\nwrites = \["src\/api\/\*\*"\]/);
});

test("granting something a role already has changes nothing", () => {
  const toml = '[roles.a]\nwrites = ["x/**"]\n';
  const { changed } = applyGrant(toml, { role: "a", action: "write", grant: "x/**", times: 1 }, "");
  assert.equal(changed, false);
});

test("a key request grants the key, not a directory glob", () => {
  assert.equal(grantFor({ action: "read", target: ".secrets/netlify.txt" }), "netlify.txt");
  assert.equal(grantFor({ action: "write", target: "src/api/a.ts" }), "src/api/**");
});

test("observing records no requests, because nothing was refused", () => {
  const asked = [];
  decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Write", tool_input: { file_path: "src/api/s.ts" } },
    { observe: true, now: () => true, ask: (_f, r) => asked.push(r) });
  assert.deepEqual(asked, []);
});

test("a denial leaves a request behind", () => {
  const asked = [];
  decide({ ...cfg, root: "/repo" }, "frontend",
    { tool_name: "Write", tool_input: { file_path: "src/api/s.ts" } },
    { now: () => true, ask: (_f, r) => asked.push(r) });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].owners, ["backend"]);
});

test("the public surface can read the queue and cannot approve", () => {
  // La invariante del diseño, como prueba: aprobar no es una llamada de
  // herramienta, así que ni settle ni applyGrant salen por la puerta pública.
  assert.ok(publica.pendingRequests && publica.grantFor);
  assert.equal(publica.settle, undefined);
  assert.equal(publica.applyGrant, undefined);
});

test("a territory can reach outside the config's own directory", () => {
  // El adaptador emite `../` cuando el territorio sale de la célula, y eso solo
  // es correcto si acá se sostiene. Un rol posee su árbol de trabajo adentro y
  // su traspaso un nivel arriba; sin esto el generador tendría que elegir entre
  // dos bases relativas en un archivo, que fue el bug que lo trajo.
  const cfg = {
    root: "/repo", keyDirs: [], allowedDomains: [],
    roles: { dev: { name: "dev", writes: ["proyecto/**", "../bitacora/lab/dev.md"], keys: [], network: null } },
  };
  assert.ok(explain(cfg, "dev", "write", "proyecto/a.py").allowed);
  assert.ok(explain(cfg, "dev", "write", "../bitacora/lab/dev.md").allowed);
  // y el escape no abre el directorio entero
  assert.ok(!explain(cfg, "dev", "write", "../bitacora/lab/qa.md").allowed);
});

/* ── policy == explicación == frontera ─────────────────────────────────── */

test("a pattern the kernel cannot express is refused, not widened", () => {
  // El hallazgo de una revisión externa, y era el peor posible. ownersOf() lee
  // `src/*` como un nivel (`*` → [^/]*), y la traducción vieja recortaba el
  // `/*` y le entregaba `src` al kernel, que es el subárbol entero. O sea:
  // `seisin explain` decía denegado y la escritura entraba. Comprobado contra
  // el sandbox real, no razonado.
  const mk = (w) => ({ root: "/repo", keyDirs: [], allowedDomains: [],
                       roles: { r: { name: "r", writes: [w], keys: [], network: null } } });

  // No hay traducción exacta que encontrar después: el sandbox concede
  // prefijos, y "un nivel abajo" no es un prefijo.
  for (const malo of ["src/*", "src/*/foo/**", "src/??/**", "src/[ab]/**"])
    assert.throws(() => settingsFor(mk(malo), "r"), /cannot be enforced/, malo);

  // Y lo que sí es expresable sigue siéndolo, sin cambiar de significado.
  const w = (g) => settingsFor(mk(g), "r").filesystem.allowWrite;
  assert.ok(w("src/**").includes("/repo/src"));
  assert.ok(w("src/api/x.ts").includes("/repo/src/api/x.ts"));
  assert.ok(w("**").includes("/repo"));
});

test("check says so before anything runs", () => {
  const cfg = { root: "/repo", keyDirs: [], allowedDomains: [], path: "seisin.toml",
                roles: { r: { name: "r", writes: ["src/*"], keys: [], network: null } } };
  const w = inspect(cfg, null, "seisin.toml").warnings.find((x) => x.kind === "unenforceable-glob");
  assert.ok(w, "check no avisa de un patrón que run va a rechazar");
  assert.match(w.headline, /src\/\*/);
});

test("a path is canonical before anyone decides who owns it", () => {
  // src/web/../api/orders.ts es de backend. Sin resolver, matcheaba src/web/**:
  // `whose` nombraba al dueño equivocado, el hook no levantaba pedido, y el log
  // anotaba allowed para una escritura que el kernel después rechazaba. La
  // frontera aguantaba; todo lo que seisin decía sobre ella era falso.
  assert.deepEqual(ownersOf(shared2, "src/web/../api/orders.ts"), ["backend"]);
  assert.ok(!explain(shared2, "frontend", "write", "src/web/../api/orders.ts").allowed);

  assert.deepEqual(ownersOf(shared2, "src/web//./a.tsx"), ["frontend"]);
  // Fuera del repo no es de nadie, y no hay patrón que lo alcance.
  assert.deepEqual(ownersOf(shared2, "../fuera.txt"), []);
  assert.ok(!explain(shared2, "frontend", "write", "../../etc/passwd").allowed);
});

const shared2 = {
  root: "/repo", keyDirs: [], allowedDomains: [],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: [], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: [], network: null },
  },
};

/* ── el carrete de auditoría ──────────────────────────────────────────── */

test("the spool carries an entry to the parent, and the parent picks the file", async (t) => {
  // El único verbo alcanzable desde adentro es "mandá una línea": no hay
  // descriptor, así que no hay seek, truncate ni unlink. Y el remitente no
  // elige la ruta — nombra un destino y el padre decide qué significa.
  const got = [];
  const s = await spool((to, entry) => got.push([to, entry]), join(tmpdir(), `seisin-t${process.pid}.sock`));
  t.after(() => s.close());

  send("log", { role: "frontend", verdict: "denied" }, s.path);
  send("requests", { role: "qa", action: "write" }, s.path);
  send("otro-lado", { role: "qa" }, s.path);            // destino inventado
  send("log", "no soy un objeto", s.path);
  await flush();
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(got.map((g) => g[0]), ["log", "requests", "log"]);
  assert.equal(got[0][1].role, "frontend");
  assert.ok(got[0][1].at, "el sello de tiempo es del momento de la decisión, no de cuando el padre lo leyó");
});

test("with no parent listening, send says so instead of pretending", () => {
  // Sin padre, append() cae al archivo. Si send() mintiera, el hook creería
  // haber grabado y el registro quedaría vacío en una corrida que funcionó —
  // que es exactamente cómo se rompió este instrumento la primera vez.
  assert.equal(send("log", { role: "x" }, undefined), false);
  assert.equal(send("log", { role: "x" }, ""), false);
});

/* ── la consola ───────────────────────────────────────────────────────── */

/** Levanta la consola sobre un repo de mentira y devuelve cómo hablarle. */
async function consola(t) {
  const box = mkdtempSync(join(tmpdir(), "seisin-ui-"));
  writeFileSync(join(box, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\nkeys   = []\n');
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "frontend", action: "write", target: "src/api/checkout/a.ts", owners: ["backend"] });

  const server = await serve(join(box, "seisin.toml"), 0);
  const port = server.address().port;
  t.after(() => server.close());

  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = (page.match(/window\.SEISIN_TOKEN=\"([a-f0-9]+)\"/) ?? [])[1];
  const post = (body, tok = token) =>
    fetch(`http://127.0.0.1:${port}/api/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok ? { "x-seisin-token": tok } : {}) },
      body: JSON.stringify(body),
    });
  return { box, port, token, post };
}

test("the console hands the page a token and refuses a write without it", async (t) => {
  // Loopback no es una frontera contra el navegador: cualquier pestaña abierta
  // puede hacer POST a 127.0.0.1. Lo que no puede es leer este token.
  const { token, post, box } = await consola(t);
  assert.match(token ?? "", /^[a-f0-9]{48}$/);

  const sin = await post({ number: 1, decision: "granted" }, null);
  assert.equal(sin.status, 403);
  const mal = await post({ number: 1, decision: "granted" }, "0".repeat(48));
  assert.equal(mal.status, 403);
  // y nada cambió en el disco
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
});

test("approving in the console writes the policy, with its reason", async (t) => {
  const { post, box } = await consola(t);
  const r = await post({ number: 1, decision: "granted", reason: "se lleva el checkout" });
  assert.equal(r.status, 200);

  const toml = readFileSync(join(box, "seisin.toml"), "utf8");
  assert.match(toml, /src\/api\/checkout\/\*\*/);
  assert.match(toml, /se lleva el checkout/);     // la procedencia viaja con la línea
  assert.equal(pending(join(box, ".seisin", "requests.jsonl")).length, 0);
});

test("refusing in the console settles the request and grants nothing", async (t) => {
  const { post, box } = await consola(t);
  assert.equal((await post({ number: 1, decision: "denied", reason: "no es suyo" })).status, 200);
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
  assert.equal(pending(join(box, ".seisin", "requests.jsonl")).length, 0);
});

test("the console refuses a decision it does not understand", async (t) => {
  const { post, box } = await consola(t);
  for (const cuerpo of [{ number: 9, decision: "granted" }, { number: 1, decision: "maybe" }])
    assert.equal((await post(cuerpo)).status, 400);
  assert.ok(!readFileSync(join(box, "seisin.toml"), "utf8").includes("checkout"));
});

test("the console's state carries the queue the page renders", async (t) => {
  const { port } = await consola(t);
  const s = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].grant, "src/api/checkout/**");
  assert.deepEqual(s.requests[0].owners, ["backend"]);
});

/* ── lo que la herramienta no cubre ──────────────────────────────────── */

test("check states the gap it does not cover, every time", () => {
  // El README lo decía en tres lugares y `check` no lo decía en ninguno, que es
  // el único que alguien mira antes de confiar en el mapa. Fijado acá porque un
  // límite que se puede borrar sin que nada se queje vuelve a ser una promesa.
  const { limits } = inspect(cfg, null, "seisin.toml");
  const borrado = limits.find((l) => l.kind === "unlink-uncovered");
  assert.ok(borrado, "check ya no dice que un rol puede borrar dentro de su territorio");
  assert.match(borrado.detail, /denyUnlink/);   // y adónde fue el pedido
});

/* ── el servidor MCP ──────────────────────────────────────────────────── */

test("the MCP surface has no tool that changes anything", () => {
  // La invariante, como prueba y no como comentario. Si alguien agrega un
  // seisin_grant, esto se pone rojo antes de que llegue a un release.
  const nombres = TOOLS.map((t) => t.name);
  const mutantes = nombres.filter((n) => /grant|deny|approve|apply|set|write|update|delete/.test(n));
  assert.deepEqual(mutantes, ["seisin_draft_grant"]);   // draft: redacta, no aplica
  assert.ok(nombres.every((n) => typeof HANDLERS[n] === "function"));
});

test("every MCP tool declares a schema a client can render", () => {
  for (const t of TOOLS) {
    assert.equal(typeof t.description, "string");
    assert.equal(t.inputSchema.type, "object");
    for (const req of t.inputSchema.required ?? [])
      assert.ok(t.inputSchema.properties[req], `${t.name}: requires "${req}" but never declares it`);
  }
});

test("version negotiation echoes a known version and offers the newest otherwise", async () => {
  const NL = String.fromCharCode(10);
  const hablar = async (version) => {
    const dicho = [];
    const req = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } };
    await serveMcp("9.9.9", Readable.from([JSON.stringify(req) + NL]), { write: (s) => dicho.push(s) });
    return JSON.parse(dicho[0]).result;
  };
  const conocida = await hablar("2025-06-18");
  const rara = await hablar("1999-01-01");
  assert.equal(conocida.protocolVersion, "2025-06-18");   // conocida: se devuelve igual
  assert.equal(rara.protocolVersion, PROTOCOLS[0]);       // desconocida: se ofrece la nuestra
  assert.equal(conocida.serverInfo.version, "9.9.9");
  assert.deepEqual(Object.keys(conocida.capabilities), ["tools"]);
});

test("a notification is never answered", async () => {
  // Contestar una notificacion es un error de protocolo que algunos clientes
  // toleran y en el que otros se cuelgan.
  const NL = String.fromCharCode(10);
  const dicho = [];
  const nota = { jsonrpc: "2.0", method: "notifications/initialized" };
  await serveMcp("1.0.0", Readable.from([JSON.stringify(nota) + NL]), { write: (s) => dicho.push(s) });
  assert.deepEqual(dicho, []);
});

test("unparseable input does not kill the session", async () => {
  const NL = String.fromCharCode(10);
  const dicho = [];
  const ping = { jsonrpc: "2.0", id: 7, method: "ping" };
  await serveMcp("1.0.0", Readable.from(["esto no es json" + NL, JSON.stringify(ping) + NL]),
    { write: (s) => dicho.push(s) });
  assert.equal(JSON.parse(dicho[0]).id, 7);   // la basura se descarta y sigue atendiendo
});
