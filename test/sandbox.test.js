/**
 * The end-to-end test: a real command, in a real sandbox, on a real temp repo.
 *
 * These are slower than the unit tests and they are the only ones that can tell
 * you the thing actually holds. Everything above this file checks that seisin
 * *asks* for the right policy; this checks that the policy *lands*.
 *
 * It skips instead of failing where the runtime is missing, so a contributor on
 * an unsupported platform still gets a green suite — and a loud skip.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const haveSrt = spawnSync("command", ["-v", "srt"], { shell: true }).status === 0;
const skip = haveSrt ? false : "sandbox runtime not installed (npm i -g @anthropic-ai/sandbox-runtime)";

let repo;
before(() => {
  // NOT under the system temp dir, and that is the point. seisin grants scratch
  // space to every role, so a repo living inside it is writable by all of them —
  // which would let "a role cannot write outside it" pass by accident. It did,
  // once, and this is the fix.
  const box = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
  mkdirSync(box, { recursive: true });
  repo = mkdtempSync(join(box, "repo-"));
  mkdirSync(join(repo, "src", "web"), { recursive: true });
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  mkdirSync(join(repo, ".secrets"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "server.ts"), "api\n");
  writeFileSync(join(repo, ".secrets", "netlify.txt"), "FAKE-NETLIFY\n");
  writeFileSync(join(repo, ".secrets", "database.txt"), "FAKE-DATABASE\n");
  writeFileSync(join(repo, "seisin.toml"),
    '[keys]\ndir = ".secrets"\n\n[network]\nallow = []\n\n' +
    '[roles.frontend]\nwrites = ["src/web/**"]\nkeys = ["netlify.txt"]\n\n' +
    '[roles.backend]\nwrites = ["src/api/**"]\nkeys = ["database.txt"]\n');
});

/** Runs a shell line through seisin and reports only whether it succeeded. */
function as(role, line) {
  const r = spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line],
    { cwd: repo, encoding: "utf8" });
  return r.status === 0;
}

test("a role reads the key it declares", { skip }, () => {
  assert.ok(as("frontend", "cat .secrets/netlify.txt"));
});

test("a role cannot read another role's key", { skip }, () => {
  assert.ok(!as("frontend", "cat .secrets/database.txt"));
});

test("each role reads its own, so the deny is not just blanket", { skip }, () => {
  // Without this, a config that denied the whole key directory to everyone
  // would pass the test above while being useless.
  assert.ok(as("backend", "cat .secrets/database.txt"));
});

test("a role writes inside its territory", { skip }, () => {
  assert.ok(as("frontend", "echo x > src/web/new.ts"));
});

test("a role cannot write outside it", { skip }, () => {
  assert.ok(!as("frontend", "echo x > src/api/new.ts"));
});

test("reading another role's code still works", { skip }, () => {
  // Territory partitions writes, not reads. An agent that cannot read the rest
  // of the repo cannot do the job.
  assert.ok(as("frontend", "cat src/api/server.ts"));
});

test("the boundary survives a grandchild process", { skip }, () => {
  // This is the line between asking and enforcing. A hook that inspects the
  // command string sees `sh`; the kernel sees the read.
  assert.ok(!as("frontend", 'sh -c "cat .secrets/database.txt"'));
});

test("an absolute path does not walk around the rule", { skip }, () => {
  assert.ok(!as("frontend", `cat ${JSON.stringify(join(repo, ".secrets", "database.txt"))}`));
});

test("the child's exit code comes back out", { skip }, () => {
  // Regression, and the ugliest kind. Redaction pipes the child's output, and
  // the drain logic subscribed to `finish` AFTER calling end() — which misses
  // the event when it fires synchronously. Nothing ever called exit, the
  // process drifted out of the event loop, and every run reported 0. A battery
  // of seven sandbox checks came back green while the sandbox was doing its
  // job perfectly: the harness could not see the failures.
  const r = (line) => spawnSync(process.execPath, [CLI, "run", "frontend", "--", "sh", "-c", line],
    { cwd: repo, encoding: "utf8" });
  assert.equal(r("exit 0").status, 0);
  assert.equal(r("exit 42").status, 42);
  assert.notEqual(r("cat .secrets/database.txt").status, 0);
});

test("output still arrives in full when it is redacted", { skip }, () => {
  // The other half: exiting the moment the child does discards whatever is
  // still in the stream, so the command looks like it printed nothing.
  const r = spawnSync(process.execPath,
    [CLI, "run", "frontend", "--", "sh", "-c", 'echo "before $(cat .secrets/netlify.txt) after"'],
    { cwd: repo, encoding: "utf8" });
  assert.match(r.stdout, /before .* after/);
  assert.doesNotMatch(r.stdout, /FAKE-NETLIFY/);
});

test("check exits clean on a valid config", { skip: false }, () => {
  execFileSync(process.execPath, [CLI, "check"], { cwd: repo, encoding: "utf8" });
});

test("explain exits 1 when it denies, so it composes in a script", { skip: false }, () => {
  const r = spawnSync(process.execPath, [CLI, "explain", "frontend", "write", "src/api/server.ts"], { cwd: repo });
  assert.equal(r.status, 1);
});

test("the agent's own flags are not eaten by the sandbox", { skip }, () => {
  // seisin sits between you and the sandbox, and the sandbox has flags of its
  // own: --settings, --debug, -c, -s. Without a `--` separator it parses the
  // command you asked for and fails on your agent's arguments as if they were
  // its own. `claude -c` would have broken silently.
  const r = spawnSync(process.execPath,
    [CLI, "run", "frontend", "--", "sh", "-c", 'echo "--settings --debug -c survived"'],
    { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--settings --debug -c survived/);
});

test("CR-1 · a missing boundary refuses to run, and the child never starts", { skip: false }, () => {
  // El modo de falla más caro del informe de campo: dos caminos de aplicación
  // de distinta fuerza, y el débil elegido en silencio. Acá no hay camino débil:
  // sin runtime no se ejecuta nada.
  const canario = join(repo, "canario-cr1.txt");
  const r = spawnSync(process.execPath, [CLI, "run", "frontend", "--", "sh", "-c", `touch ${JSON.stringify(canario)}`],
    { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" } });
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(canario), "el hijo corrió igual: eso es degradación silenciosa");
});

test("CR-2 · ownership does not depend on which role is asking", { skip }, () => {
  // La respuesta a "de quién es esto" sale de un solo mapa con todos los roles,
  // así que es simétrica. El mapa por corrida del informe hacía que un archivo
  // ajeno pareciera sin dueño.
  const preguntar = (rol, ruta) => spawnSync(process.execPath, [CLI, "whose", ruta],
    { cwd: repo, encoding: "utf8", env: { ...process.env, SEISIN_ROLE: rol } }).stdout;
  assert.match(preguntar("frontend", "src/api/x.ts"), /belongs to backend/);
  assert.match(preguntar("backend", "src/web/y.ts"), /belongs to frontend/);
});

test("CR-3 · the confined process can ask whose it is", { skip }, () => {
  // El titular del README —"no, y es de X"— viene del hook, y quien sólo
  // envuelve un proceso no lo tiene. Esta consulta lo cierra sin integración:
  // la instrucción pasa a ser "ante EPERM, preguntá de quién es".
  const r = spawnSync(process.execPath,
    [CLI, "run", "frontend", "--", process.execPath, CLI, "whose", "src/api/server.ts"],
    { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, "la consulta quedó bloqueada por la caja que está consultando");
  assert.match(r.stdout, /belongs to backend/);
  assert.match(r.stdout, /you are frontend/);
});
