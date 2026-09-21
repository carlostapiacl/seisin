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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSrt } from "../src/commands/run.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
// Resolved the way `seisin run` resolves it, not the way a shell would. This
// asked `command -v srt` — the global install only — so a checkout whose
// bundled runtime was right there skipped fourteen tests and reported green.
// Found in Docker on Debian: `srt: installed`, and the sandbox half skipped
// anyway. A test that decides it cannot run must decide that the same way the
// code decides it can.
const haveSrt = resolveSrt() !== null;
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

/**
 * No `skip`: the refusal lands before the runtime is touched, so this holds on a
 * machine without srt — which is also where a nested run would be most confusing.
 */
test("seisin refuses to run inside seisin, by name", () => {
  const r = spawnSync(process.execPath, [CLI, "run", "backend", "--", "sh", "-c", "echo x"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, SEISIN_ROLE: "frontend" },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not nest/);
  assert.match(r.stderr, /frontend/); // the box it is already in, not just the one it asked for
});

/**
 * The test that was missing, and its absence is the whole story: `isolate = true`
 * never started on macOS — the runtime's socket lives inside the role's home and
 * the path cleared the 104-byte cap for every role name — and the suite stayed
 * green because nothing here ever turned the feature on. Unit tests can check
 * the arithmetic; only this can check that it runs.
 */
test("an isolated role starts, and loses the credentials the ordinary mode leaves open", { skip }, () => {
  const box = join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box");
  const iso = mkdtempSync(join(box, "iso-"));
  mkdirSync(join(iso, "src"), { recursive: true });
  writeFileSync(join(iso, "seisin.toml"),
    '[network]\nallow = []\n\n[roles.dev]\nwrites = ["src/**"]\n\n[runtime]\nisolate = true\n');

  const run = (line) => spawnSync(process.execPath, [CLI, "run", "dev", "--", "sh", "-c", line],
    { cwd: iso, encoding: "utf8" });

  const arranca = run("echo up");
  assert.equal(arranca.status, 0, `no arrancó: ${arranca.stderr.trim()}`);
  assert.doesNotMatch(arranca.stderr, /EINVAL/, "el socket del runtime no entró en la ruta");

  // Its own territory still works, and the home is its own.
  assert.equal(run("echo x > src/a.txt").status, 0);
  assert.match(run("echo $HOME").stdout, /sn-/);

  // And the reason the mode exists: these are readable without it.
  assert.notEqual(run("test -r ~/.ssh").status, 0, "~/.ssh sigue legible bajo isolate");

  rmSync(iso, { recursive: true, force: true });
});

/* ── keys that are references, through the real kernel ──────────────────────
 *
 * The unit tests for this hand `resolveRef` a fake runner, which is right for
 * asking what the code decides and useless for asking what actually happens.
 * These five run real commands: the provider is a real process, the boundary
 * is the real kernel, and the value is a real string that either shows up
 * somewhere it should not or does not.
 */

/** A repo whose policy resolves a key from a command instead of a file. */
function refRepo(toml) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".sandbox-box", "refs-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

const runIn = (cwd, role, line) =>
  spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", line], { cwd, encoding: "utf8" });

const SECRET = "valor-de-prueba-9c1f4b7e";

