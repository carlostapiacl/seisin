/**
 * Where the same file lives twice.
 *
 * The pure half is exercised against fixtures written by hand in the exact
 * shape git leaves on disk — a `.git` file with a `gitdir:` line, and the
 * reverse pointer under `.git/worktrees/<name>/gitdir` — because that is what
 * the code reads, and a test that only ever runs against real git would pass
 * on a machine where the format had moved and the parser had not.
 *
 * The end-to-end half builds a real repo with a real worktree and reads what
 * the two commands print from both places. A change to a diagnosis tool is not
 * verified by seeing that it did not crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseGitdir, checkoutOf, worktreesOf, twinsOf, whereIs } from "../src/worktree.js";
import { loadConfig } from "../src/config.js";
import { scratch } from "./_tmp.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const haveGit = spawnSync("git", ["--version"]).status === 0;

/* ── fixtures ─────────────────────────────────────────────────────────── */

/** A temp directory with symlinks resolved, so paths compare the way git writes them. */
function box(tag) {
  return realpathSync(scratch(`seisin-${tag}-`));
}

/**
 * A canonical checkout and one worktree of it, written by hand.
 *
 * `canonical/.git` is a directory; `worktree/.git` is a file naming
 * `<canonical>/.git/worktrees/<name>`; and the canonical side keeps
 * `.git/worktrees/<name>/gitdir` pointing at `<worktree>/.git`. That is the
 * whole of what git puts down that this module reads.
 */
