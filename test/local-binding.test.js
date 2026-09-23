/**
 * `local_binding`: a role may listen on a local port — a dev server, the
 * backend an end-to-end test drives. Off unless the role says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { inspect } from "../src/inspect.js";
import { renderReport } from "../src/render.js";
import { resolveSrt } from "../src/commands/run.js";
import { serve } from "../src/serve.js";
import { record, pending } from "../src/requests.js";
import { readFileSync } from "node:fs";

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
  if (process.platform === "darwin")
    assert.notEqual(as("docs"), 0, "a role without the key could listen");
  else
    // Linux: the runtime drops the network namespace, so every role has a
    // private loopback and serving inside it reaches nobody else. Measured:
    // Debian 12, bwrap 0.8.0 — both roles serve, neither reaches the host.
    assert.equal(as("docs"), 0, "a private loopback should work without the key");
});

test("check warns about local_binding and trustd only where they mean something", () => {
  const cfg = loadConfig(join(repoWith(TWO + 'trustd = true\n'), "seisin.toml"));
  const kinds = inspect(cfg).warnings.map((w) => w.kind);
  const mac = process.platform === "darwin";
  assert.equal(kinds.includes("local-binding-reaches-localhost"), mac);
  assert.equal(kinds.includes("trustd-open"), mac);
});

test("check says what local_binding really opens", { skip: process.platform !== "darwin" && "macOS only: on Linux every role has a private loopback" }, () => {
  const w = inspect(loadConfig(join(repoWith(TWO), "seisin.toml"))).warnings
    .filter((x) => x.kind === "local-binding-reaches-localhost");
  assert.equal(w.length, 1, "one warning, for the role that has it");
  assert.match(w[0].headline, /e2e: .*every port on localhost/);
});

test("a role with local_binding cannot read the console's token nor approve its own request", { skip: (skip || process.platform !== "darwin") && "macOS: only there does local_binding reach localhost" }, async (t) => {
  // La reproducción de la revisión del 2026-09-22, como prueba: el rol llega a
  // la consola (local_binding abre localhost:*), pero el token ya no viaja en
  // ninguna respuesta, así que ni lo lee ni puede aprobar.
  const dir = repoWith(TWO.replace('[roles.docs]\nwrites = ["docs/**"]', '[roles.docs]\nwrites = ["docs/**", "secret/**"]'));
  record(join(dir, ".seisin", "requests.jsonl"),
    { role: "e2e", action: "write", target: "secret/x.txt", owners: ["docs"] });
  const server = await serve(join(dir, "seisin.toml"), 0);
  t.after(() => server.close());
  const port = server.address().port;
  const steal =
    `P=$(curl -s -m 5 http://127.0.0.1:${port}/); ` +
    `echo "page:$(echo "$P" | grep -c ${server.seisinToken})"; ` +
    `T=$(echo "$P" | sed -n 's/.*SEISIN_TOKEN="\\([a-f0-9]*\\)".*/\\1/p'); ` +
    `echo "state:$(curl -s -m 5 -o /dev/null -w %{http_code} http://127.0.0.1:${port}/api/state)"; ` +
    `echo "decide:$(curl -s -m 5 -o /dev/null -w %{http_code} -X POST -H "x-seisin-token: $T" ` +
    `-d '{"number":1,"decision":"granted"}' http://127.0.0.1:${port}/api/decide)"`;
  const out = await new Promise((ok) => {
    const { spawn } = require_("node:child_process");
    const p = spawn(process.execPath, [CLI, "run", "e2e", "--", "sh", "-c", steal], { cwd: dir });
    let s = ""; p.stdout.on("data", (d) => (s += d)); p.on("close", () => ok(s));
  });
  assert.match(out, /page:0/, "the page carried the token");
  assert.match(out, /state:403/, "/api/state answered the role without a token");
  assert.match(out, /decide:403/, "the role approved its own request");
  assert.ok(!loadConfig(join(dir, "seisin.toml")).roles.e2e.writes.includes("secret/**"), "the role granted itself secret/**");
  assert.equal(pending(join(dir, ".seisin", "requests.jsonl")).length, 1, "the request was settled");
});
