/**
 * `local_binding`: a role may listen on a local port — a dev server, the
 * backend an end-to-end test drives. Off unless the role says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { resolveSrt } from "../src/commands/run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const BOX = join(HERE, ".sandbox-box");

function repoWith(toml) {
  mkdirSync(BOX, { recursive: true });
  const dir = mkdtempSync(join(BOX, "bind-"));
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

const TWO =
  '[network]\nallow = []\n\n' +
  '[roles.e2e]\nwrites = ["app/**"]\nlocal_binding = true\n\n' +
  '[roles.docs]\nwrites = ["docs/**"]\n';

test("absent means no listening, as before", () => {
  const cfg = loadConfig(join(repoWith(TWO), "seisin.toml"));
  assert.equal(settingsFor(cfg, "docs").network.allowLocalBinding, false);
  assert.equal(cfg.roles.docs.localBinding, false);
});

test("true opens binding for that role only", () => {
  const cfg = loadConfig(join(repoWith(TWO), "seisin.toml"));
  assert.equal(settingsFor(cfg, "e2e").network.allowLocalBinding, true);
  assert.equal(settingsFor(cfg, "docs").network.allowLocalBinding, false);
});

test("it is a boolean, and anything else refuses to load", () => {
  const dir = repoWith('[roles.e2e]\nwrites = ["app/**"]\nlocal_binding = "yes"\n');
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /local_binding must be true or false/);
});

test("check shows it and does not call it an unknown key", () => {
  const report = inspect(loadConfig(join(repoWith(TWO), "seisin.toml")));
  assert.ok(!report.warnings.some((w) => w.kind === "unknown-role-key"));
  assert.match(renderReport(report), /listen.*local_binding/);
});

const skip = resolveSrt() !== null ? false : "sandbox runtime not installed";

// A server that answers once and exits, and a client in the same box. Both
// halves matter: an e2e test that can listen but cannot reach its own server
// is as broken as one that cannot listen.
const SERVE_AND_ASK =
  `node -e 'const h=require("http");const s=h.createServer((q,r)=>{r.end("ok");s.close()});` +
  `s.listen(0,"127.0.0.1",()=>{h.get("http://127.0.0.1:"+s.address().port,(r)=>{let b="";` +
  `r.on("data",(d)=>b+=d);r.on("end",()=>process.exit(b==="ok"?0:3))}).on("error",()=>process.exit(4))});` +
  `s.on("error",()=>process.exit(2))'`;

test("the real sandbox lets that role serve and reach a local port, and refuses the other", { skip }, () => {
  const dir = repoWith(TWO);
  const as = (role) => spawnSync(process.execPath, [CLI, "run", role, "--", "sh", "-c", SERVE_AND_ASK],
    { cwd: dir, encoding: "utf8" }).status;
  assert.equal(as("e2e"), 0, "local_binding = true and still no server");
  assert.notEqual(as("docs"), 0, "a role without the key could listen");
});

test("check says what local_binding really opens", () => {
  const w = inspect(loadConfig(join(repoWith(TWO), "seisin.toml"))).warnings
    .filter((x) => x.kind === "local-binding-reaches-localhost");
  assert.equal(w.length, 1, "one warning, for the role that has it");
  assert.match(w[0].headline, /e2e: .*every port on localhost/);
});
