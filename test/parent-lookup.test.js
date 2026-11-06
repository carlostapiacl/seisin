/**
 * What the parent runs is found where no role can write, and what a command
 * names is closed to every role. Each test leaves a marker if the program ran.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { boxed, CLI, sandboxSkip } from "./_tmp.js";
import { resolveTartaros } from "../src/sandboxes/tartaros.js";
import { resolveSrt } from "../src/sandboxes/srt.js";
import { loadConfig } from "../src/config.js";
import { sandboxesOf, weigh } from "../src/sandboxes/index.js";
import { trustedPath } from "../src/surface.js";

const skip = sandboxSkip();

function fake(file, marker, { exit = 1 } = {}) {
  writeFileSync(file, `#!/bin/sh\necho "$0 $1" >> "${marker}"\nexit ${exit}\n`);
  chmodSync(file, 0o755);
}

function repo(toml) {
  const dir = boxed("lookup-");
  const marker = join(boxed("lookup-mark-"), "ran");
  mkdirSync(join(dir, "tools/bin"), { recursive: true });
  mkdirSync(join(dir, "app"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "seisin.toml"), toml);
  return { dir, marker };
}

const seisin = (args, cwd, env = {}) => spawnSync(process.execPath, [CLI, ...args],
  { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const withBin = (dir) => ({ PATH: `${join(dir, "tools/bin")}${delimiter}${process.env.PATH}` });

const DECLARED = `
[sandbox]
provider = ["mybox"]
[sandbox.providers.mybox]
command = ["mybox", "run", "--policy", "{policy}", "--"]
check = ["mybox", "check", "--policy", "{policy}"]
[roles.dev]
writes = ["tools/**", "app/**"]
`;

test("check does not start a declared sandbox found only where a role can write", () => {
  const { dir, marker } = repo(DECLARED);
  fake(join(dir, "tools/bin/mybox"), marker);
  const r = seisin(["check"], dir, withBin(dir));
  assert.equal(existsSync(marker), false, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /a role can write/);
});

test("run does not start it either, and says why", () => {
  const { dir, marker } = repo(DECLARED);
  fake(join(dir, "tools/bin/mybox"), marker);
  const r = seisin(["run", "dev", "--agent", "none", "--", "/usr/bin/true"], dir, withBin(dir));
  assert.equal(existsSync(marker), false, r.stdout + r.stderr);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /a role can write/);
});

test("check --json asks no version of a program it would not run", () => {
  const { dir, marker } = repo(DECLARED);
  fake(join(dir, "tools/bin/mybox"), marker, { exit: 0 });
  seisin(["check", "--json"], dir, withBin(dir));
  assert.equal(existsSync(marker), false);
});

test("one a role can write, placed first on PATH, does not hide the real one", () => {
  const { dir, marker } = repo(DECLARED);
  const real = boxed("lookup-real-");
  const realMark = join(boxed("lookup-mark-"), "real");
  fake(join(dir, "tools/bin/mybox"), marker);
  fake(join(real, "mybox"), realMark, { exit: 0 });
  seisin(["check"], dir, { PATH: `${join(dir, "tools/bin")}${delimiter}${real}${delimiter}${process.env.PATH}` });
  assert.equal(existsSync(marker), false);
  assert.match(readFileSync(realMark, "utf8"), /check/);
});

test("a declared sandbox outside every territory is found and asked as before", () => {
  const { dir } = repo(DECLARED);
  const real = boxed("lookup-real-");
  const realMark = join(boxed("lookup-mark-"), "real");
  fake(join(real, "mybox"), realMark);
  const r = seisin(["check"], dir, { PATH: `${real}${delimiter}${process.env.PATH}` });
  assert.ok(existsSync(realMark), r.stdout + r.stderr);
});

test("once a sandbox can hold the role, the next is not asked", () => {
  const toml = DECLARED.replace('provider = ["mybox"]', 'provider = ["first", "mybox"]')
    .replace("[roles.dev]", '[sandbox.providers.first]\ncommand = ["first", "{policy}"]\ncheck = ["first", "{policy}"]\n[roles.dev]');
  const { dir } = repo(toml);
  const real = boxed("lookup-real-");
  const firstMark = join(boxed("lookup-mark-"), "first");
  const secondMark = join(boxed("lookup-mark-"), "second");
  fake(join(real, "first"), firstMark, { exit: 0 });
  fake(join(real, "mybox"), secondMark);
  seisin(["check"], dir, { PATH: `${real}${delimiter}${process.env.PATH}` });
  assert.ok(existsSync(firstMark));
  assert.equal(existsSync(secondMark), false);
});

test("a built-in sandbox with no package is not taken from a folder a role writes", () => {
  const { dir, marker } = repo('[roles.dev]\nwrites = ["tools/**", "app/**"]\n');
  for (const name of ["tartaros", "srt"]) fake(join(dir, "tools/bin", name), marker);
  const config = loadConfig(join(dir, "seisin.toml"));
  const env = { ...process.env, ...withBin(dir) };
  const path = trustedPath(config, env).join(delimiter);
  const nowhere = boxed("lookup-nopkg-");
  assert.equal(resolveTartaros({ from: nowhere, path }), resolveTartaros({ from: nowhere, path: process.env.PATH }));
  assert.equal(resolveSrt({ from: nowhere, path }), resolveSrt({ from: nowhere, path: process.env.PATH }));
  assert.equal(path.split(delimiter).includes(join(dir, "tools/bin")), false);
  for (const s of sandboxesOf(config)) {
    assert.notEqual(s.locate(), join(dir, "tools/bin", s.name));
  }
  assert.equal(existsSync(marker), false);
});

test("the package installed with seisin is still what is chosen", () => {
  const { dir } = repo('[roles.dev]\nwrites = ["app/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const tartaros = sandboxesOf(config).find((s) => s.name === "tartaros");
  if (process.platform !== "win32") assert.ok(tartaros.locate());
  assert.ok(weigh(config, {}, { locate: false }).options.length >= 1);
});

/* ── what a command names ── */

