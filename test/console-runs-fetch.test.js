/**
 * The console reads the runs one request at a time.
 *
 * Over a directory of a thousand runs the server takes seconds per view and answers one request
 * after another. Opening a role while the 2-second poll was asking again for the view being left
 * sent the same role's view twice (measured: 11.5 s, then 23.5 s for the second), so the page took
 * twice as long as the server needed. These run the console's own fetchRuns, out of its source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ui", "src", "console.js"), "utf8");
const from = SRC.indexOf("  var RFILTER = (function(){");
const to = SRC.indexOf("  function runMeta(r){");

function consoleWith(fetchImpl, hash = "#role/executor") {
  assert.ok(from > 0 && to > from, "the runs reader is where this test expects it in ui/src/console.js");
  const ctx = vm.createContext({
    location: { search: "", hash }, URLSearchParams, Promise,
    ROLE: "executor", LIVE: true, DEMO_SHIFTED: null, TOKEN: "t", fetch: fetchImpl,
  });
  vm.runInContext(SRC.slice(from, to) + "\nthis.fetchRuns = fetchRuns; this.inFlight = function(){ return RFLIGHT; };", ctx);
  return ctx;
}

const reply = (status, body, etag = '"e1"') => ({
  status, ok: status === 200, headers: { get: () => etag }, json: async () => body,
});

test("two reads of the same view while one is on its way are one request", async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const c = consoleWith(async (url, opts) => { calls.push({ url, opts }); await gate; return reply(200, { total: 1 }); });
  const a = c.fetchRuns(true);
  const b = c.fetchRuns(true);
  release();
  const [ga, gb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1, "the second read waited for the first");
  assert.equal(calls[0].url, "/api/runs?srole=executor");
  assert.deepEqual(ga.v, { total: 1 });
  assert.deepEqual(gb.v, { total: 1 });
  assert.equal(c.inFlight(), null, "nothing is left on its way once it answered");
});

test("a page that wants the view still gets it when the read on its way was the poll's 'did it move'", async () => {
  let n = 0;
  const c = consoleWith(async () => (++n === 1 ? reply(200, { total: 7 }) : reply(304, null)));
  assert.deepEqual((await c.fetchRuns(true)).v, { total: 7 });
  const poll = c.fetchRuns(false);          // conditional: the server answers 304
  const page = c.fetchRuns(true);           // a redraw that needs the view, while the poll is out
  assert.equal((await poll).same, true);
  assert.deepEqual((await page).v, { total: 7 }, "the view it already had, not nothing");
  assert.equal(n, 2);
});

test("a different view is its own request", async () => {
  const urls = [];
  const c = consoleWith(async (url) => { urls.push(url); return reply(200, {}); });
  c.location.hash = "#overview";
  const a = c.fetchRuns(true);
  c.location.hash = "#role/executor";
  const b = c.fetchRuns(true);
  await Promise.all([a, b]);
  assert.deepEqual(urls, ["/api/runs", "/api/runs?srole=executor"]);
});
