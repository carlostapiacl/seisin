/**
 * surface.js without the kernel: which paths the parent trusts, and what a
 * role's profile is given to protect them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { writableRoots, trustedPath, executionSurface, denyFor, protectedBy, protections } from "../src/surface.js";
import { scratch } from "./_tmp.js";

function repo(toml) {
  const dir = realpathSync(scratch("seisin-surface-"));
  writeFileSync(join(dir, "seisin.toml"), toml);
  return dir;
}

test("writable roots collapse into the repo and drop nested ones", () => {
  const dir = repo('[roles.a]\nwrites = ["src/**", "docs/x.md"]\n');
  const roots = writableRoots(loadConfig(join(dir, "seisin.toml")));
  // Covered by one root — the repo itself, or the temp dir it lives in here —
  // and never listed again below it.
  assert.ok(roots.some((r) => dir === r || dir.startsWith(r + "/")), roots.join("\n"));
  assert.ok(!roots.some((r) => r.startsWith(dir + "/")), roots.join("\n"));
  assert.ok(!roots.some((a) => roots.some((b) => a !== b && a.startsWith(b + "/"))));
});

test("the parent's PATH drops relative entries and every writable directory", () => {
  const dir = repo('[roles.a]\nwrites = ["bin/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const env = { PATH: `.::bin:${join(dir, "bin")}:/usr/bin` };
  assert.deepEqual(trustedPath(config, env), ["/usr/bin"]);
});

test("a PATH link into a writable area protects the package, not the whole area", () => {
  // The first version protected the top-level entry under the writable root —
  // in a multi-repo workspace, the folder holding every project, because seisin
  // lives in one project.
  const dir = repo('[roles.a]\nwrites = ["**"]\n');
  const pkg = join(dir, "tools", "thing");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), "{}");
  writeFileSync(join(pkg, "bin", "thing"), "#!/bin/sh\n", { mode: 0o755 });
  const bin = realpathSync(scratch("seisin-pathbin-"));
  symlinkSync(join(pkg, "bin", "thing"), join(bin, "thing"));
  const config = loadConfig(join(dir, "seisin.toml"));
  // `bin` is in the temp dir, which is itself writable scratch; give it a
  // PATH where only the link matters.
  const surface = executionSurface(config, { PATH: bin }, [dir]);
  assert.deepEqual(surface.map((e) => e.path), [pkg]);
});

test("a project's control files are named literally, and cheaply", () => {
  // Start-up grows with literal paths (measured: 50 ≈ none, 400 = 4.8–7.7 s),
  // so a project costs at most `.git/hooks`, `.git/config`, `.claude` and
  // whichever single files exist.
  const dir = repo('[roles.a]\nwrites = ["pkgs/**"]\n');
  for (let i = 0; i < 20; i++) execFileSync("git", ["init", "-q", join(dir, "pkgs", `p${i}`)]);
  const role = loadConfig(join(dir, "seisin.toml")).roles.a;
  const config = loadConfig(join(dir, "seisin.toml"));
  const all = denyFor(config, role, { platform: "darwin", env: { PATH: "/usr/bin" } })
    .filter((e) => e.path.startsWith(dir + "/pkgs/"));
  const literals = all.filter((e) => !/[*?[\]]/.test(e.path));
  assert.ok(literals.length <= 20 * 3 + 3, `${literals.length} literals for 20 projects`);
  assert.ok(literals.some((e) => e.path === join(dir, "pkgs", "p7", ".git", "hooks")));
  assert.ok(literals.some((e) => e.path === join(dir, "pkgs", "p7", ".claude")));
  // A .vscode that is not there costs no literal: creating it is refused by an
  // exact pattern at the project's root, which costs nothing at start-up.
  assert.ok(all.some((e) => e.path === join(dir, "pkgs", "p7", ".vscod[e]")));
});

test("the editor and instruction families: never by ** and never inside node_modules", () => {
  const dir = repo('[roles.a]\nwrites = ["**"]\n\n[protect]\ninstructions = true\n');
  mkdirSync(join(dir, "node_modules", "pkg", ".vscode"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "pkg", "AGENTS.md"), "x\n");
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  const config = loadConfig(join(dir, "seisin.toml"));
  const entries = denyFor(config, config.roles.a, { platform: "darwin", env: { PATH: "/usr/bin" } });
  const fam = entries.filter((e) => e.family);
  assert.ok(fam.length, "the families are protected");
  assert.ok(fam.every((e) => !e.path.includes("**")), "no family entry is a ** pattern");
  assert.ok(!entries.some((e) => e.path.includes("/node_modules/")), "npm must be able to unpack a package's .vscode or AGENTS.md");
  assert.ok(fam.some((e) => e.path === join(dir, ".vscode")), "an existing .vscode is literal");
  assert.ok(fam.some((e) => e.path === join(dir, "AGENTS.m[d]")), "a missing AGENTS.md is a pattern");
});

test("control_files hands a family to one role, and only that role", () => {
  const dir = repo('[roles.front]\nwrites = ["**"]\ncontrol_files = ["ide"]\n\n[roles.back]\nwrites = ["**"]\n');
  mkdirSync(join(dir, ".vscode"), { recursive: true });
  const config = loadConfig(join(dir, "seisin.toml"));
  const opts = { platform: "darwin", env: { PATH: "/usr/bin" } };
  assert.ok(!denyFor(config, config.roles.front, opts).some((e) => e.family === "ide"));
  assert.ok(denyFor(config, config.roles.back, opts).some((e) => e.path === join(dir, ".vscode")));
  assert.equal(protectedBy(config, ".vscode/tasks.json", { platform: "darwin", role: "front" }), null);
  assert.equal(protectedBy(config, ".vscode/tasks.json", { platform: "darwin", role: "back" }).family, "ide");
});

test("instructions are not protected unless the policy says so", () => {
  const dir = repo('[roles.a]\nwrites = ["**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  assert.equal(protectedBy(config, "CLAUDE.md", { platform: "darwin" }), null);
  assert.ok(!denyFor(config, config.roles.a, { platform: "darwin", env: { PATH: "/usr/bin" } }).some((e) => e.family === "instructions"));
});

test("on Linux a family is protected only where it exists, and only in its own spelling", () => {
  const dir = repo('[roles.a]\nwrites = ["**"]\n\n[protect]\ninstructions = true\n');
  writeFileSync(join(dir, "AGENTS.md"), "x\n");
  const config = loadConfig(join(dir, "seisin.toml"));
  assert.ok(protectedBy(config, "AGENTS.md", { platform: "linux" }));
  assert.equal(protectedBy(config, "agents.md", { platform: "linux" }), null, "ext4 does not fold case");
  assert.equal(protectedBy(config, "sub/AGENTS.md", { platform: "linux" }), null, "bubblewrap cannot refuse creating it");
  assert.ok(protectedBy(config, "sub/AGENTS.md", { platform: "darwin" }));
});

test("control_files and [protect] refuse what they do not know", () => {
  const bad = (toml) => { const dir = repo(toml); return () => loadConfig(join(dir, "seisin.toml")); };
  assert.throws(bad('[roles.a]\nwrites = ["**"]\ncontrol_files = [".claude"]\n'), /not a family of control files/);
  assert.throws(bad('[roles.a]\nwrites = ["**"]\n\n[protect]\ninstruction = true\n'), /not a setting/);
  assert.throws(bad('[roles.a]\nwrites = ["**"]\n\n[protect]\ninstructions = "yes"\n'), /true or false/);
});

test("explain's protection matches control files in any case, at any depth", () => {
  const dir = repo('[roles.a]\nwrites = ["**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  for (const p of ["a/b/.claude/settings.json", "x/.CLAUDE/Settings.JSON", "deep/x/.claude/notes.md",
                   ".git/hooks/pre-commit", "sub/.envrc", "seisin.toml"])
    assert.ok(protectedBy(config, p, { platform: "darwin" }), p);
  for (const p of ["src/app.ts", "docs/claude.md", ".github/workflows/ci.yml"])
    assert.equal(protectedBy(config, p), null, p);
});

test("check lists what a protection takes from a territory, not the old always-denied", () => {
  const dir = repo('[keys]\ndir = ".secrets"\n\n[roles.a]\nwrites = ["**"]\n');
  mkdirSync(join(dir, ".secrets"));
  execFileSync("git", ["init", "-q", dir]);
  const shown = protections(loadConfig(join(dir, "seisin.toml")), undefined, { env: { PATH: "/usr/bin" } });
  const paths = shown.map((e) => e.path);
  assert.ok(paths.includes(join(dir, ".git", "hooks")));
  assert.ok(!paths.includes(join(dir, "seisin.toml")));
  assert.ok(!paths.includes(join(dir, ".secrets")));
});
