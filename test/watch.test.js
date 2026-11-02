/** `seisin watch` follows the log: a line that reaches the file in two pieces is shown once, whole. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxed } from "./_tmp.js";
import { watch } from "../src/commands/log.js";
import { logPath } from "../src/log.js";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test("a log line written in two pieces is shown once it is whole", async (t) => {
  const root = boxed("watch-");
  const file = logPath(root);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "");
  const printed = [];
  t.mock.method(process.stdout, "write", (s) => { printed.push(String(s)); return true; });
  const watching = watch({ root }, { interval: 20 });
  try {
    appendFileSync(file, '{"at":"2026-11-02T10:00:00.000Z","role":"dev","action":"write",');
    await tick(120);
    appendFileSync(file, '"target":"src/ñandú.ts","verdict":"denied"}\n');
    await tick(120);
  } finally {
    watching.stop();
    t.mock.restoreAll();
  }
  const said = printed.join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal((said.match(/src\/ñandú\.ts/g) ?? []).length, 1, said);
  assert.match(said, /denied/);
});
