#!/usr/bin/env node
/**
 * docs/img/console.gif, recorded from the console's own example.
 *
 *   PLAYWRIGHT=<path to a playwright-core package> node docs/console-gif.mjs
 *
 * Needs a Chromium that playwright-core can launch (`npx playwright install
 * chromium`, or any Chrome named in CHROMIUM=<executable>) and ffmpeg. Neither is a dependency of seisin: this is run by
 * hand, when the console changes.
 *
 * The page is ui/index.html opened as a file, so there is no server, no repo
 * and no token: what it shows is the example (ui/demo.js), made-up runs
 * computed by the server's own code. A script rather than a hand recording,
 * like docs/demo.tape, so the GIF is regenerated, not re-shot, and says what
 * the console says.
 */
import { mkdtempSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(join(HERE, "..", "ui", "index.html")).href;
const OUT = join(HERE, "img", "console.gif");
const { chromium } = await import(process.env.PLAYWRIGHT ? pathToFileURL(join(process.env.PLAYWRIGHT, "index.mjs")).href : "playwright-core");

const frames = mkdtempSync(join(tmpdir(), "seisin-console-gif-"));
let n = 0;
/** One frame, held `seconds` in the GIF. */
const shots = [];
async function shot(page, seconds) {
  const file = join(frames, `${String(++n).padStart(3, "0")}.png`);
  await page.screenshot({ path: file });
  shots.push({ file, seconds });
}

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: "dark" });
const go = async (hash) => { await page.goto(`${PAGE}#${hash}`); await page.waitForTimeout(400); };

// 1. The Overview: whether the boundary held, every role, what needs a person.
await go("overview");
await shot(page, 3);
await page.locator("#at-list").scrollIntoViewIfNeeded();
await shot(page, 3);

// 2. A role's page: what it may do, and the request it left, with Grant.
await go("role/frontend");
await shot(page, 3);
await page.locator("#why-0").fill("frontend owns the orders view now");
await page.locator('button[data-n="0"][data-d="granted"]').click();
await page.waitForTimeout(200);
await shot(page, 3);   // the second click, because src/api/** is another role's

// 3. One of its runs, opened in place: the canary, each denial once, the policy it held under.
await page.goto(`${PAGE}?v=1#role/frontend/run/r03-frontend`);
await page.waitForTimeout(600);
await page.locator(".tl-list").first().scrollIntoViewIfNeeded();
await page.locator(".tl-held summary").first().click();
await page.waitForTimeout(200);
await shot(page, 4);

// 4. Every run, and the policy with its control files.
await go("runs");
await shot(page, 2.5);
await go("policy");
await shot(page, 2.5);

await browser.close();

// A palette made from the frames themselves, so the text stays sharp; each
// frame held as long as it was asked to.
const list = join(frames, "frames.txt");
const { writeFileSync } = await import("node:fs");
writeFileSync(list, shots.map((s) => `file '${s.file}'\nduration ${s.seconds}`).join("\n") + `\nfile '${shots.at(-1).file}'\n`);
const tmp = join(frames, "console.gif");
const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
  "-vf", "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none",
  "-loop", "0", tmp], { stdio: "inherit" });
if (ff.status !== 0) process.exit(ff.status ?? 1);
renameSync(tmp, OUT);
console.log(`wrote docs/img/console.gif from ${readdirSync(frames).filter((f) => f.endsWith(".png")).length} frames`);
