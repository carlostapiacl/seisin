/**
 * The two `check` warnings that ask the disk a question about the policy.
 *
 * Both are arithmetic: a grant on a file covers the file and not what a tool
 * puts beside it, and a territory written as a list of files is a count against
 * the folder it was copied from. Neither knows what any program does. Every
 * fixture is built under a temp dir and torn down, because these are the first
 * warnings whose answer depends on what is actually there.
 *
 * The silent cases get as many tests as the loud ones. `check` is read before
 * anything is trusted, and a warning that fires when it should not is how it
 * stops being read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspect } from "../src/inspect.js";
import { scratch } from "./_tmp.js";

/** A repo on disk: `files` are created, `dirs` are created, nothing else. */
function repo(files = [], dirs = []) {
  const root = scratch("seisin-hints-");
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  return root;
}

/** A config with one role, no keys, and a model endpoint so nothing unrelated fires. */
function policy(root, writes, more = {}) {
  return {
    root, path: join(root, "seisin.toml"), keyDirs: [], allowedDomains: ["api.anthropic.com"],
    roles: { dev: { name: "dev", writes, keys: [], env: [], network: null }, ...more },
  };
}

const kinds = (cfg, only = null) => inspect(cfg, only, "seisin.toml").warnings.map((w) => w.kind);
const find = (cfg, kind, only = null) =>
  inspect(cfg, only, "seisin.toml").warnings.find((w) => w.kind === kind);

/* ── a file granted by name does not come with its neighbours ─────────── */

