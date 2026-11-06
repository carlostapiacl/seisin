/**
 * Which files count as control files, for each agent's home and project.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig } from "../src/config.js";
import { parentInputs, denyFor, protections, writableRoots, protectedBy } from "../src/surface.js";
import { scratch } from "./_tmp.js";

/** A policy on disk, loaded. */
function policy(toml) {
  const dir = scratch("seisin-review-");
  writeFileSync(join(dir, "seisin.toml"), toml);
  return loadConfig(join(dir, "seisin.toml"));
}

test("key directories and the policy are protected by a field, not by their wording", () => {
  const cfg = policy(`
[keys]
dir = ".secrets"
[roles.a]
writes = ["a/**"]
`);
  const inputs = parentInputs(cfg);
  assert.ok(inputs.filter((e) => e.always).some((e) => e.why === "a key directory"));
  assert.ok(inputs.filter((e) => e.always).some((e) => e.why === "the policy"));
  // Outside a's territory, and still in its profile.
  const denies = denyFor(cfg, cfg.roles.a, { platform: "darwin" });
  assert.ok(denies.some((e) => e.path.endsWith("/.secrets")));
  assert.ok(denies.some((e) => e.path.endsWith("/seisin.toml")));
  // Never shown by check: closed since the first release.
  assert.ok(!protections(cfg).some((e) => e.always || e.why === "a key directory"));
  // Memoised per config, not per call.
  assert.equal(writableRoots(cfg), writableRoots(cfg));
  assert.equal(parentInputs(cfg), parentInputs(cfg));
});

test("a project's .codex is protected whole, as .claude is: config, hooks and rules", () => {
  // Codex reads all three from any project the user has trusted, and keeps
  // `.codex` read-only inside its own writable roots. Measured 2026-09-30.
  const cfg = policy(`[roles.a]\nwrites = ["**"]\n`);
  for (const f of ["p/.codex/config.toml", "p/.codex/hooks.json", ".codex/rules/default.rules", "p/.codex"]) {
    const hit = protectedBy(cfg, f, { platform: "darwin" });
    assert.ok(hit, f);
    assert.match(hit.why, /Codex runs outside the sandbox/, f);
  }
  const globs = denyFor(cfg, cfg.roles.a, { platform: "darwin" }).map((e) => e.path);
  assert.ok(globs.some((g) => g.endsWith("/**/.codex")), "creating one is refused too");
  assert.ok(globs.some((g) => g.endsWith("/**/.codex/**")));
});

test("Codex's home: what it runs or obeys is denied, what it writes every turn is not", () => {
  // The default runtime grants ~/.codex, because Codex keeps its sessions and
  // state databases there. Inside it, the control files are taken back one by one.
  const cfg = policy(`[roles.a]\nwrites = ["a/**"]\n`);
  const paths = denyFor(cfg, cfg.roles.a, { platform: "darwin" }).map((e) => e.path);
  const home = join(homedir(), ".codex");
  for (const f of ["config.toml", "hooks.json", "rules", "skills", "plugins", "managed_config.toml"])
    assert.ok(paths.includes(join(home, f)), f);
  assert.ok(paths.includes(`${home}/*.config.toml`), "a profile created later");
  for (const f of ["", "sessions", "log", "cache", "history.jsonl", "auth.json"])
    assert.ok(!paths.includes(join(home, f).replace(/\/$/, "")), `${f || "~/.codex"} must stay writable`);
  // And explain says the same, entry by entry: a session file is not protected.
  assert.match(protectedBy(cfg, join(home, "plugins", "cache", "x"), { platform: "darwin" }).why, /^\.codex\/plugins,/);
  assert.match(protectedBy(cfg, join(home, "work.config.toml"), { platform: "darwin" }).why, /^\.codex\/work\.config\.toml,/);
  for (const f of ["sessions/2026/09/30/rollout.jsonl", "history.jsonl", "auth.json"])
    assert.equal(protectedBy(cfg, join(home, f), { platform: "darwin" }), null, f);
  // Without ~/.codex in the runtime, nothing of it is in the profile.
  const narrow = policy(`[runtime]\nwrites = ["$TMPDIR"]\n[roles.a]\nwrites = ["a/**"]\n`);
  assert.ok(!denyFor(narrow, narrow.roles.a, { platform: "darwin" }).some((e) => e.path.startsWith(home)));
});

test("protectedBy still names every control file, case-folded, and only whole segments", () => {
  const cfg = policy(`[roles.a]\nwrites = ["**"]\n`);
  for (const f of [".git/hooks/pre-commit", "x/.mcp.json", ".envrc", "p/.codex/config.toml", ".CLAUDE/settings.json"])
    assert.ok(protectedBy(cfg, f, { platform: "darwin" }), f);
  for (const f of ["xmcpxjson", "a.mcp.json", "x/.envrc.bak", "p/.codexx/config.toml", "p/x.codex"])
    assert.equal(protectedBy(cfg, f, { platform: "darwin" }), null, f);
  assert.ok(protectedBy(cfg, ".VSCODE/tasks.json", { platform: "darwin" }));
  assert.equal(protectedBy(cfg, ".VSCODE/tasks.json", { platform: "linux" }), null);
});
