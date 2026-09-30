/**
 * Control files from the console: `control_files` per role and `[protect]
 * instructions`, edited as text under the policy's lock, previewed before
 * they are saved, and out of reach of the MCP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { scratch } from "./_tmp.js";

import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt.js";
import { applyControlFiles, applyProtect, planEdit } from "../src/controls.js";
import { record, requestsPath, pending } from "../src/requests.js";

const POLICY =
  "# The team's policy. Comments are part of it.\n" +
  '[keys]\ndir = ".secrets"\n\n' +
  "# the web half\n" +
  '[roles.frontend]  # owns the UI\nwrites = [\n  "src/web/**",  # everything under web\n]\nkeys   = []\n\n' +
  "# the api half\n" +
  '[roles.backend]\nwrites = ["src/api/**"]\nkeys   = []\ncontrol_files = ["ide"]   # launch configs\n';

function repo() {
  const box = scratch("seisin-controls-");
  writeFileSync(join(box, "seisin.toml"), POLICY);
  // A project with editor settings in each territory: a literal deny on every
  // platform (on Linux only what exists is denied).
  for (const d of ["src/web/.vscode", "src/api/.vscode", ".seisin"]) mkdirSync(join(box, d), { recursive: true });
  writeFileSync(join(box, "src/web/CLAUDE.md"), "# notes\n");
  return box;
}

const denies = (box, role) => settingsFor(loadConfig(join(box, "seisin.toml")), role).filesystem.denyWrite;
const changedLines = (a, b) => {
  const x = a.split("\n"), y = b.split("\n");
  return { removed: x.filter((l) => !y.includes(l)), added: y.filter((l) => !x.includes(l)) };
};

/* ── the text edit ─────────────────────────────────────────────────────── */

