/**
 * Walls and Denied say the same sentence of the same path.
 *
 * Measured on a real console: for a read of ~/.npmrc, Denied said "outside the
 * repository" (nothing to grant) and Walls said "add it to a role's keys" — it
 * told a person to hand an agent the file that holds the npm token. And a
 * protected path that also has an owner read "belongs to X" on Walls (ask the
 * owner) and "protected" on Denied (never granted). Two functions, two orders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { boxed } from "./_tmp.js";
import { loadConfig } from "../src/config.js";
import { describeWalls } from "../src/views.js";

const HTML = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");

/** The page's own functions, taken from its source and run as they are. */
function pageFns() {
  const grab = (name) => {
    const at = HTML.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} is not in the page`);
    let depth = 0, i = HTML.indexOf("{", at);
    for (let j = i; j < HTML.length; j++) {
      if (HTML[j] === "{") depth++;
      else if (HTML[j] === "}" && --depth === 0) return HTML.slice(at, j + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const src = ["unownedSays", "kindSays", "causeSays", "wallSays"].map(grab).join("\n");
  return new Function(`${src}; return { causeSays, wallSays };`)();
}

const CASES = [
  { name: "owned", about: "file", standing: "owned", owners: ["backend"] },
  { name: "protected with an owner", about: "file", standing: "protected", owners: ["backend"], why: ".git/hooks, run by git outside the sandbox" },
  { name: "protected", about: "file", standing: "protected", owners: [], why: ".claude, run by Claude Code outside the sandbox" },
  { name: "outside (~/.npmrc)", about: "file", standing: "outside", owners: [], why: "outside the repository, where no role's territory reaches",
    reason: `no role declares ${homedir()}/.npmrc — add "${homedir()}/.npmrc" to a role's keys` },
  { name: "unowned with a kind and hint", about: "file", standing: "unowned", owners: [], kind: "credential", hint: "never grant a write to it" },
  { name: "unowned ownable", about: "file", standing: "unowned", owners: [], kind: "territory", hint: "decide an owner" },
  { name: "unowned, kind without hint", about: "file", standing: "unowned", owners: [], kind: "temporary" },
  { name: "unowned, nothing else", about: "file", standing: "unowned", owners: [] },
  { name: "network", about: "network", owners: [] },
  { name: "MCP tool", about: "tool", owners: [] },
  { name: "key", about: "key", owners: [] },
];

test("Walls says exactly what Denied says, for every kind of path", () => {
  const { causeSays, wallSays } = pageFns();
  for (const c of CASES) assert.equal(wallSays(c), causeSays(c), c.name);
});

test("nothing on Walls tells a person to grant ~/.npmrc, or to ask the owner of a protected path", () => {
  const { wallSays } = pageFns();
  const npmrc = CASES.find((c) => c.name.startsWith("outside"));
  assert.doesNotMatch(wallSays(npmrc), /keys|declares/);
  assert.match(wallSays(npmrc), /outside the repository/);
  const prot = CASES.find((c) => c.name === "protected with an owner");
  assert.match(wallSays(prot), /^protected/);
  for (const c of CASES) assert.doesNotMatch(wallSays(c), / — $| —$/, `${c.name}: a dangling dash`);
});

test("the server gives every file wall its standing, owned or not", () => {
  const box = boxed("seisin-walls-");
  mkdirSync(join(box, "api", ".git", "hooks"), { recursive: true });
  writeFileSync(join(box, "seisin.toml"), '[roles.backend]\nwrites = ["api/**"]\n\n[roles.frontend]\nwrites = ["web/**"]\n');
  const cfg = loadConfig(join(box, "seisin.toml"));
  const wall = (target, owners) => ({ action: "write", target, times: 3, owners });
  const out = describeWalls(cfg, { frontend: [wall("api/.git/hooks/pre-commit", ["backend"]), wall(join(homedir(), ".npmrc"), [])] },
    [{ role: "frontend", action: "write", target: "api/.git/hooks/pre-commit", verdict: "denied", kind: "file" },
     { role: "frontend", action: "write", target: join(homedir(), ".npmrc"), verdict: "denied", kind: "file" }]);
  const [hook, npmrc] = out.frontend;
  assert.equal(hook.standing, "protected", "a protected path with an owner is still protected");
  assert.equal(npmrc.standing, "outside");
});
