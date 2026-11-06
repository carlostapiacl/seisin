/**
 * Loose credentials in a repo, and secrets in a run's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { scratch, seisinIn as seisin } from "./_tmp.js";
import { redactor } from "../src/redact.js";
import { scan } from "../src/scan.js";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { insideRepo, territoryRoots } from "../src/scan.js";
import { loadConfig } from "../src/config.js";
import { renderScan } from "../src/render.js";
import { once } from "node:events";

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

const TOKEN = (c) => "ghp_" + c.repeat(36) + "\n";

/* ── scan: nested checkouts ──────────────────────────────────────────── */

// A folder of projects that is not itself a repository — a multi-repo workspace.
function projects() {
  const box = scratch("seisin-scan-");
  assert.equal(insideRepo(box), false, "the scratch dir must not sit inside a checkout");
  mkdirSync(join(box, "app", ".git"), { recursive: true });
  writeFileSync(join(box, "app", "k.txt"), TOKEN("A"));
  mkdirSync(join(box, "wt"));
  writeFileSync(join(box, "wt", ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(box, "wt", "k.txt"), TOKEN("B"));
  writeFileSync(join(box, "seisin.toml"), `[roles.dev]\nwrites = ["app/**"]\n`);
  return box;
}

test("scan walks the checkouts when the root is not a repository", () => {
  const { hits, skipped, nestedPaths } = scan(projects(), []);
  assert.deepEqual(hits.map((h) => h.file).sort(), ["app/k.txt", "wt/k.txt"]);
  assert.equal(skipped.nested, 0);
  assert.deepEqual(nestedPaths, []);
});

test("scan still prunes checkouts nested inside a repository, and names them", () => {
  const box = projects();
  mkdirSync(join(box, ".git"));
  const { hits, skipped, nestedPaths } = scan(box, []);
  assert.deepEqual(hits, []);
  assert.equal(skipped.nested, 2);
  assert.deepEqual(nestedPaths.sort(), ["app", "wt"]);
  // …and from a subdirectory of that repository, too: its root is still inside one.
  mkdirSync(join(box, "sub", "inner", ".git"), { recursive: true });
  assert.equal(scan(join(box, "sub"), []).skipped.nested, 1);
});

test("a scan with pruned checkouts does not read as clean", () => {
  const text = renderScan({ certain: [], review: [], links: [], skipped: { nested: 2 }, nestedPaths: ["app", "wt"] }, []);
  assert.doesNotMatch(text, /nothing credential-shaped outside the declared directories/);
  assert.match(text, /nothing credential-shaped in what was scanned/);
  assert.match(text, /not scanned: 2 nested checkout\(s\)/);
  assert.match(text, /cd <dir> && seisin scan/);
  assert.match(text, /\n {4}app\n {4}wt\n/);
});

test("the CLI fails on a certain hit inside a checkout under a non-repo root", () => {
  // The policy's only territory is app/: by default the scan looks there, and
  // says so; --all walks the whole folder, wt/ included.
  const box = projects();
  const r = seisin(box, "scan");
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /1 credential\(s\)/);
  assert.match(r.stdout, /app\/k\.txt.*in dev's territory/);
  assert.match(r.stdout, /scanned: where the territories are — app/);
  const all = seisin(box, "scan", "--all");
  assert.equal(all.status, 1);
  assert.match(all.stdout, /2 credential\(s\)/);
  assert.doesNotMatch(all.stdout, /not scanned/);
});

/* ── scan follows the territories when the policy holds many repositories ── */

test("territoryRoots widens a territory to its repository and leaves the rest of the folder out", () => {
  const box = scratch("seisin-scope-");
  for (const d of ["a/.git", "a/src", "b/.git", "archive/old/.git", "loose/notes"]) mkdirSync(join(box, d), { recursive: true });
  writeFileSync(join(box, "a", ".env"), TOKEN("C"));            // repository root, outside the territory
  writeFileSync(join(box, "archive", "old", "k.txt"), TOKEN("D")); // no territory anywhere near
  writeFileSync(join(box, "loose", "notes", "k.txt"), TOKEN("E"));
  writeFileSync(join(box, "seisin.toml"),
    `[roles.dev]\nwrites = ["a/src/**", "loose/notes/**"]\n\n[roles.ops]\nwrites = ["b/**", "../elsewhere/**"]\n`);
  const cfg = loadConfig(join(box, "seisin.toml"));
  const roots = territoryRoots(cfg).map((r) => relative(realpathSync.native(box), realpathSync.native(r))).sort();
  assert.deepEqual(roots, ["a", "b", "loose/notes"]);
  const { hits } = scan(cfg.root, [], [], 500, { roots: territoryRoots(cfg) });
  assert.deepEqual(hits.map((h) => h.file).sort(), ["a/.env", "loose/notes/k.txt"]);
});

test("a checkout that holds a territory is walked even inside another root", () => {
  const box = scratch("seisin-scope-");
  for (const d of ["team/.git", "team/copies/w1/.git", "team/copies/w2/.git"]) mkdirSync(join(box, d), { recursive: true });
  writeFileSync(join(box, "team", "copies", "w1", "k.txt"), TOKEN("F"));
  writeFileSync(join(box, "team", "copies", "w2", "k.txt"), TOKEN("G"));
  writeFileSync(join(box, "seisin.toml"), `[roles.lead]\nwrites = ["team/board/**"]\n\n[roles.dev]\nwrites = ["team/copies/w1/**"]\n`);
  const cfg = loadConfig(join(box, "seisin.toml"));
  const r = scan(cfg.root, [], [], 500, { roots: territoryRoots(cfg) });
  assert.deepEqual(r.hits.map((h) => h.file), ["team/copies/w1/k.txt"], "w1 is a territory; w2 is someone's copy");
  assert.deepEqual(r.nestedPaths, ["team/copies/w2"]);
});

async function masked(secrets, chunks) {
  const stream = redactor(secrets);
  let text = "";
  stream.on("data", (c) => { text += c; });
  const done = once(stream, "end");
  for (const c of chunks) stream.write(c);
  stream.end();
  await done;
  return text;
}

test("overlapping credentials are masked identically at every byte split", async () => {
  for (const prefix of ["shared-prefix", "préfixe-étroit"]) {
    const secret = prefix + "-credential-0123456789";
    const bytes = Buffer.from(`before ${secret} after ${prefix} end`);
    for (let i = 0; i <= bytes.length; i++) {
      assert.equal(await masked([prefix, secret], [bytes.subarray(0, i), bytes.subarray(i)]),
        "before ‹redacted› after ‹redacted› end", `split ${i} of ${prefix}`);
    }
  }
});

test("redaction markers are output, never input to another credential replacement", async () => {
  const secret = "prefix-complete-synthetic-secret";
  const secrets = [secret, "redacted"];
  assert.equal(await masked(secrets, [secret + " redacted"]), "‹redacted› ‹redacted›");
  assert.equal(await masked(secrets, [secret, " finish"]), "‹redacted› finish");
});

test("the public redactor masks split credentials even when the caller gives an unsorted list", async () => {
  const secret = "synthetic-long-credential-for-test";
  const r = redactor(["short", secret, "", secret]);
  let output = "";
  r.on("data", (c) => { output += c; });
  const end = once(r, "end");
  for (const part of ["before ", secret.slice(0, 20), secret.slice(20), " after short"]) r.write(part);
  r.end();
  await end;
  assert.equal(output, "before ‹redacted› after ‹redacted›");
});

test("scan treats an absolute protected directory exactly like its relative spelling", () => {
  const root = scratch("seisin-audit-scan-");
  mkdirSync(join(root, ".secrets"));
  writeFileSync(join(root, ".secrets", "token.txt"), "ghp_" + "a".repeat(30));
  assert.deepEqual(scan(root, [join(root, ".secrets")]), scan(root, [".secrets"]));
  const alias = join(scratch("seisin-audit-alias-"), "repo");
  symlinkSync(root, alias);
  assert.deepEqual(scan(root, [join(alias, ".secrets")]), scan(root, [".secrets"]));
  assert.equal(scan(root).hits.filter((h) => h.level === "certain").length, 1);
});

/** Everything a redactor emits for these chunks, as one string. */
function through(r, chunks) {
  let out = "";
  r.setEncoding("utf8");
  r.on("data", (d) => (out += d));
  for (const c of chunks) r.write(c);
  r.end();
  return new Promise((done) => r.on("end", () => done(out)));
}

// ── redact: a chunk boundary inside a character ─────────────────────────────

test("a multibyte character split across chunks passes through intact", async () => {
  const bytes = Buffer.from("el año\n");
  const at = bytes.indexOf(0xc3) + 1;             // between the two bytes of ñ
  const out = await through(redactor(["no-aparece-nunca-1234"]), [bytes.subarray(0, at), bytes.subarray(at)]);
  assert.equal(out, "el año\n");
});

test("'año' split at byte 2 comes out whole", async () => {
  const bytes = Buffer.from("año");
  const out = await through(redactor(["otro-secreto-largo"]), [bytes.subarray(0, 2), bytes.subarray(2)]);
  assert.equal(out, "año");
});

test("a secret with a multibyte character, split inside it, is still masked", async () => {
  const secret = "contraseña-muy-larga-99";
  const bytes = Buffer.from(`la clave es ${secret} y nada más\n`);
  const at = bytes.indexOf(0xc3) + 1;
  const out = await through(redactor([secret]), [bytes.subarray(0, at), bytes.subarray(at)]);
  assert.ok(!out.includes(secret), out);
  assert.match(out, /‹redacted›/);
  assert.match(out, /nada más/);
});

test("an emoji at the cut is not split into two halves", async () => {
  const text = "x".repeat(40) + "😀" + "y".repeat(40);
  const chunks = [...Buffer.from(text)].map((b) => Buffer.from([b]));
  const out = await through(redactor(["s".repeat(30)]), chunks);
  assert.equal(out, text);
});

// ── scan: the cap never hides a certain finding ─────────────────────────────

test("certain findings after the review cap are still reported, and the cap says so", () => {
  const box = scratch("seisin-scan-");
  // Sorted first by readdir on every filesystem this runs on: "a" < "z".
  writeFileSync(join(box, "a-noise.py"),
    Array.from({ length: 30 }, (_, i) => `DB_PASSWORD_${i} = "literal-value-${i}-xxxx"`).join("\n"));
  writeFileSync(join(box, "z-token.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const { hits, truncated, omitted } = scan(box, [], [], 10);
  assert.equal(hits.filter((h) => h.level === "certain").length, 1);
  assert.equal(hits.filter((h) => h.level === "review").length, 10);
  assert.equal(truncated, true);
  assert.equal(omitted, 20);
});

test("a key directory written with a trailing slash is still not scanned", () => {
  const box = scratch("seisin-scan-");
  mkdirSync(join(box, ".secrets"));
  writeFileSync(join(box, ".secrets", "gh.txt"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  const { hits, skipped } = scan(box, [".secrets/"]);
  assert.deepEqual(hits, []);
  assert.equal(skipped.protectedDirs, 1);
});

test("scan resolves its root, so a link inside a linked root is not 'out of the repo'", () => {
  const real = scratch("seisin-scan-");
  mkdirSync(join(real, "tree"));
  writeFileSync(join(real, "tree", "a.txt"), "nada\n");
  symlinkSync(join(real, "tree", "a.txt"), join(real, "tree", "link"));
  const alias = join(scratch("seisin-scan-"), "alias");
  symlinkSync(join(real, "tree"), alias);
  const { hits } = scan(alias, []);
  assert.deepEqual(hits.filter((h) => h.level === "link"), []);
});

test("scan skips compiled python and nested checkouts, and counts the checkouts", () => {
  const box = scratch("seisin-scan-");
  writeFileSync(join(box, "mod.pyc"), "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  mkdirSync(join(box, "otro", ".git"), { recursive: true });
  writeFileSync(join(box, "otro", "k.txt"), "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\n");
  // A worktree: `.git` is a file, and it is still another checkout.
  mkdirSync(join(box, "wt"));
  writeFileSync(join(box, "wt", ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(box, "wt", "k.txt"), "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\n");
  // The root's own .git is not a reason to skip the root.
  mkdirSync(join(box, ".git"));
  writeFileSync(join(box, "own.txt"), "ghp_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\n");
  const { hits, skipped } = scan(box, []);
  assert.deepEqual(hits.map((h) => h.file), ["own.txt"]);
  assert.equal(skipped.nested, 2);
});
