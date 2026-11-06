import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";
import * as publica from "../src/index.js";

test("the package entry point exposes policy decisions, not implementation internals", () => {
  for (const name of ["loadConfig", "explain", "ownersOf", "settingsFor", "inspect", "decide"])
    assert.equal(typeof api[name], "function", `${name} is part of the public API`);

  for (const name of ["RUNTIME_WRITES", "BASE_ENV", "DEFAULT_ENV", "SHAPES", "DEFAULT_IGNORE", "redactor"])
    assert.equal(Object.hasOwn(api, name), false, `${name} stays internal`);
});

test("the public API exposes decisions, not rendering", () => {
  // The line that makes the rest refactorable: what is not here is internal.
  assert.ok(publica.explain && publica.settingsFor && publica.inspect && publica.scan);
  assert.equal(publica.renderReport, undefined);
  assert.equal(publica.run, undefined);
});

test("the public surface can read the queue and cannot grant", () => {
  // The design's invariant, as a test: granting is not a tool call, so neither
  // settle nor applyGrant goes out through the public door.
  assert.ok(publica.pendingRequests && publica.grantFor);
  assert.equal(publica.settle, undefined);
  assert.equal(publica.applyGrant, undefined);
});
