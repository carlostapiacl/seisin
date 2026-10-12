#!/usr/bin/env node
/**
 * Builds the console, ui/index.html, from its source in ui/src/.
 *
 * The console ships as one file on purpose: `seisin ui` serves it and nothing
 * else, and opened straight off the disk it still works as the example. What
 * was one file to edit too — 125 kB of markup, style and script — is kept
 * apart in ui/src/ (page.html, style.css, console.js) and put back together
 * here: each `<!-- @inline <name> -->` line of page.html is replaced by that
 * file, byte for byte. No bundler, no minifier, no dependency.
 *
 *   node ui/build.js           write ui/index.html
 *   node ui/build.js --check   exit 1 when ui/index.html is not what the source builds
 *
 * test/ui-build.test.js runs the check, so an edit to ui/src/ that was not
 * built — or an edit to ui/index.html that the source does not have — fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "src");
export const OUT = join(HERE, "index.html");

/** The deliverable, as the source builds it. */
export function build(src = SRC) {
  const page = readFileSync(join(src, "page.html"), "utf8");
  return page.replace(/^<!-- @inline ([\w.-]+) -->\n/gm, (_, name) => {
    const text = readFileSync(join(src, name), "utf8");
    if (!text.endsWith("\n")) throw new Error(`ui/src/${name} must end with a newline`);
    return text;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = build();
  if (process.argv.includes("--check")) {
    const ok = readFileSync(OUT, "utf8") === built;
    console.log(ok ? "ui/index.html is up to date" : "ui/index.html is stale: run node ui/build.js");
    process.exit(ok ? 0 : 1);
  }
  writeFileSync(OUT, built);
  console.log(`wrote ui/index.html (${Buffer.byteLength(built)} bytes)`);
}
