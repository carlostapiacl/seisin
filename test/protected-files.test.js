/**
 * What stays closed however wide a territory is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { inspect } from "../src/inspect.js";
import { settingsFor } from "../src/srt-settings.js";
import { boxed, CLI, sandboxSkip } from "./_tmp.js";

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
  skip: sandboxSkip(),
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