function link(canonical, worktree, name = "fix") {
  mkdirSync(join(canonical, ".git", "worktrees", name), { recursive: true });
  writeFileSync(join(canonical, ".git", "worktrees", name, "gitdir"), join(worktree, ".git") + "\n");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(canonical, ".git", "worktrees", name)}\n`);
}

function policy(dir, text) {
  writeFileSync(join(dir, "seisin.toml"), text);
  return loadConfig(join(dir, "seisin.toml"));
}

const ABOVE = `
[roles.dev]
writes = ["repo/src/**"]
[roles.qa]
writes = ["qa/**"]
`;

/* ── parseGitdir ──────────────────────────────────────────────────────── */

test("a worktree's .git file names the canonical checkout", () => {
  assert.equal(parseGitdir("gitdir: /work/repo/.git/worktrees/fix\n"), "/work/repo");
  assert.equal(parseGitdir("gitdir:/work/repo/.git/worktrees/fix"), "/work/repo");
});

test("the relative form newer git writes resolves against the file's own directory", () => {
  assert.equal(parseGitdir("gitdir: ../../repo/.git/worktrees/fix", "/work/trees/fix"), "/work/repo");
});

test("a .git file that is not a worktree's is refused rather than guessed at", () => {
  // A submodule points into .git/modules; a worktree of a bare repo points at a
  // directory with no working tree. Neither has a twin to name.
  assert.equal(parseGitdir("gitdir: ../.git/modules/lib", "/work/repo/lib"), null);
  assert.equal(parseGitdir("gitdir: /srv/repo.git/worktrees/fix"), null);
  assert.equal(parseGitdir("not a pointer at all"), null);
  assert.equal(parseGitdir(""), null);
});

/* ── checkoutOf ───────────────────────────────────────────────────────── */

test("a .git directory is the canonical checkout, a .git file is a worktree of one", () => {
  const b = box("co");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    assert.deepEqual(checkoutOf(join(b, "repo", "src", "a.ts")),
      { root: join(b, "repo"), canonical: join(b, "repo"), worktree: false });
    assert.deepEqual(checkoutOf(join(b, "trees", "fix", "src", "a.ts")),
      { root: join(b, "trees", "fix"), canonical: join(b, "repo"), worktree: true });
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("the file asked about need not exist — it is usually the one that was refused", () => {
  const b = box("co");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    const c = checkoutOf(join(b, "trees", "fix", "deep", "er", "new.ts"));
    assert.equal(c.root, join(b, "trees", "fix"));
    assert.equal(c.worktree, true);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("a submodule's .git file is stepped over to the enclosing checkout", () => {
  const b = box("co");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    mkdirSync(join(b, "trees", "fix", "lib"));
    writeFileSync(join(b, "trees", "fix", "lib", ".git"), "gitdir: ../.git/modules/lib\n");
    assert.equal(checkoutOf(join(b, "trees", "fix", "lib", "x.c")).root, join(b, "trees", "fix"));
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

/* ── worktreesOf ──────────────────────────────────────────────────────── */

test("the canonical side lists the worktrees it has registered", () => {
  const b = box("wt");
  try {
    link(join(b, "repo"), join(b, "trees", "one"), "one");
    link(join(b, "repo"), join(b, "trees", "two"), "two");
    assert.deepEqual(worktreesOf(join(b, "repo")).sort(), [join(b, "trees", "one"), join(b, "trees", "two")]);
    assert.deepEqual(worktreesOf(join(b, "nowhere")), []);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("a registration whose worktree is gone, or points elsewhere, is not a worktree", () => {
  // `rm -rf` on a worktree leaves the entry until `git worktree prune`; and a
  // directory can be deleted and reused. Naming either would be inventing a
  // place on disk.
  const b = box("wt");
  try {
    link(join(b, "repo"), join(b, "trees", "gone"), "gone");
    rmSync(join(b, "trees", "gone"), { recursive: true });
    link(join(b, "repo"), join(b, "trees", "reused"), "reused");
    writeFileSync(join(b, "trees", "reused", ".git"), `gitdir: ${join(b, "other", ".git", "worktrees", "reused")}\n`);
    assert.deepEqual(worktreesOf(join(b, "repo")), []);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

/* ── twinsOf ──────────────────────────────────────────────────────────── */

test("a policy above both checkouts sees the twin from either side", () => {
  const b = box("tw");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    const cfg = policy(b, ABOVE);

    // Asked about the canonical path: the twin is in the worktree.
    let { here, twins } = twinsOf(cfg, "repo/src/a.ts", b);
    assert.equal(here.worktree, false);
    assert.equal(twins.length, 1);
    assert.equal(twins[0].rel, "trees/fix/src/a.ts");
    assert.equal(twins[0].path, join(b, "trees", "fix", "src", "a.ts"));
    assert.equal(twins[0].worktree, true);
    assert.equal(twins[0].standing, false);

    // Asked about the worktree path: the twin is the canonical one.
    ({ here, twins } = twinsOf(cfg, "trees/fix/src/a.ts", b));
    assert.equal(here.worktree, true);
    assert.deepEqual(twins.map((t) => [t.rel, t.worktree]), [["repo/src/a.ts", false]]);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("the checkout the process is standing in is marked, and comes first", () => {
  const b = box("tw");
  try {
    link(join(b, "repo"), join(b, "trees", "one"), "one");
    link(join(b, "repo"), join(b, "trees", "two"), "two");
    const cfg = policy(b, ABOVE);
    const { twins } = twinsOf(cfg, "repo/src/a.ts", join(b, "trees", "two", "src"));
    assert.deepEqual(twins.map((t) => [t.rel, t.standing]),
      [["trees/two/src/a.ts", true], ["trees/one/src/a.ts", false]]);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("a path with .. in it finds the same twin as its flat spelling", () => {
  const b = box("tw");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    const cfg = policy(b, ABOVE);
    assert.equal(twinsOf(cfg, "repo/src/../src/a.ts", b).twins[0].rel, "trees/fix/src/a.ts");
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("a worktree that carries its own policy is another policy's business", () => {
  // A repo that tracks seisin.toml gives every worktree a copy, and a role
  // launched there resolves its territory against that copy. Reporting the
  // canonical side under this file would be the confusion this exists to end.
  const b = box("tw");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    const cfg = policy(join(b, "repo"), '[roles.dev]\nwrites = ["src/**"]\n');
    writeFileSync(join(b, "trees", "fix", "seisin.toml"), '[roles.dev]\nwrites = ["src/**"]\n');
    assert.deepEqual(twinsOf(cfg, "src/a.ts", join(b, "repo")).twins, []);
    // And from inside that worktree, loading ITS policy, the canonical side is
    // outside the policy root and equally not a twin.
    const inner = loadConfig(join(b, "trees", "fix", "seisin.toml"));
    assert.deepEqual(twinsOf(inner, "src/a.ts", join(b, "trees", "fix")).twins, []);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("a worktree outside the policy root is not a twin — a process there would not find this policy", () => {
  const b = box("tw");
  const elsewhere = box("tw-out");
  try {
    link(join(b, "repo"), join(elsewhere, "fix"));
    const cfg = policy(b, ABOVE);
    assert.deepEqual(twinsOf(cfg, "repo/src/a.ts", b).twins, []);
  } finally {
    rmSync(b, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a path in no checkout at all has no twins", () => {
  const b = box("tw");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    const cfg = policy(b, ABOVE);
    const { twins } = twinsOf(cfg, "qa/report.md", b);
    assert.deepEqual(twins, []);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("the sentence names the two places relative to the policy, and the root as 'this repo'", () => {
  const b = box("tw");
  try {
    link(join(b, "repo"), join(b, "trees", "fix"));
    const cfg = policy(b, ABOVE);
    const canonical = { root: join(b, "repo"), canonical: join(b, "repo"), worktree: false };
    const wt = { root: join(b, "trees", "fix"), canonical: join(b, "repo"), worktree: true };
    assert.equal(whereIs(cfg, canonical, { root: wt.root, worktree: true, standing: false }),
      "repo has a worktree at trees/fix");
    assert.equal(whereIs(cfg, canonical, { root: wt.root, worktree: true, standing: true }),
      "you are standing in a worktree of repo, at trees/fix");
    assert.equal(whereIs(cfg, wt, { root: canonical.root, worktree: false, standing: false }),
      "trees/fix is a worktree of repo");
    assert.equal(whereIs(cfg, wt, { root: canonical.root, worktree: false, standing: true }),
      "you are standing in repo, and trees/fix is a worktree of it");

    const atRoot = policy(join(b, "repo"), '[roles.dev]\nwrites = ["src/**"]\n');
    assert.equal(whereIs(atRoot, canonical, { root: wt.root, worktree: true, standing: false }),
      `this repo has a worktree at ${join(b, "trees", "fix")}`);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

/* ── end to end, against real git ─────────────────────────────────────── */

const git = (cwd, ...args) =>
  spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });

const seisin = (cwd, ...args) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

/** The verdict line and everything before the worktree note — what the answer was, apart from the note. */
const answer = (stdout) => stdout.split("  worktree  ")[0];

test("explain and whose say so from both checkouts, and change no verdict", { skip: !haveGit && "git is not installed" }, () => {
  const b = box("e2e");
  try {
    mkdirSync(join(b, "repo"));
    assert.equal(git(join(b, "repo"), "init", "-q").status, 0);
    assert.equal(git(join(b, "repo"), "commit", "-q", "--allow-empty", "-m", "init").status, 0);
    writeFileSync(join(b, "seisin.toml"), ABOVE);

    // Before the worktree exists: the answer to keep.
    const before = seisin(join(b, "repo"), "explain", "dev", "write", "repo/src/a.ts");
    assert.equal(before.status, 0);
    assert.match(before.stdout, /allowed  dev write repo\/src\/a\.ts/);
    assert.ok(!before.stdout.includes("worktree"), "nothing to say before there is a worktree");

    assert.equal(git(join(b, "repo"), "worktree", "add", "-q", join(b, "trees", "fix")).status, 0);
    const repo = join(b, "repo");
    const fix = join(b, "trees", "fix");

    // The defect: allowed on the canonical path, asked from inside the worktree.
    const inside = seisin(fix, "explain", "dev", "write", "repo/src/a.ts");
    assert.equal(inside.status, before.status, "the exit code is the verdict, and it did not move");
    assert.equal(answer(inside.stdout), answer(before.stdout), "the verdict is word for word what it was");
    assert.match(inside.stdout, /worktree  you are standing in a worktree of repo, at trees\/fix/);
    assert.match(inside.stdout, /the same file there is trees\/fix\/src\/a\.ts, and it has no owner\./);
    assert.match(inside.stdout, /The policy names the canonical checkout, not the worktree — a write in the worktree is refused\./);

    // Same question from the canonical side: the worktree is named, not "you".
    const outside = seisin(repo, "explain", "dev", "write", "repo/src/a.ts");
    assert.equal(outside.status, 0);
    assert.match(outside.stdout, /worktree  repo has a worktree at trees\/fix/);

    // The reverse: asked about the path that was actually refused.
    const refused = seisin(fix, "explain", "dev", "write", "trees/fix/src/a.ts");
    assert.equal(refused.status, 1, "still denied — the note is not a grant");
    assert.match(refused.stdout, /denied  dev write trees\/fix\/src\/a\.ts/);
    assert.match(refused.stdout, /worktree  trees\/fix is a worktree of repo/);
    assert.match(refused.stdout, /the same file there is repo\/src\/a\.ts, and it is inside dev's territory\./);
    assert.match(refused.stdout, /The policy names the canonical checkout, not the worktree\.\n/);

    // Nothing to say: a role refused on both sides, a path in no checkout, a key.
    for (const args of [["explain", "qa", "write", "repo/src/a.ts"], ["explain", "dev", "write", "qa/x"], ["explain", "dev", "read", "token"]]) {
      const r = seisin(fix, ...args);
      assert.equal(r.status, 1);
      assert.ok(!r.stdout.includes("worktree"), `no note for ${args.join(" ")}:\n${r.stdout}`);
    }

    // whose, from inside the box, on the path the kernel refused.
    const who = spawnSync(process.execPath, [CLI, "whose", "trees/fix/src/a.ts"],
      { cwd: fix, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", SEISIN_ROLE: "dev" } });
    assert.equal(who.status, 0);
    assert.match(who.stdout, /nobody owns trees\/fix\/src\/a\.ts/);
    assert.match(who.stdout, /worktree  trees\/fix is a worktree of repo/);
    assert.match(who.stdout, /the same file there is repo\/src\/a\.ts, and it belongs to dev — that is you\./);
    assert.match(who.stdout, /The policy names the canonical checkout, not the worktree\./);

    // whose on a path owned the same way on both sides says nothing extra.
    const same = seisin(fix, "whose", "qa/x");
    assert.match(same.stdout, /qa\/x belongs to qa/);
    assert.ok(!same.stdout.includes("worktree"));

    // A worktree removed without `prune` is no longer a place.
    rmSync(join(b, "trees"), { recursive: true });
    const stale = seisin(repo, "explain", "dev", "write", "repo/src/a.ts");
    assert.equal(stale.status, 0);
    assert.ok(!stale.stdout.includes("worktree"), `stale registration named:\n${stale.stdout}`);
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});

test("a repo that tracks its policy gives every worktree its own, and nothing is said", { skip: !haveGit && "git is not installed" }, () => {
  const b = box("e2e");
  try {
    const repo = join(b, "repo");
    mkdirSync(repo);
    assert.equal(git(repo, "init", "-q").status, 0);
    writeFileSync(join(repo, "seisin.toml"), '[roles.dev]\nwrites = ["src/**"]\n');
    assert.equal(git(repo, "add", "seisin.toml").status, 0);
    assert.equal(git(repo, "commit", "-q", "-m", "policy").status, 0);
    assert.equal(git(repo, "worktree", "add", "-q", join(b, "fix")).status, 0);

    for (const cwd of [repo, join(b, "fix")]) {
      const r = seisin(cwd, "explain", "dev", "write", "src/a.ts");
      assert.equal(r.status, 0);
      assert.ok(!r.stdout.includes("worktree"), `noise from ${cwd}:\n${r.stdout}`);
      const w = seisin(cwd, "whose", "src/a.ts");
      assert.ok(!w.stdout.includes("worktree"), `noise from ${cwd}:\n${w.stdout}`);
    }
  } finally {
    rmSync(b, { recursive: true, force: true });
  }
});