test("a file granted alone: its siblings are outside the grant, and check says so with the numbers", () => {
  const root = repo(["data/base.sqlite"]);
  try {
    const w = find(policy(root, ["src/**", "data/base.sqlite"]), "siblings-uncovered");
    assert.ok(w, "a literal file grant went unmentioned");
    // One warning for the whole policy, with the count leading and the role
    // named as an example. Per-role lines read fine on this fixture and took a
    // real 30-role policy from 30 lines of `check` to 297.
    assert.match(w.headline, /1 role\(s\) grant individual files rather than folders/);
    assert.match(w.headline, /dev \(1 of 2\)/);
    assert.match(w.detail, /seisin check <role>/, "and points at where the paths are");
    // The file is named; no program is. The rule is about the grant's shape,
    // and the moment it knows about databases it has to know about everything
    // else.
    assert.doesNotMatch(w.detail, /sqlite/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the same file inside a subtree the role already holds is silent", () => {
  // Naming a file the role could already write changes nothing about its
  // siblings — they are covered by the folder — so there is nothing to say.
  const root = repo(["data/base.sqlite"]);
  try {
    assert.ok(!kinds(policy(root, ["data/**", "data/base.sqlite"])).includes("siblings-uncovered"));
    assert.ok(!kinds(policy(root, ["**", "data/base.sqlite"])).includes("siblings-uncovered"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a literal path that is a folder is a subtree to the kernel, not a file", () => {
  // `data` and `data/**` are the same grant once they reach the sandbox. The
  // text alone cannot tell `data` from `data/base.sqlite`; the disk can.
  const root = repo(["data/base.sqlite"]);
  try {
    assert.ok(!kinds(policy(root, ["data"])).includes("siblings-uncovered"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a granted path that is not on disk is counted as neither, and stays silent", () => {
  // It could become a file or a folder; guessing which from its spelling is
  // exactly the kind of heuristic these warnings refuse to be.
  const root = repo();
  try {
    assert.ok(!kinds(policy(root, ["data/base.sqlite", "notes.md"])).includes("siblings-uncovered"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a symlink is neither a file nor a folder here", () => {
  // The sandbox enforces on the destination of a link, so what the grant
  // covers is a question about somewhere else. Left out rather than answered.
  const root = repo(["elsewhere/real.txt"]);
  try {
    symlinkSync(join(root, "elsewhere/real.txt"), join(root, "link.txt"));
    assert.ok(!kinds(policy(root, ["link.txt"])).includes("siblings-uncovered"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only the role asked about is reported", () => {
  const root = repo(["data/base.sqlite", "src/x.ts"]);
  try {
    const cfg = policy(root, ["data/base.sqlite"],
      { web: { name: "web", writes: ["src/**"], keys: [], env: [], network: null } });
    assert.ok(find(cfg, "siblings-uncovered", "dev"));
    assert.ok(!find(cfg, "siblings-uncovered", "web"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── a territory written as a list of files is a photograph of the folder ── */

test("several named files in one folder: check counts them against the folder, and names the rest", () => {
  const root = repo(["src/a.py", "src/b.py", "src/c.py", "src/README.md"]);
  try {
    const w = find(policy(root, ["src/a.py", "src/b.py"]), "enumerated-territory");
    assert.ok(w, "an enumerated folder went unmentioned");
    assert.match(w.headline, /1 territory\(ies\) list some files of a folder/);
    assert.match(w.headline, /dev names 2 of 4 in src\//);
    // The unnamed ones are listed, so the reader decides — the check does not.
    assert.match(w.detail, /README\.md c\.py/);
    // And it is an observation, not a verdict: nothing in it says "missing".
    assert.doesNotMatch(w.headline + w.detail, /missing|forgot|stale/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a complete enumeration is silent", () => {
  // Two named, two on disk: the policy and the folder agree, and there is no
  // number worth printing.
  const root = repo(["src/a.py", "src/b.py"]);
  try {
    assert.ok(!kinds(policy(root, ["src/a.py", "src/b.py"])).includes("enumerated-territory"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("one named file in a folder is a grant, not an enumeration", () => {
  // Granting one file beside nine others is an ordinary policy — `package.json`
  // is the usual case. The count only means something once the list has a
  // second entry, because that is when it starts to read as "the files here".
  const root = repo(["src/a.py", "src/b.py", "src/c.py"]);
  try {
    assert.ok(!kinds(policy(root, ["src/a.py"])).includes("enumerated-territory"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an enumeration inside a subtree the role already holds is silent", () => {
  const root = repo(["src/a.py", "src/b.py", "src/c.py"]);
  try {
    assert.ok(!kinds(policy(root, ["src/**", "src/a.py", "src/b.py"])).includes("enumerated-territory"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("only regular files directly in the folder count: not subfolders, not links, not deeper", () => {
  // "Comparable" is kept to the one thing that is not a guess. A subfolder is
  // not a file the role could have named the same way; a link lives elsewhere;
  // a file one level down is in a different folder.
  const root = repo(["src/a.py", "src/b.py", "src/sub/deep.py", "elsewhere/real.py"], ["src/empty"]);
  try {
    symlinkSync(join(root, "elsewhere/real.py"), join(root, "src/link.py"));
    assert.ok(!kinds(policy(root, ["src/a.py", "src/b.py"])).includes("enumerated-territory"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two folders are two counts, and the repo root is called by name", () => {
  const root = repo(["a.txt", "b.txt", "c.txt", "lib/x.js", "lib/y.js", "lib/z.js"]);
  try {
    // Two folders, one warning, both counted in it — and the repo root is
    // called by name rather than printed as an empty path.
    const ws = inspect(policy(root, ["a.txt", "b.txt", "lib/x.js", "lib/y.js"]), null, "x")
      .warnings.filter((w) => w.kind === "enumerated-territory");
    assert.equal(ws.length, 1);
    assert.match(ws[0].headline, /2 territory\(ies\)/);
    assert.match(ws[0].headline, /2 of 3 in the repo root/);
    assert.match(ws[0].headline, /2 of 3 in lib\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a long list of unnamed files is cut, and says by how much", () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, "0")}.py`);
  const root = repo(files);
  try {
    const w = find(policy(root, [files[0], files[1]]), "enumerated-territory");
    assert.match(w.headline, /2 of 12 in src\//);
    assert.match(w.detail, /… and 2 more/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ── and the ordinary policy says nothing at all ──────────────────────── */

test("a territory of subtrees triggers neither", () => {
  const root = repo(["src/web/app.ts", "src/api/server.ts", "public/index.html"]);
  try {
    const k = kinds(policy(root, ["src/web/**", "public/**"]));
    assert.ok(!k.includes("siblings-uncovered"));
    assert.ok(!k.includes("enumerated-territory"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
