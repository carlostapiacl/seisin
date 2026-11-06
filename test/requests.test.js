/**
 * The queue of requests: what enters it, what a grant writes, what settles it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, loadConfig } from "../src/config.js";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scratch, CLI } from "./_tmp.js";
import { decide } from "../src/hook.js";
import { record, settle, pending, applyGrant, grantFor } from "../src/requests.js";
import { decline as declineCmd } from "../src/commands/requests.js";
import { requestsPath } from "../src/requests.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

test("many denials in one directory are one request, not many", () => {
  // An agent denied on a.ts and then on b.ts does not ask two questions, and a
  // queue that keeps saying the same thing becomes a queue nobody reads.
  const box = scratch("seisin-req-");
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
  // Append-only: a decision that can be rewritten is not evidence.
  const box = scratch("seisin-req-");
  const f = join(box, "requests.jsonl");
  record(f, { role: "qa", action: "write", target: "docs/x.md", owners: [] });
  const [req] = pending(f);
  settle(f, req.key, "declined", "not theirs");
  const open = pending(f);
  const all = pending(f, { includeSettled: true });
  const lines = readFileSync(f, "utf8").trim().split("\n").length;
  rmSync(box, { recursive: true, force: true });
  assert.equal(open.length, 0);
  assert.equal(all[0].state, "declined");
  assert.equal(all[0].reason, "not theirs");
  assert.equal(lines, 2);
});

test("a grant lands in the right role, with its provenance", () => {
  const toml = '[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\n';
  const req = { role: "frontend", action: "write", grant: "src/api/**", times: 3 };
  const { toml: after, changed } = applyGrant(toml, req, "takes over checkout");
  assert.ok(changed);
  assert.match(after, /"src\/web\/\*\*",/);
  assert.match(after, /"src\/api\/\*\*"\s+# granted .* asked 3× · «takes over checkout»/);
  // and it did not touch the other role
  assert.match(after, /\[roles\.backend\]\nwrites = \["src\/api\/\*\*"\]/);
});

test("SEC-02 a grant adds exactly the granted item — not what a comment or a past reason quotes", () => {
  // Before: the list was rebuilt from EVERY quoted string in the block,
  // comments included. Granting docs/** also granted the "src/**" in a comment,
  // and the reason given for the previous grant (quoted in its comment) became a
  // path in the next one.
  const toml = '[roles.frontend]\nwrites = [\n  "src/web/**",   # was "src/**" until the split\n]\n\n[roles.backend]\nwrites = ["src/api/**"]\n';
  let { toml: t } = applyGrant(toml, { role: "frontend", action: "write", grant: "docs/**", times: 1 }, "**");
  ({ toml: t } = applyGrant(t, { role: "frontend", action: "write", grant: "lib/**", times: 2 }, "ok"));
  assert.deepEqual(parseToml(t).roles.frontend.writes, ["src/web/**", "docs/**", "lib/**"]);
  // the earlier provenance is still there, and so is the original comment
  assert.match(t, /# was "src\/\*\*" until the split/);
  assert.match(t, /"docs\/\*\*",?\s+# granted .* asked 1× · «\*\*»/);
  assert.deepEqual(parseToml(t).roles.backend.writes, ["src/api/**"]);
});

test("a grant into a one-line or empty list keeps the file loadable", () => {
  for (const [list, want] of [['[]', ["x/**"]], ['["a/**"]', ["a/**", "x/**"]], ['["a/**", "b/**"]  # two', ["a/**", "b/**", "x/**"]]]) {
    const { toml } = applyGrant(`[roles.r]\nwrites = ${list}\n`, { role: "r", action: "write", grant: "x/**", times: 1 }, "");
    assert.deepEqual(parseToml(toml).roles.r.writes, want, list);
  }
});

test("granting something a role already has changes nothing", () => {
  const toml = '[roles.a]\nwrites = ["x/**"]\n';
  const { changed } = applyGrant(toml, { role: "a", action: "write", grant: "x/**", times: 1 }, "");
  assert.equal(changed, false);
});

test("a key request grants the key, not a directory glob", () => {
  // With a directory, the directory is kept. Trimming it turned a request for
  // `shared/api.txt` into a grant of `api.txt`, which settingsFor resolves
  // against the FIRST key directory — a person grants one file and a different
  // one with the same name ends up being read.
  assert.equal(grantFor({ action: "read", target: ".secrets/netlify.txt" }), ".secrets/netlify.txt");
  assert.equal(grantFor({ action: "read", target: "shared/api.txt" }), "shared/api.txt");
  assert.equal(grantFor({ action: "read", target: "netlify.txt" }), "netlify.txt");
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

test("a grant lands in the role it was granted for, or nowhere", () => {
  // The bug: the search for the field was not bounded to the role's section,
  // so granting to a role with no `writes` wrote the grant into the NEXT role
  // — with a comment saying who it was for.
  const noWrites = '[roles.frontend]\nkeys = []\n\n[roles.backend]\nwrites = ["src/api/**"]\nkeys   = []\n';
  assert.throws(
    () => applyGrant(noWrites, { role: "frontend", action: "write", grant: "src/X/**", times: 2 }, "para frontend"),
    /has no writes list/);

  const good = '[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n\n[roles.backend]\nwrites = ["src/api/**"]\n';
  const { toml } = applyGrant(good, { role: "frontend", action: "write", grant: "src/X/**", times: 2 }, "ok");
  const front = toml.slice(toml.indexOf("[roles.frontend]"), toml.indexOf("[roles.backend]"));
  assert.match(front, /src\/X/);
  assert.ok(!toml.slice(toml.indexOf("[roles.backend]")).includes("src/X"));
});

test("a person's reason cannot become configuration", () => {
  // A reason is free text a person types, and a person can be talked into
  // pasting something. A newline would close the comment and whatever follows
  // would be parsed as TOML.
  const base = '[roles.frontend]\nwrites = ["src/web/**"]\nkeys   = []\n';
  const poison = 'ok\n\n[roles.frontend]\nwrites = ["**"]\nkeys = []\n#';
  const { toml } = applyGrant(base, { role: "frontend", action: "write", grant: "src/api/**", times: 1 }, poison);
  assert.equal(toml.split("\n").filter((l) => l.trim() === "[roles.frontend]").length, 1);
  assert.deepEqual(parseToml(toml).roles.frontend.writes, ["src/web/**", "src/api/**"]);
});

test("a grant the config cannot represent is refused, not written", () => {
  // The subset has no escapes, so a value with a quote or a newline cannot be
  // written. The strict parser would refuse the result — but leaving someone
  // with a config that no longer loads, right after they granted something, is
  // its own way of being broken.
  const base = '[roles.a]\nwrites = ["src/**"]\nkeys   = []\n';
  assert.throws(() => applyGrant(base, { role: "a", action: "write", grant: 'src/x"/**', times: 1 }, ""),
    /no way to represent a quote/);
  assert.ok(applyGrant(base, { role: "a", action: "write", grant: "src/ok/**", times: 1 }, "").changed);
});

test("a forged queue entry cannot crash the queue", () => {
  // Reading the queue cannot be the thing that fails: `run` prints it on exit
  // and the console polls it, so a crash here takes down the half a person
  // uses. A line with no `target` arrived from inside the sandbox and did it.
  const box = scratch("seisin-q-");
  const f = join(box, "requests.jsonl");
  writeFileSync(f, JSON.stringify({ kind: "asked", key: "a:write:b", role: "a", action: "write" }) + "\n");
  const q = pending(f);
  rmSync(box, { recursive: true, force: true });
  assert.equal(q.length, 1);
  assert.equal(q[0].grant, "");
});

test("a request the role stopped asking for is marked, not moved and not settled", async () => {
  const { markStale, STALE_RUNS } = await import("../src/requests.js");
  const q = () => [
    { key: "a", role: "qa", last: "2026-09-23T10:00:00.000Z" },
    { key: "b", role: "qa", last: "2026-09-23T13:00:00.000Z" },
    { key: "c", role: "dev", last: "2026-09-23T10:00:00.000Z" },
  ];
  // qa: three runs after 10:00 (gaps over ten minutes), the last of them after 13:00 too.
  const log = ["10:30", "10:31", "11:30", "13:30"].map((t) => ({ role: "qa", at: `2026-09-23T${t}:00.000Z` }));
  const out = markStale(q(), log);
  assert.equal(STALE_RUNS, 3);
  assert.deepEqual(out.map((r) => r.key), ["a", "b", "c"], "order is untouched: numbers are typed against it");
  assert.deepEqual(out[0].stale, { runs: 3, since: "2026-09-23T10:00:00.000Z" });
  assert.equal(out[1].stale, undefined, "one run since is not enough");
  assert.equal(out[2].stale, undefined, "another role's runs do not count");
  assert.ok(out.every((r) => r.state === undefined), "nothing is decided");
});

test("SEC-03 the CLI takes an id exactly — a prefix never selects another request", () => {
  // Before: pick() accepted prefixes. With `lib` already settled, typing its
  // exact id picked `lib-x`, a new request whose id only starts the same way —
  // and ids are built from paths an agent chooses.
  const box = scratch("seisin-pick-");
  writeFileSync(join(box, "seisin.toml"), '[roles.frontend]\nwrites = ["src/**"]\nkeys = []\n');
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "frontend", action: "write", target: "lib-x/a.ts", owners: [] });
  const cfg = loadConfig(join(box, "seisin.toml"));
  const settled = "frontend:write:lib";
  assert.throws(() => declineCmd(cfg, [settled]), /no pending request has the id/);
  assert.equal(pending(q).length, 1, "the other request was touched");
  declineCmd(cfg, [pending(q)[0].key]);
  assert.equal(pending(q).length, 0);
});

test("SEC-07 two concurrent grants both land — neither is lost", async () => {
  const { spawn } = await import("node:child_process");
  const box = scratch("seisin-race-");
  writeFileSync(join(box, "seisin.toml"),
    '[roles.a]\nwrites = ["a/**"]\nkeys = []\n\n[roles.b]\nwrites = ["b/**"]\nkeys = []\n');
  const q = join(box, ".seisin", "requests.jsonl");
  record(q, { role: "a", action: "write", target: "xone/f.ts", owners: [] });
  record(q, { role: "b", action: "write", target: "xtwo/f.ts", owners: [] });
  const [r1, r2] = pending(q);
  const run = (key) => new Promise((res) => {
    const c = spawn(process.execPath, [CLI, "grant", key], { cwd: box, encoding: "utf8" });
    c.on("exit", (code) => res(code));
  });
  await Promise.all([run(r1.key), run(r2.key)]);
  const toml = readFileSync(join(box, "seisin.toml"), "utf8");
  assert.match(toml, /xone\/\*\*/, "role a's grant was lost");
  assert.match(toml, /xtwo\/\*\*/, "role b's grant was lost");
  assert.equal(pending(q).length, 0, "both requests should be settled");
});

/* ── the queue, reduced once per change ────────────────────────────────── */

test("pending() is cached per file state, and one caller's marks do not leak into the next", () => {
  const dir = scratch("seisin-audit-q-");
  const file = requestsPath(dir);
  record(file, { role: "web", action: "write", target: "api/x.ts", owners: ["api"] });
  const a = pending(file);
  a[0].stale = { runs: 9 };
  assert.equal(pending(file)[0].stale, undefined);
  record(file, { role: "web", action: "write", target: "api/y.ts", owners: ["api"] });
  assert.equal(pending(file)[0].times, 2, "a new line is seen");
  settle(file, pending(file)[0].key, "declined");
  assert.equal(pending(file).length, 0);
  assert.equal(pending(file, { includeSettled: true })[0].state, "declined");
});
