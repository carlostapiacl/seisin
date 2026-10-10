/**
 * Release blockers found in the review before 0.6.0.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { inspect } from "../src/inspect.js";
import { explain, explainFileRead } from "../src/owners.js";
import { settingsFor } from "../src/srt.js";
import { boxed, CLI, srtSkip } from "./_tmp.js";

const policy = (writes, extra = "") =>
  `[runtime]\nwrites = []\n${extra}\n[roles.dev]\nwrites = ["${writes}"]\nkeys = []\n`;

for (const grant of [".claude", ".claude/**", ".claude/hooks/**"]) {
  test(`check refuses a territory aimed at ${grant}`, () => {
    const root = boxed("pre060-check-");
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, "seisin.toml"), policy(grant));
    const cfg = loadConfig(join(root, "seisin.toml"));
    assert.ok(inspect(cfg).warnings.some((w) =>
      w.kind === "cannot-be-enforced" && w.headline.includes(grant)));
  });
}

test("an explicit .claude territory never starts a command or writes", () => {
  for (const grant of [".claude", ".claude/**", ".claude/hooks/**"]) {
    const root = boxed("pre060-refuse-");
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(root, ".claude", "hooks", "before.sh"), "old\n");
    writeFileSync(join(root, "seisin.toml"), policy(grant));
    const target = grant.includes("hooks") ? ".claude/hooks/before.sh" : ".claude/settings.json";
    const run = spawnSync(process.execPath,
      [CLI, "run", "dev", "--", "sh", "-c", `echo changed > ${target}`],
      { cwd: root, encoding: "utf8" });
    assert.notEqual(run.status, 0, grant);
    assert.match(run.stderr, /\.claude cannot be granted/);
  }
});

test("against the kernel: writes = ** still cannot write .claude", {
  skip: srtSkip(),
}, () => {
  for (const grant of ["**"]) {
    const root = boxed("pre060-kernel-");
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(root, ".claude", "hooks", "before.sh"), "old\n");
    writeFileSync(join(root, "seisin.toml"), policy(grant));
    settingsFor(loadConfig(join(root, "seisin.toml")), "dev");
    for (const target of [".claude/settings.json", ".claude/hooks/before.sh"]) {
      const run = spawnSync(process.execPath,
        [CLI, "run", "dev", "--", "sh", "-c", `echo changed > ${target}`],
        { cwd: root, encoding: "utf8" });
      assert.notEqual(run.status, 0, `${grant} wrote ${target}: ${run.stderr}`);
    }
  }
});

test("read = territory makes file explanation match what is kept", () => {
  const root = boxed("pre060-read-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "seisin.toml"), policy("src/**",
    'read = "territory"'));
  const cfg = loadConfig(join(root, "seisin.toml"));
  const kept = explainFileRead(cfg, "dev", join(root, "src", "x.js"));
  const home = explainFileRead(cfg, "dev", join(homedir(), "notes.txt"));
  assert.equal(kept.allowed, true);
  assert.equal(home.allowed, false);
  assert.equal(home.readTerritory, true);
  assert.ok(!inspect(cfg).warnings.some((w) => w.kind === "home-open"));
});

test("against the kernel: one explain matches six kinds of read", {
  skip: srtSkip(),
}, () => {
  const base = boxed("pre060-read-kernel-");
  const root = join(base, "repo");
  const shared = join(base, "shared.txt");
  const closed = join(base, "closed.txt");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".secrets"), { recursive: true });
  for (const [p, value] of [
    [join(root, "README.md"), "repo"], [join(root, "src", "a.js"), "territory"],
    [join(root, ".secrets", "k.txt"), "key"], [shared, "shared"], [closed, "closed"],
  ]) writeFileSync(p, value);
  writeFileSync(join(root, "seisin.toml"),
    `[runtime]\nread = "territory"\nwrites = []\n\n[keys]\ndir = ".secrets"\n\n` +
    `[roles.dev]\nwrites = ["src/**"]\nreads = [${JSON.stringify(shared)}]\nkeys = ["k.txt"]\nnetwork = []\n`);
  const cfg = loadConfig(join(root, "seisin.toml"));
  const routes = [
    join(root, "README.md"), join(root, "src", "a.js"), shared,
    join(root, ".secrets", "k.txt"), closed, join(homedir(), ".ssh"),
  ];
  for (const target of routes) {
    const verb = target.endsWith(".ssh") ? "ls" : "cat";
    const kernel = spawnSync(process.execPath,
      [CLI, "run", "dev", "--agent", "none", "--", verb, target],
      { cwd: root, encoding: "utf8" }).status === 0;
    assert.equal(explain(cfg, "dev", "read", target, root).allowed, kernel, target);
  }
});