const KEYED = `
[keys.providers.mi]
command = ["/bin/sh", "tools/prov.sh", "{ref}"]
[runtime]
writes = []
[roles.dev]
writes = ["tools/**", "app/**"]
keys = ["TOKEN=mi://X"]
key_mode = "env"
`;

test("a role cannot rewrite the script a key provider runs, so the next run runs what was written", { skip }, () => {
  const { dir, marker } = repo(KEYED);
  writeFileSync(join(dir, "tools/prov.sh"), "#!/bin/sh\necho value\n");
  const script = `printf '#!/bin/sh\\necho x >> "${marker}"\\n' > tools/prov.sh && echo REWRITTEN || echo REFUSED; echo ok > tools/other && echo OTHER`;
  const r = seisin(["run", "dev", "--agent", "none", "--", "/bin/sh", "-c", script], dir);
  assert.match(r.stdout, /REFUSED/, r.stdout + r.stderr);
  assert.match(r.stdout, /OTHER/, "the rest of its territory is its own");
  seisin(["run", "dev", "--agent", "none", "--", "/usr/bin/true"], dir);
  assert.equal(existsSync(marker), false);
});

test("a role cannot rewrite what a declared sandbox names either", { skip }, () => {
  const toml = `
[sandbox]
provider = ["tartaros", "box"]
[sandbox.providers.box]
command = ["/bin/sh", "tools/box.sh", "{policy}", "--"]
[runtime]
writes = []
[roles.dev]
writes = ["tools/**", "app/**"]
`;
  const { dir } = repo(toml);
  writeFileSync(join(dir, "tools/box.sh"), "exit 1\n");
  const r = seisin(["run", "dev", "--agent", "none", "--", "/bin/sh", "-c",
    "echo x >> tools/box.sh && echo REWRITTEN || echo REFUSED"], dir);
  assert.match(r.stdout, /REFUSED/, r.stdout + r.stderr);
});

test("check says when what a provider runs sits inside a role's territory, whose imports it cannot close", () => {
  const { dir } = repo(KEYED);
  writeFileSync(join(dir, "tools/prov.sh"), "echo v\n");
  assert.match(seisin(["check"], dir).stdout, /provider runs tools\/prov\.sh, inside what dev can write/);
  const elsewhere = repo(KEYED.replace("tools/prov.sh", "/opt/prov.sh"));
  assert.doesNotMatch(seisin(["check"], elsewhere.dir).stdout, /provider runs/);
});

test("a flag or a value with a placeholder is not a file to protect", { skip }, () => {
  const toml = KEYED.replace('"/bin/sh", "tools/prov.sh", "{ref}"', '"/bin/echo", "--tools/flag", "tools/{ref}"');
  const { dir } = repo(toml);
  const r = seisin(["run", "dev", "--agent", "none", "--", "/bin/sh", "-c", "echo x > tools/X && echo OK"], dir);
  assert.match(r.stdout, /OK/, r.stdout + r.stderr);
});