test("a toggle writes exactly control_files in that role's section, nothing else", () => {
  const { toml, changed } = applyControlFiles(POLICY, "frontend", ["ide"]);
  assert.ok(changed);
  const d = changedLines(POLICY, toml);
  assert.deepEqual(d.removed, [], "no line was removed or rewritten");
  assert.equal(d.added.length, 1);
  assert.match(d.added[0], /^control_files = \["ide"\]   # set in the console \d{4}-\d{2}-\d{2}$/);
  // Inside frontend's block — after its last key, before the comment that heads backend.
  const lines = toml.split("\n");
  const at = lines.indexOf(d.added[0]);
  assert.equal(lines[at - 1], "keys   = []");
  assert.equal(lines[at + 2], "# the api half");
  // Everything from backend's comment on is byte-identical.
  assert.equal(toml.slice(toml.indexOf("# the api half")), POLICY.slice(POLICY.indexOf("# the api half")));
  const cfg = loadConfig("/x/seisin.toml", toml);
  assert.deepEqual(cfg.roles.frontend.controlFiles, ["ide"]);
  assert.deepEqual(cfg.roles.backend.controlFiles, ["ide"]);
});

test("replacing an existing list keeps the rest of the file byte for byte", () => {
  const { toml } = applyControlFiles(POLICY, "backend", ["instructions", "ide"], "keeps the docs current");
  const d = changedLines(POLICY, toml);
  assert.deepEqual(d.removed, ['control_files = ["ide"]   # launch configs']);
  assert.equal(d.added.length, 1);
  assert.match(d.added[0], /^control_files = \["ide", "instructions"\]   # set in the console .* · «keeps the docs current»$/);
  assert.equal(toml.slice(0, toml.indexOf("[roles.backend]")), POLICY.slice(0, POLICY.indexOf("[roles.backend]")));
});

test("removing the last family leaves an explicit empty list; a role that never had one is left alone", () => {
  const { toml, changed } = applyControlFiles(POLICY, "backend", []);
  assert.ok(changed);
  assert.match(toml, /^control_files = \[\]   # set in the console/m);
  assert.deepEqual(loadConfig("/x/seisin.toml", toml).roles.backend.controlFiles, []);
  assert.deepEqual(applyControlFiles(POLICY, "frontend", []), { toml: POLICY, changed: false });
});

test("the same value again is no edit, and does not move the stamp", () => {
  assert.equal(applyControlFiles(POLICY, "backend", ["ide"]).changed, false);
  const once = applyControlFiles(POLICY, "frontend", ["ide", "instructions"]).toml;
  assert.equal(applyControlFiles(once, "frontend", ["instructions", "ide"]).changed, false);
});

test("unknown families are refused, the never-offered ones by name", () => {
  for (const f of [".claude", "git-hooks", ".mcp.json", ".envrc", "IDE"])
    assert.throws(() => applyControlFiles(POLICY, "frontend", [f]), (e) => e.status === 400 && /never handed to a role/.test(e.message));
  assert.throws(() => applyControlFiles(POLICY, "frontend", "ide"), (e) => e.status === 400);
  assert.throws(() => applyControlFiles(POLICY, "nobody", ["ide"]), (e) => e.status === 400);
});

test("[protect] is created above the first role when turned on, and edited in place after", () => {
  assert.deepEqual(applyProtect(POLICY, false), { toml: POLICY, changed: false }, "off is the default: no table for it");
  const on = applyProtect(POLICY, true).toml;
  const d = changedLines(POLICY, on);
  assert.deepEqual(d.removed, []);
  assert.ok(on.indexOf("[protect]") < on.indexOf("# the web half"), "above the role, and above the comment that heads it");
  assert.ok(on.indexOf("[protect]") > on.indexOf('dir = ".secrets"'));
  assert.equal(loadConfig("/x/seisin.toml", on).protect.instructions, true);
  const off = applyProtect(on, false).toml;
  assert.equal(off.match(/\[protect\]/g).length, 1);
  assert.match(off, /^instructions = false   # set in the console/m);
  assert.equal(loadConfig("/x/seisin.toml", off).protect.instructions, false);
  assert.equal(applyProtect(off, false).changed, false);
  assert.throws(() => applyProtect(POLICY, "yes"), (e) => e.status === 400);
});

test("the plan loads the edited text against the real root, and the next settingsFor reflects it", () => {
  const box = repo();
  const cfg = loadConfig(join(box, "seisin.toml"));
  const vscode = join(box, "src/web/.vscode");
  assert.ok(denies(box, "frontend").includes(vscode));
  const plan = planEdit(cfg, POLICY, { kind: "role", role: "frontend", families: ["ide"] });
  assert.deepEqual(plan.diff.map((d) => d.role), ["frontend"]);
  assert.ok(plan.diff[0].removed.some((e) => e.path === vscode && /VS Code/.test(e.why)));
  assert.deepEqual(plan.diff[0].added, []);
  assert.deepEqual(plan.access.ide, ["frontend", "backend"]);
  assert.equal(plan.access.instructions, null, "instructions are not protected: every role writes them");
  writeFileSync(join(box, "seisin.toml"), plan.toml);
  assert.ok(!denies(box, "frontend").includes(vscode));
  assert.ok(denies(box, "backend").every((p) => p !== join(box, "src/api/.vscode")));
});

/* ── the endpoint ──────────────────────────────────────────────────────── */

async function console_(t, opts) {
  const { serve } = await import("../src/serve.js");
  const box = repo();
  const server = await serve(join(box, "seisin.toml"), 0, opts);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { "x-seisin-token": server.seisinToken, "content-type": "application/json" };
  const post = (body, headers = auth) =>
    fetch(base + "/api/control-files", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const state = async () => (await fetch(base + "/api/state", { headers: auth })).json();
  return { box, base, auth, post, state, policy: join(box, "seisin.toml") };
}

test("a dry run returns the diff and who would have access, and writes nothing", async (t) => {
  const { box, post, policy } = await console_(t);
  const r = await post({ role: "frontend", families: ["ide"], dryRun: true });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.dryRun, true);
  assert.equal(out.changed, true);
  assert.equal(out.toml, undefined, "the text itself is not handed out");
  assert.ok(out.diff[0].removed.some((e) => e.path === join(box, "src/web/.vscode")));
  assert.deepEqual(out.controlFiles, ["ide"]);
  assert.equal(readFileSync(policy, "utf8"), POLICY);
  const p = await (await post({ protect: true, dryRun: true })).json();
  assert.ok(p.diff.some((d) => d.role === "frontend" && d.added.some((e) => e.path === join(box, "src/web/CLAUDE.md"))),
    "protecting instructions adds the role's CLAUDE.md to its denies");
  assert.deepEqual(p.access.instructions, []);
  assert.equal(readFileSync(policy, "utf8"), POLICY);
});

test("saving writes the policy, the state shows it, and the next profile follows", async (t) => {
  const { box, post, state, policy } = await console_(t);
  const before = await state();
  assert.deepEqual(before.roles.find((r) => r.name === "frontend").controlFiles, []);
  assert.equal(before.protect.instructions, false);
  const r = await post({ role: "frontend", families: ["ide"], base: before.base, reason: "keeps launch configs" });
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await r.json()).dryRun, false);
  assert.match(readFileSync(policy, "utf8"), /control_files = \["ide"\]   # set in the console .* · «keeps launch configs»/);
  assert.ok(!denies(box, "frontend").includes(join(box, "src/web/.vscode")));
  const after = await state();
  assert.deepEqual(after.roles.find((x) => x.name === "frontend").controlFiles, ["ide"]);
  assert.notEqual(after.base, before.base);
  // Protection on, then instructions handed to frontend.
  assert.equal((await post({ protect: true })).status, 200);
  assert.ok(denies(box, "frontend").includes(join(box, "src/web/CLAUDE.md")));
  assert.equal((await post({ role: "frontend", families: ["ide", "instructions"] })).status, 200);
  assert.ok(!denies(box, "frontend").includes(join(box, "src/web/CLAUDE.md")));
  assert.equal((await state()).protect.instructions, true);
});

test("the token is required, and the Host must be the server's", async (t) => {
  const { base, post, policy } = await console_(t);
  const r = await post({ role: "frontend", families: ["ide"] }, { "content-type": "application/json" });
  assert.equal(r.status, 403);
  const wrong = await post({ role: "frontend", families: ["ide"] }, { "content-type": "application/json", "x-seisin-token": "0".repeat(48) });
  assert.equal(wrong.status, 403);
  const { request } = await import("node:http");
  const status = await new Promise((ok, fail) => {
    const u = new URL(base);
    const q = request({ host: u.hostname, port: u.port, path: "/api/control-files", method: "POST", headers: { host: "evil.example" } },
      (res) => { res.resume(); ok(res.statusCode); });
    q.on("error", fail);
    q.end("{}");
  });
  assert.equal(status, 403);
  assert.equal(readFileSync(policy, "utf8"), POLICY);
});

test("bad edits are 400s, a stale preview a 409, an oversized body a 413", async (t) => {
  const { post, policy, state } = await console_(t);
  const cases = [
    { role: "nobody", families: ["ide"] },
    { role: "__proto__", families: ["ide"] },
    { role: "frontend", families: [".claude"] },
    { role: "frontend", families: ["hooks"] },
    { role: "frontend", families: "ide" },
    { role: "frontend", families: ["ide"], protect: true },
    {},
    { protect: "yes" },
    { role: "frontend", families: ["ide"], dryRun: "true" },
  ];
  for (const c of cases) assert.equal((await post(c)).status, 400, JSON.stringify(c));
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ role: "frontend", families: ["ide"], reason: "x".repeat(5000) })).status, 413);
  const { base } = await state();
  writeFileSync(policy, POLICY + "\n# edited in an editor\n");
  assert.equal((await post({ role: "frontend", families: ["ide"], base })).status, 409);
  assert.equal(readFileSync(policy, "utf8"), POLICY + "\n# edited in an editor\n");
});

