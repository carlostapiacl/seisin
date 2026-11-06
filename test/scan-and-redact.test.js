/**
 * Loose credentials in a repo, and secrets in a run's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { redactor } from "../src/redact.js";
import { scan } from "../src/scan.js";

test("a secret split across two chunks is still masked", () => {
  // The first implementation masked only the part about to be emitted, so a
  // value straddling the cut left in two innocent halves. Caught on first run.
  const r = redactor(["tok-super-secreto-1234"]);
  let out = "";
  r.on("data", (d) => (out += d));
  r.write("the token is tok-super-");
  r.write("secreto-1234 and on\n");
  r.end();
  return new Promise((done) => r.on("end", () => {
    assert.ok(!out.includes("tok-super-secreto-1234"));
    assert.match(out, /‹redacted›/);
    done();
  }));
});

test("scan reports loose credentials and skips the protected directory", () => {
  const box = scratch("seisin-scan-");
  mkdirSync(join(box, ".secrets"), { recursive: true });
  writeFileSync(join(box, ".secrets", "ok.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(box, "loose.env"), "API_TOKEN=abcdefghijklmnop\n");
  writeFileSync(join(box, "fine.env"), "API_TOKEN=changeme\n");
  const { hits } = scan(box, [".secrets"]);
  rmSync(box, { recursive: true, force: true });
  assert.deepEqual(hits.map((h) => h.file), ["loose.env"]);
});

test("a value read from the environment is not a finding", () => {
  // Measured on a real tree: 46 of 159 loose findings were exactly this, so the
  // scanner was flagging the correct way to handle a secret.
  const box = scratch("seisin-scan-");
  writeFileSync(join(box, "good.py"), 'API_TOKEN = os.environ["API_TOKEN"]\n');
  writeFileSync(join(box, "good.ts"), "const API_TOKEN = process.env.API_TOKEN;\n");
  writeFileSync(join(box, "bad.env"), "API_TOKEN=abcdefghijklmnop\n");
  const { hits, skipped } = scan(box, []);
  rmSync(box, { recursive: true, force: true });
  // Assert the outcome, not the counter. Only one of the two good lines reaches
  // the reference check at all — `os.environ[` stops at the quote and falls
  // under the length floor — and both are correctly absent either way.
  assert.deepEqual(hits.map((h) => h.file), ["bad.env"]);
  assert.ok(skipped.reference >= 1);
});

test("findings are split by how much the shape alone proves", () => {
  const box = scratch("seisin-scan-");
  writeFileSync(join(box, "issued.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(box, "maybe.env"), "DB_PASSWORD=hunter2hunter2hunter2\n");
  const { hits } = scan(box, []);
  rmSync(box, { recursive: true, force: true });
  assert.deepEqual(hits.filter((h) => h.level === "certain").map((h) => h.file), ["issued.txt"]);
  assert.deepEqual(hits.filter((h) => h.level === "review").map((h) => h.file), ["maybe.env"]);
});

test("caches and .bak copies are ignored by default", () => {
  // Both were most of the noise in the first real run: a scraped page carrying
  // someone else's API key, and one config repeated across five backups.
  const box = scratch("seisin-scan-");
  mkdirSync(join(box, "_cache"), { recursive: true });
  writeFileSync(join(box, "_cache", "page.html"), "AIzaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  writeFileSync(join(box, "settings.json.bak-2026"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const { hits } = scan(box, []);
  rmSync(box, { recursive: true, force: true });
  assert.deepEqual(hits, []);
});

test("scan reports a symlink that leaves the repo, and does not open it", (t) => {
  // scan is the command that answers "do I have credentials outside the
  // declared directories?", and a link is the only way a credential can be in
  // the tree without being a file of the tree. It was skipped silently because
  // a symlink is not isFile().
  const box = scratch("seisin-sl-");
  const outside = scratch("seisin-out-");
  t.after(() => { rmSync(box, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(outside, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  mkdirSync(join(box, "src"), { recursive: true });
  symlinkSync(join(outside, "id_rsa"), join(box, "src", "suelto"));

  const { hits } = scan(box, [], undefined);
  const link = hits.find((h) => h.level === "link");
  assert.ok(link, "the symlink was not reported");
  assert.match(link.file, /suelto/);
  assert.match(link.shape, /id_rsa/);        // names the target
  assert.ok(!/BEGIN OPENSSH/.test(JSON.stringify(hits)), "it read the target");
});
