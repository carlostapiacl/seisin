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
  // on the portfolio, all of 01-activos/, because seisin lives in one project.
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
  const literals = denyFor(config, role, { platform: "darwin", env: { PATH: "/usr/bin" } })
    .filter((e) => !e.path.includes("*") && e.path.startsWith(dir + "/pkgs/"));
  assert.ok(literals.length <= 20 * 3 + 3, `${literals.length} literals for 20 projects`);
  assert.ok(literals.some((e) => e.path === join(dir, "pkgs", "p7", ".git", "hooks")));
  assert.ok(literals.some((e) => e.path === join(dir, "pkgs", "p7", ".claude")));
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
