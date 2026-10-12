/**
 * The console is edited in ui/src/ and shipped as one file, ui/index.html.
 *
 * The shipped file is checked in, so the two can drift: an edit to the source
 * that nobody built, or a fix made straight in the deliverable that the next
 * build throws away. Either one fails here, with the command that fixes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build, OUT } from "../ui/build.js";

test("ui/index.html is what ui/src builds — after editing ui/src, run: npm run build:ui", () => {
  const built = build();
  const shipped = readFileSync(OUT, "utf8");
  if (built === shipped) return;
  const a = built.split("\n"), b = shipped.split("\n");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  assert.fail(`ui/index.html differs from the build of ui/src at line ${i + 1}:\n` +
    `  built:   ${JSON.stringify((a[i] ?? "").slice(0, 120))}\n` +
    `  shipped: ${JSON.stringify((b[i] ?? "").slice(0, 120))}\n` +
    "Edit ui/src/ and run `npm run build:ui`; never edit ui/index.html by hand.");
});

test("every inline marker is resolved, and only the deliverable ships", () => {
  assert.doesNotMatch(build(), /<!-- @inline /);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("ui/index.html"));
  assert.ok(!pkg.files.includes("ui"), "the whole ui/ folder ships, source and build script included");
});