test("the lock held by another edit is a 503, and nothing is written", async (t) => {
  const { box, post, policy } = await console_(t, { lockWaitMs: 150 });
  const lock = join(box, ".seisin", "policy.lock");
  writeFileSync(lock, `${process.pid} holder\n`);
  try {
    const r = await post({ role: "frontend", families: ["ide"] });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /in progress/);
  } finally { unlinkSync(lock); }
  assert.equal(readFileSync(policy, "utf8"), POLICY);
  assert.equal((await post({ role: "frontend", families: ["ide"] })).status, 200);
});

test("a grant from another process and toggles from the console both survive", async (t) => {
  const { box, post, policy } = await console_(t);
  const N = 8;
  const reqs = new URL("../src/requests.js", import.meta.url).href;
  const conf = new URL("../src/config.js", import.meta.url).href;
  // A terminal granting eight paths to backend, one lock at a time, while the
  // console flips frontend's families as fast as it answers.
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { editPolicy, applyGrant } from ${JSON.stringify(reqs)};
     import { loadConfig } from ${JSON.stringify(conf)};
     const cfg = loadConfig(${JSON.stringify(policy)});
     for (let i = 0; i < ${N}; i++) {
       editPolicy(cfg, (t) => applyGrant(t, { role: "backend", action: "write", grant: "gen/" + i + "/**", times: 1 }));
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
     }`]);
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const done = new Promise((ok) => child.once("close", ok));
  let last = [];
  for (let i = 0; i < N * 2; i++) {
    last = i % 2 ? ["ide"] : ["ide", "instructions"];
    const r = await post({ role: "frontend", families: last });
    assert.equal(r.status, 200, await r.clone().text());
  }
  assert.equal(await done, 0, err);
  const cfg = loadConfig(policy);
  for (let i = 0; i < N; i++) assert.ok(cfg.roles.backend.writes.includes(`gen/${i}/**`), `grant ${i} lost`);
  assert.deepEqual(cfg.roles.frontend.controlFiles, last);
  assert.ok(readFileSync(policy, "utf8").includes("# the web half"), "comments survive both writers");
  void box;
});

/* ── the MCP server stays read-only ────────────────────────────────────── */

test("no MCP tool can change control_files or [protect]", async () => {
  const { TOOLS, HANDLERS } = await import("../src/mcp.js");
  const box = repo();
  record(requestsPath(box), { role: "frontend", action: "write", target: "src/web/.vscode/tasks.json", owners: [] });
  const cwd = process.cwd();
  process.chdir(box);
  try {
    const attempts = [
      {}, { role: "frontend" }, { role: "frontend", families: ["ide"], control_files: ["ide"] },
      { protect: true, instructions: true }, { role: "frontend", action: "write", target: "src/web/.vscode/tasks.json" },
      { key: pending(requestsPath(box))[0].key, decision: "granted" },
    ];
    for (const tool of TOOLS)
      for (const args of attempts) {
        try { HANDLERS[tool.name](args); } catch {}
      }
  } finally { process.chdir(cwd); }
  assert.equal(readFileSync(join(box, "seisin.toml"), "utf8"), POLICY);
  // And nothing in it could: no tool is about control files, and the module
  // that edits them — or the policy at all — is not imported.
  assert.ok(!TOOLS.some((t) => /control|protect/i.test(t.name)));
  const src = readFileSync(new URL("../src/mcp.js", import.meta.url), "utf8");
  assert.ok(!/controls\.js|editPolicy|applyGrant|writeFileSync|renameSync/.test(src));
});
