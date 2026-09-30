/**
 * Small roadmap items, each with the case that shows it and the one that must
 * stay quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "../src/inspect.js";
import { wire, hookEntries } from "../src/commands/wire.js";
import { TOOL_MATCHER } from "../src/hook.js";
import { scratch } from "./_tmp.js";

const silently = (fn) => {
  const w = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = w; }
};

function repoWith(settings) {
  const root = scratch("seisin-rs-");
  if (settings) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  }
  return {
    root, path: join(root, "seisin.toml"), keyDirs: [], allowedDomains: [],
    roles: { dev: { name: "dev", writes: ["src/**"], keys: [], network: null } },
  };
}

const kinds = (cfg) => inspect(cfg, null, "x").warnings.map((w) => w.kind);

test("check says when the hook was wired with the pre-0.5.0 matcher \"*\"", () => {
  // Wired before 0.5.0: every event is there, PreToolUse just runs on every tool.
  const old = hookEntries();
  old.PreToolUse[0].matcher = "*";
  const cfg = repoWith({ hooks: old });

  assert.ok(kinds(cfg).includes("hook-matcher-broad"));
  assert.ok(!kinds(cfg).includes("hook-not-wired"), "it is wired — only broadly");
  const w = inspect(cfg, null, "x").warnings.find((x) => x.kind === "hook-matcher-broad");
  assert.match(w.detail, /seisin wire/);

  // and `seisin wire` is what makes it go away
  assert.equal(silently(() => wire(cfg)).changed, true);
  const pre = JSON.parse(readFileSync(join(cfg.root, ".claude", "settings.json"), "utf8")).hooks.PreToolUse;
  assert.equal(pre[0].matcher, TOOL_MATCHER);
  assert.ok(!kinds(cfg).includes("hook-matcher-broad"));
});

test("check stays quiet about the matcher when it is narrow, missing, or not only ours", () => {
  // freshly wired
  assert.ok(!kinds(repoWith({ hooks: hookEntries() })).includes("hook-matcher-broad"));
  // not wired at all: that is hook-not-wired's to say, not this one's
  const bare = kinds(repoWith(null));
  assert.ok(bare.includes("hook-not-wired") && !bare.includes("hook-matcher-broad"));
  // a "*" entry that also runs somebody else's command: `wire` will not narrow
  // it, so check must not tell anyone to run `wire` for it
  const shared = hookEntries();
  shared.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: "seisin hook" }, { type: "command", command: "their-linter" }] }];
  assert.ok(!kinds(repoWith({ hooks: shared })).includes("hook-matcher-broad"));
});
