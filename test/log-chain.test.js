/**
 * The log's hash chain (`prev` on every line) and `seisin log verify`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { append, verifyChain, GENESIS } from "../src/log.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX = join(HERE, ".sandbox-box");

function logFile() {
  mkdirSync(BOX, { recursive: true });
  return join(mkdtempSync(join(BOX, "chain-")), ".seisin", "log.jsonl");
}
const write = (f, n) => { for (let i = 0; i < n; i++) append(f, { role: "r", action: "write", target: `t${i}`, verdict: "denied" }); };

test("a fresh log chains from genesis and verifies", () => {
  const f = logFile();
  write(f, 5);
  const lines = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].prev, GENESIS);
  assert.deepEqual(verifyChain(f), { lines: 5, unchained: 0, chained: 5, breaks: [] });
});

test("an edited line breaks the chain on the line after it", () => {
  const f = logFile();
  write(f, 5);
  const lines = readFileSync(f, "utf8").split("\n");
  lines[2] = lines[2].replace('"denied"', '"allowed"');        // the kind of edit that would matter
  writeFileSync(f, lines.join("\n"));
  const r = verifyChain(f);
  assert.equal(r.breaks.length, 1);
  assert.equal(r.breaks[0].line, 4);
});

test("a removed line breaks it too", () => {
  const f = logFile();
  write(f, 5);
  const lines = readFileSync(f, "utf8").split("\n");
  lines.splice(1, 1);
  writeFileSync(f, lines.join("\n"));
  assert.equal(verifyChain(f).breaks.length, 1);
});

test("lines from before the chain are an unchained prefix, not tampering", () => {
  const f = logFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ at: "2026-09-01T00:00:00Z", role: "r", verdict: "denied" }) + "\n" +
    JSON.stringify({ at: "2026-09-02T00:00:00Z", role: "r", verdict: "denied" }) + "\n");
  write(f, 3);
  assert.deepEqual(verifyChain(f), { lines: 5, unchained: 2, chained: 3, breaks: [] });
});

test("several processes writing at once do not fork the chain", async () => {
  // A round runs several roles at once, each with its own parent writing here.
  const f = logFile();
  write(f, 1);
  const url = new URL("../src/log.js", import.meta.url).href;
  const one = (k) => new Promise((ok) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e",
      `import { append } from ${JSON.stringify(url)}; for (let i = 0; i < 40; i++) append(${JSON.stringify(f)}, { role: "p${k}", verdict: "denied", target: "t" + i });`]);
    p.on("close", ok);
  });
  await Promise.all([one(1), one(2), one(3), one(4)]);
  const r = verifyChain(f);
  assert.equal(r.lines, 161);
  assert.deepEqual(r.breaks, [], `the chain forked: ${JSON.stringify(r.breaks.slice(0, 3))}`);
});
