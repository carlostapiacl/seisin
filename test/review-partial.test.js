/**
 * What `review` does when what it is looking at is not what it thinks.
 *
 * Both findings here came from the same real repository on the same day, and
 * both are the same shape: the command answering a question its input cannot
 * support. One would have had someone delete permissions their roles were
 * using; the other recommended granting two roles the credential directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { review } from "../src/review.js";
import { loadConfig } from "../src/config.js";

const POLICY = `[keys]
dir = [".secrets"]

[roles.frontend]
writes = ["src/web/**", "public/**"]
keys = []

[roles.backend]
writes = ["src/api/**"]
keys = []
`;

/** A repo with a policy and a log of exactly these entries. */
function repo(lines) {
  const root = mkdtempSync(join(tmpdir(), "seisin-review-"));
  writeFileSync(join(root, "seisin.toml"), POLICY);
  mkdirSync(join(root, ".seisin"), { recursive: true });
  writeFileSync(join(root, ".seisin", "log.jsonl"),
    lines.map((e) => JSON.stringify({ at: "2026-09-14T10:00:00.000Z", ...e })).join("\n") + "\n");
  return loadConfig(join(root, "seisin.toml"));
}

const denied = (n, over) =>
  Array.from({ length: n }, () => ({ verdict: "denied", ...over }));

/* ── the key directory is not a territory drawn wrong ─────────────────── */

test("refusals at a key directory are reported apart from territory friction", () => {
  const config = repo([
    ...denied(4, { role: "frontend", action: "read", target: ".secrets", kind: "key", owners: [] }),
    ...denied(3, { role: "frontend", action: "write", target: "src/api/orders.ts", owners: ["backend"] }),
  ]);
  const r = review(config);

  assert.equal(r.friction.length, 1, "only the territory question is friction");
  assert.equal(r.friction[0].where, "src/api");
  assert.deepEqual(r.friction[0].owners, ["backend"]);

  assert.equal(r.guarded.length, 1, "the key directory is reported, separately");
  assert.equal(r.guarded[0].where, ".secrets");
  assert.equal(r.guarded[0].times, 4);
});

test("a role held at the keys does not make the command fail", () => {
  // `seisin review` exits 1 on friction so it composes in CI. A boundary
  // refusing what it was configured to refuse must not fail a build, or a
  // correct policy can never go green.
  const config = repo(denied(9, { role: "frontend", action: "read", target: ".secrets", kind: "key", owners: [] }));
  const r = review(config);
  assert.equal(r.friction.length, 0);
  assert.equal(r.guarded.length, 1);
});

/* ── never used, when nothing records what was used ───────────────────── */

test("with no allowed lines, unused refuses to answer instead of listing everything", () => {
  // Without the hook the log holds denials and nothing else, so every grant
  // falls through as unused. Measured on a real repo: the entire policy of
  // every role, listed as dead, while those roles were working.
  const config = repo(denied(3, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] }));
  const r = review(config);

  assert.equal(r.unusedKnowable, false);
  assert.deepEqual(r.unused, [],
    "empty, not full: a consumer that ignores the flag must under-report, never over-report");
});

test("one allowed line is enough to make the question answerable again", () => {
  const config = repo([
    { role: "frontend", action: "write", target: "src/web/App.tsx", verdict: "allowed" },
    ...denied(3, { role: "frontend", action: "write", target: "src/api/x.ts", owners: ["backend"] }),
  ]);
  const r = review(config);

  assert.equal(r.unusedKnowable, true);
  const globs = r.unused.map((u) => u.glob).sort();
  assert.deepEqual(globs, ["public/**", "src/api/**"]);
  assert.ok(!globs.includes("src/web/**"), "the one that was written is not dead");
});

test("an empty log answers nothing and claims nothing", () => {
  const config = repo([]);
  const r = review(config);
  assert.equal(r.entries, 0);
  assert.deepEqual(r.unused, []);
  assert.equal(r.unusedKnowable, false);
  assert.deepEqual(r.guarded, []);
});

/* ── the keys separator ───────────────────────────────────────────────── */

test("grouping keys cannot collide, because role names cannot hold a separator", () => {
  // These Maps are keyed on role + action + path joined by a space. That is
  // safe only because `tomlName` restricts a role name to [A-Za-z0-9_-], so the
  // first two spaces always fall where they are meant to — whatever is in the
  // path. It used to be a NUL byte, which bought nothing here and cost the file
  // its diff: git classifies a source file containing NUL as binary.
  const config = repo([
    ...denied(3, { role: "frontend", action: "write", target: "a dir/x.ts", owners: ["backend"] }),
    ...denied(3, { role: "frontend", action: "write", target: "a/dir x.ts", owners: ["backend"] }),
  ]);
  const r = review(config);
  assert.equal(r.friction.length, 2, "two different places, two rows");
});