test("a reference resolves and the value reaches the child through the real sandbox", { skip }, () => {
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\ncommand = ["printf", "%s", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://${SECRET}"]\n`);
  // Its LENGTH, not the value: the redactor masks the value on the way out, so
  // asserting on the value here would pass for the wrong reason the day the
  // masking broke. The length survives redaction and still proves arrival.
  const r = runIn(dir, "dev", 'printf "len=%s" "${#T}"');
  assert.match(r.stdout, new RegExp(`len=${SECRET.length}`));
  rmSync(dir, { recursive: true, force: true });
});

test("the resolved value is in no file seisin wrote — not the settings, not the log", { skip }, () => {
  // The promise is that what gets recorded is the REFERENCE. This is the test
  // that would catch it not being true, and it is the one worth having.
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\ncommand = ["printf", "%s", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://${SECRET}"]\n`);
  runIn(dir, "dev", 'echo "$T" > src/leak.txt');       // the agent itself may spill it; that is its business
  for (const f of ["dev.json", "log.jsonl", "requests.jsonl"]) {
    const p = join(dir, ".seisin", f);
    if (!existsSync(p)) continue;
    assert.ok(!readFileSync(p, "utf8").includes(SECRET), `${f} contains the resolved value`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the provider runs OUTSIDE the box — it writes where the role cannot", { skip }, () => {
  // The security property, asserted structurally instead of described. The
  // provider touches a path outside the role's territory: confined as `dev`
  // that write is refused, so the file existing proves the parent ran it.
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\n` +
    `command = ["sh", "-c", "touch outside-territory.marker; printf %s {ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://${SECRET}"]\n`);
  // First: prove the role really cannot write there, or the assertion below
  // proves nothing. A test whose premise is untested is decoration.
  assert.notEqual(runIn(dir, "dev", "touch outside-territory.marker").status, 0);
  rmSync(join(dir, "outside-territory.marker"), { force: true });
  const r = runIn(dir, "dev", 'printf "len=%s" "${#T}"');
  assert.equal(r.status, 0);
  assert.ok(existsSync(join(dir, "outside-territory.marker")),
    "the provider's write landed, so it was not confined as the role");
  rmSync(dir, { recursive: true, force: true });
});

test("scratch hands the role a readable file, and the turn takes it away", { skip }, () => {
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\ncommand = ["printf", "%s", "{ref}"]\nmode = "scratch"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://${SECRET}"]\n`);
  // Inside: the file is there, the role may read it, and the bytes are right.
  const r = runIn(dir, "dev", 'printf "len=%s path=%s" "$(wc -c < "$T_FILE" | tr -d " ")" "$T_FILE"');
  assert.match(r.stdout, new RegExp(`len=${SECRET.length}\\b`));
  const path = /path=(\S+)/.exec(r.stdout)?.[1];
  assert.ok(path, "the role was told where its key is");
  // After: gone. Not "should be" — checked from out here, where the cleanup ran.
  assert.ok(!existsSync(path), "the scratch key outlived its turn");
  rmSync(dir, { recursive: true, force: true });
});

test("scratch announces the path under BOTH conventions, because the world has two", { skip }, () => {
  // `<NAME>_FILE` is the Docker-secrets shape. But `KUBECONFIG`,
  // `GOOGLE_APPLICATION_CREDENTIALS` and friends already expect a path in the
  // plain variable, and for those `KUBECONFIG_FILE` is a name nothing reads.
  // Found by running kubectl against it: the file was right and the variable
  // it was announced under was one kubectl has never heard of.
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\ncommand = ["printf", "%s", "{ref}"]\nmode = "scratch"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://${SECRET}"]\n`);
  const r = runIn(dir, "dev", 'printf "plain=%s file=%s" "$T" "$T_FILE"');
  const m = /plain=(\S+) file=(\S+)/.exec(r.stdout);
  assert.ok(m, "both variables are set");
  assert.equal(m[1], m[2], "both name the same path");
  // And neither holds the value — in scratch mode the secret is in the file.
  assert.ok(!r.stdout.includes(SECRET), "a path, not the secret");
  rmSync(dir, { recursive: true, force: true });
});

test("a provider that fails stops the run, and the command never happens", { skip: false }, () => {
  // No sandbox needed: it fails before the spawn. That is the claim — "nothing
  // is substituted for a key that did not resolve" is worth nothing if the
  // child ran anyway, and the observable proof is a file that is not there.
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\ncommand = ["false", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkeys = ["T=p://nope"]\n`);
  const r = runIn(dir, "dev", "touch src/the-child-ran.txt");
  assert.notEqual(r.status, 0, "the run reported success on a key that never resolved");
  assert.ok(!existsSync(join(dir, "src", "the-child-ran.txt")), "the child ran without its credential");
  rmSync(dir, { recursive: true, force: true });
});

test("a role cannot rewrite the script its own provider runs, even inside its territory", { skip }, () => {
  // The escalation this closes: the parent executes the provider command,
  // unsandboxed. A role that could rewrite that file would decide what runs
  // outside the box — which is not a wider boundary, it is no boundary, and it
  // arrives disguised as an ordinary file in somebody's territory.
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys.providers.p]\ncommand = ["./bin/open.sh", "{ref}"]\nmode = "env"\n\n` +
    `[roles.dev]\nwrites = ["bin/**"]\nkeys = ["T=p://${SECRET}"]\n`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "open.sh"), `#!/bin/sh\nprintf %s ${SECRET}\n`, { mode: 0o755 });

  // The premise: bin/ really is this role's, or the refusal below proves nothing.
  assert.equal(runIn(dir, "dev", "echo x > bin/sibling.txt").status, 0);
  // The point: the one file in it that the parent executes is not.
  assert.notEqual(runIn(dir, "dev", "echo tampered > bin/open.sh").status, 0);
  assert.ok(readFileSync(join(dir, "bin", "open.sh"), "utf8").includes(SECRET),
    "the provider script was rewritten from inside the sandbox");
  rmSync(dir, { recursive: true, force: true });
});

test("file:// hands over the value and still refuses the file, through the real kernel", { skip }, () => {
  // The property that makes this worth having over `keys = ["all.env"]`: a
  // file grant is a file grant, so that form gives the role every variable in
  // it and lets it read them. This gives one value and no read at all.
  const dir = refRepo(
    `[network]\nallow = []\n\n[keys]\ndir = [".secrets"]\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nkey_mode = "env"\n` +
    `keys = ["MINE=file://.secrets/all.env#MINE"]\n`);
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  writeFileSync(join(dir, ".secrets", "all.env"), `MINE=${SECRET}\nNOT_MINE=otro-valor-distinto\n`);

  const r = runIn(dir, "dev", 'printf "len=%s other=%s" "${#MINE}" "${NOT_MINE:-none}"');
  assert.match(r.stdout, new RegExp(`len=${SECRET.length}\\b`));
  assert.match(r.stdout, /other=none/, "the role received a variable it was not given");
  assert.notEqual(runIn(dir, "dev", "cat .secrets/all.env").status, 0, "the role could read the file");
  rmSync(dir, { recursive: true, force: true });
});
