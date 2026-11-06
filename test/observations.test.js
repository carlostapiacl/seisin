/**
 * What the log says about a policy, and a policy written from what was observed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { read, generalise } from "../src/log.js";
import { renderObserved } from "../src/commands/init.js";
import { review } from "../src/review.js";

const cfg = {
  root: "/repo",
  keyDirs: [".secrets"],
  allowedDomains: ["github.com"],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: ["netlify.txt"], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: ["database.txt"], network: null },
  },
};

test("observed paths collapse to directories, not to the whole tree", () => {
  // Two files under src/api must not generalise to src/**: that hands over the
  // repo on the strength of two writes.
  assert.deepEqual(generalise(["src/api/a.ts", "src/api/b.ts", "src/api/deep/c.ts"]), ["src/api/**"]);
  assert.deepEqual(generalise(["src/api/a.ts", "docs/x.md"]).sort(), ["docs/**", "src/api/**"]);
});

test("a half-written log line is skipped, not fatal", () => {
  const box = scratch("seisin-log-");
  const f = join(box, "log.jsonl");
  writeFileSync(f, '{"role":"a","target":"x","action":"write","verdict":"denied"}\n{"role":"b",\n');
  const entries = read(f);
  rmSync(box, { recursive: true, force: true });
  assert.equal(entries.length, 1);
});

test("observation adds to the policy instead of replacing it", () => {
  // The file says "diff it, then move it", and moving it erased the territory
  // of every role that sat still during the window. A role that did nothing is
  // not a role that needs nothing: it is a role nobody watched.
  const cfg = {
    root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [],
    roles: {
      frontend: { name: "frontend", writes: ["web/**"], keys: [], network: null },
      backend: { name: "backend", writes: ["api/**"], keys: [], network: null },
    },
  };
  const { toml } = renderObserved(cfg, [
    { role: "frontend", action: "write", target: "NOTAS.md", verdict: "observed" },
    { role: "frontend", action: "write", target: "docs/guia.md", verdict: "observed" },
  ], '[roles.frontend]\nwrites = ["web/**"]\nkeys = []\n[roles.backend]\nwrites = ["api/**"]\nkeys = []\n');

  assert.match(toml, /\[roles\.backend\]/, "it erased the role that did not act");
  assert.match(toml, /writes = \["api\/\*\*"\]/, "it erased its declared territory");
  assert.match(toml, /"web\/\*\*",[\s\S]*"NOTAS\.md"[\s\S]*"docs\/\*\*"/, "it did not add what was observed to what was declared");
  assert.match(toml, /this role did nothing while observing/);
});

/** A fake log in the shape the hook writes. */
function logWith(t, entries) {
  const box = scratch("seisin-rev-");
  t.after(() => rmSync(box, { recursive: true, force: true }));
  mkdirSync(join(box, ".seisin"), { recursive: true });
  const f = join(box, ".seisin", "log.jsonl");
  writeFileSync(f, entries.map((l) => JSON.stringify({ at: "2026-09-01T00:00:00Z", ...l })).join("\n") + "\n");
  return box;
}

const policyAt = (root) => ({
  root, path: join(root, "seisin.toml"), keyDirs: [], allowedDomains: [],
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**", "public/**"], keys: [], network: null },
    backend: { name: "backend", writes: ["src/api/**"], keys: [], network: null },
  },
});

test("repeated blocks on one place are one finding, not forty lines", (t) => {
  // Forty denials in the same directory are not an agent misbehaving: they are
  // a wrong policy. Today they read as forty tidy amber lines nobody adds up.
  const root = logWith(t, [
    ...Array(5).fill({ role: "frontend", action: "write", target: "src/api/checkout/a.ts", verdict: "denied", owners: ["backend"] }),
    { role: "frontend", action: "write", target: "src/web/App.tsx", verdict: "allowed" },
  ]);
  const r = review(policyAt(root));
  assert.equal(r.friction.length, 1);
  assert.equal(r.friction[0].times, 5);
  assert.equal(r.friction[0].where, "src/api/checkout");
  assert.deepEqual(r.friction[0].owners, ["backend"]);
  // below the threshold it is not a finding, it is a Tuesday
  assert.equal(review(policyAt(root), { minDenials: 6 }).friction.length, 0);
});

test("a grant nobody ever used is the only way a policy gets smaller", (t) => {
  // Every permissions file only grows, everywhere, and always for the same
  // reason: nobody can prove a line is dead. Here the log can.
  const root = logWith(t, [
    { role: "frontend", action: "write", target: "src/web/App.tsx", verdict: "allowed" },
    { role: "backend", action: "write", target: "src/api/orders.ts", verdict: "allowed" },
  ]);
  const r = review(policyAt(root));
  assert.deepEqual(r.unused, [{ role: "frontend", glob: "public/**" }]);
  // and the window travels with the finding, because "never used" means
  // nothing without "...over how long"
  assert.ok(r.window.from && r.window.to);
});

test("a denial is not what makes a grant look used", (t) => {
  // If a denied attempt counted, a role that never managed to write in its own
  // territory would look like it was using it.
  const root = logWith(t, [
    { role: "frontend", action: "write", target: "public/logo.svg", verdict: "denied", owners: ["backend"] },
    { role: "frontend", action: "write", target: "src/web/a.tsx", verdict: "allowed" },
  ]);
  assert.ok(review(policyAt(root)).unused.some((u) => u.glob === "public/**"));
});

test("paths nobody claims are counted, not just mentioned one at a time", (t) => {
  const root = logWith(t, [
    ...Array(3).fill({ role: "frontend", action: "write", target: "legacy/viejo.js", verdict: "denied", owners: [] }),
    { role: "frontend", action: "write", target: "src/web/a.tsx", verdict: "allowed" },
  ]);
  const r = review(policyAt(root));
  assert.deepEqual(r.unowned.map(({ where, times, kind }) => ({ where, times, kind })),
    [{ where: "legacy", times: 3, kind: "territory" }]);
});

test("an empty log reports nothing rather than inventing a clean bill", (t) => {
  const root = logWith(t, []);
  const r = review(policyAt(root));
  assert.equal(r.entries, 0);
  assert.equal(r.window, null);
  assert.deepEqual(r.unused, []);   // with no data, nothing is declared dead
});

test("SEC-06 init --from-observations ignores lines the parent disputed", () => {
  // A process in the box can send verdict:"observed" lines for paths outside its
  // territory; the parent marks them disputed. They must not become policy.
  const entries = [
    { role: "web", action: "write", target: "src/web/app.ts", verdict: "observed" },
    { role: "web", action: "write", target: "src/api/steal.ts", verdict: "observed", disputed: "denied" },
    { role: "web", action: "read", kind: "key", target: "db.txt", verdict: "observed", disputed: "denied" },
  ];
  const cfg = { root: "/x", path: "/x/seisin.toml", keyDirs: [], allowedDomains: [], roles: {} };
  const { toml } = renderObserved(cfg, entries, '[roles.web]\nwrites = []\nkeys = []\n');
  assert.match(toml, /writes = \[\s*"src\/web\/\*\*"/);   // the legit observation, generalised
  assert.ok(!toml.includes("api"), "a disputed write became policy");
  assert.ok(!toml.includes("db.txt"), "a disputed key read became policy");
});
