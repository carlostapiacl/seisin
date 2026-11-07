/**
 * How the modules in src/ import each other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function graph() {
  const g = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".js")) {
        const text = readFileSync(path, "utf8");
        const deps = [...text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"(\.[^"]+)"/gms)]
          .map((m) => join(dirname(path), m[1]));
        g.set(path, deps);
      }
    }
  };
  walk(SRC);
  return g;
}

/** Every set of modules that import their way back to themselves (Tarjan). */
function cycles(g) {
  let next = 0;
  const index = new Map(), low = new Map(), stack = [], on = new Set(), found = [];
  const visit = (v) => {
    index.set(v, next); low.set(v, next); next++;
    stack.push(v); on.add(v);
    for (const w of g.get(v) ?? []) {
      if (!g.has(w)) continue;
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const group = [];
      let w;
      do { w = stack.pop(); on.delete(w); group.push(relative(SRC, w)); } while (w !== v);
      if (group.length > 1) found.push(group.sort());
    }
  };
  for (const v of g.keys()) if (!index.has(v)) visit(v);
  return found;
}

test("no module in src/ imports its way back to itself", () => {
  // A loop decides which module is evaluated first by the order someone
  // happened to import them in, and a constant read at load time comes out
  // undefined in whichever one loses.
  assert.deepEqual(cycles(graph()), []);
});

test("the check sees a loop when there is one", () => {
  const g = new Map([["/a.js", ["/b.js"]], ["/b.js", ["/c.js"]], ["/c.js", ["/a.js"]], ["/d.js", ["/a.js"]]]);
  assert.equal(cycles(g).length, 1);
  assert.equal(cycles(g)[0].length, 3);
});
