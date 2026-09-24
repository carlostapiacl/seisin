/**
 * The console's recoverable link (`uilink.js`) and that a busy port rejects
 * with a code `seisin ui` can act on.
 *
 * The token never travels in an HTTP response; the only recovery channel is a
 * user-only file. These fix its two properties: it round-trips, and a file left
 * by a crashed run reads as stale rather than as a running console.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { writeUiLink, readUiLink, clearUiLink } from "../src/uilink.js";
import { serve } from "../src/serve.js";
import { RUNS_NAME } from "../src/rundir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOX = join(HERE, ".sandbox-box");
function base() {
  mkdirSync(BOX, { recursive: true });
  return mkdtempSync(join(BOX, "uilink-"));
}
const URL_ = "http://127.0.0.1:4178/#t=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

test("a link round-trips, and its writer reads as alive", () => {
  const b = base();
  writeUiLink(4178, URL_, b);
  const found = readUiLink(4178, b);
  assert.equal(found.url, URL_);
  assert.equal(found.alive, true, "this process wrote it, so it is alive");
});

test("the file is user-only and lives under the runs root", () => {
  const b = base();
  writeUiLink(4178, URL_, b);
  const f = join(b, RUNS_NAME, "ui-4178.url");
  assert.ok(existsSync(f), "written where readUiLink looks");
  assert.equal(statSync(f).mode & 0o777, 0o600, "0600, nobody else's to read");
});

test("a record from a dead process reads as stale, not as a console", () => {
  const b = base();
  // A pid that is not running. 0x7fffffff is above any real pid on these OSes.
  mkdirSync(join(b, RUNS_NAME), { recursive: true, mode: 0o700 });
  writeFileSync(join(b, RUNS_NAME, "ui-4178.url"), JSON.stringify({ url: URL_, pid: 0x7fffffff }) + "\n");
  const found = readUiLink(4178, b);
  assert.equal(found.url, URL_);
  assert.equal(found.alive, false, "its writer is gone");
});

test("no record reads as null; clearing removes it", () => {
  const b = base();
  assert.equal(readUiLink(4178, b), null);
  writeUiLink(4178, URL_, b);
  assert.notEqual(readUiLink(4178, b), null);
  clearUiLink(4178, b);
  assert.equal(readUiLink(4178, b), null);
});

test("a malformed record is null, never a throw", () => {
  const b = base();
  mkdirSync(join(b, RUNS_NAME), { recursive: true, mode: 0o700 });
  writeFileSync(join(b, RUNS_NAME, "ui-4178.url"), "not json\n");
  assert.equal(readUiLink(4178, b), null);
});

test("the port is per-link: another port has no record", () => {
  const b = base();
  writeUiLink(4178, URL_, b);
  assert.equal(readUiLink(4179, b), null);
});

test("a busy port rejects with a code seisin ui can act on", async () => {
  // Needs a config file for serve() to load; an empty policy is enough.
  const b = base();
  const cfg = join(b, "seisin.toml");
  writeFileSync(cfg, '[roles.a]\nwrites = ["a/**"]\n');
  const first = await serve(cfg, 0);
  const port = first.address().port;
  try {
    await assert.rejects(() => serve(cfg, port), (e) => e.code === "EADDRINUSE");
  } finally {
    first.close();
  }
});
