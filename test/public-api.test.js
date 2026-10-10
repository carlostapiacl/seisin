import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

test("the package entry point exposes policy decisions, not implementation internals", () => {
  for (const name of ["loadConfig", "explain", "ownersOf", "settingsFor", "inspect", "decide"])
    assert.equal(typeof api[name], "function", `${name} is part of the public API`);

  for (const name of ["RUNTIME_WRITES", "BASE_ENV", "DEFAULT_ENV", "SHAPES", "DEFAULT_IGNORE", "redactor"])
    assert.equal(Object.hasOwn(api, name), false, `${name} stays internal`);
});
