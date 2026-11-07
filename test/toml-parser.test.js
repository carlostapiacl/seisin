/**
 * What the policy's parser accepts, refuses and never invents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, loadConfig } from "../src/config.js";
import { tomlString, tomlName } from "../src/layout.js";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scratch, policyFrom as policy } from "./_tmp.js";

test("a quoted value keeps its first character", () => {
  // Regression. The first parser chained two slices and turned ".secrets" into
  // "secrets". Nothing failed loudly: denyRead pointed at a path that did not
  // exist, so every key stayed readable by every role. A permission tool that
  // is wrong in this direction is worse than no tool, so this test exists.
  assert.equal(parseToml('[keys]\ndir = ".secrets"').keys.dir, ".secrets");
  assert.equal(parseToml('[keys]\ndir = "..hidden"').keys.dir, "..hidden");
});

test("a comment inside a string is not a comment", () => {
  assert.deepEqual(parseToml('[roles.a]\nwrites = ["a#b.ts"]').roles.a.writes, ["a#b.ts"]);
});

test("an array may span several lines", () => {
  const t = parseToml('[roles.a]\nwrites = [\n  "one",\n  "two"\n]');
  assert.deepEqual(t.roles.a.writes, ["one", "two"]);
});

test("unreadable input names its line", () => {
  assert.throws(() => parseToml("[roles.a]\nwrites = one"), /:2:/);
});

test("malformed input is an error, never a guess", () => {
  // The old reader pulled the strings out with a regex and ignored whatever
  // sat between them: ["a" BASURA "b"] gave ["a","b"], and an unclosed quote
  // gave "". A permissions file half understood is worse than one refused,
  // because the half that was dropped is the half you meant to write.
  const bad = [
    'writes = ["a" BASURA "b"]',
    'writes = ["a" "b"]',
    'writes = ["a", , "b"]',
    'writes = [, "a"]',
    'dir = "a" basura',
    'dir = "sin cerrar',
    'writes = ["a", "b"',
    "writes = [a, b]",
  ];
  for (const src of bad)
    assert.throws(() => parseToml(src), /seisin\.toml:\d+:/, `accepted: ${src}`);
});

test("everything the subset actually supports still parses", () => {
  assert.deepEqual(parseToml('writes = ["a", "b"]').writes, ["a", "b"]);
  assert.deepEqual(parseToml('writes = ["a", "b",]').writes, ["a", "b"]);   // trailing comma
  assert.deepEqual(parseToml("writes = []").writes, []);
  assert.deepEqual(parseToml('writes = [ "a" ,  "b" ]').writes, ["a", "b"]);
  assert.equal(parseToml('dir = ".secrets"').dir, ".secrets");              // regression: the double slice
  assert.equal(parseToml("redact = false").redact, false);
  // A `#` inside quotes is not a comment.
  assert.equal(parseToml('dir = "a#b"').dir, "a#b");
});

test("no input makes the parser lose or invent an item", () => {
  // Property-based, small and deterministic: for any list of plausible paths,
  // what goes in is what comes out — or it is refused. Never half.
  const pieces = ["src/**", "a b/c", ".env", "x", "a.b.c", "..", "*/", "#no-comentario"];
  for (let n = 0; n <= pieces.length; n++) {
    const items = pieces.slice(0, n);
    const src = `writes = [${items.map((s) => `"${s}"`).join(", ")}]`;
    assert.deepEqual(parseToml(src).writes, items, src);
  }
});

test("a policy cannot be cancelled further down the file", () => {
  // "Last one wins" is TOML-ish and wrong here: a policy can look restrictive
  // at the top and be cancelled forty lines down, and whoever reviews it reads
  // the first block.
  assert.throws(() => parseToml('[roles.a]\nwrites = ["src/**"]\n\n[roles.a]\nwrites = ["**"]\n'),
    /appears twice/);
  assert.throws(() => parseToml('[roles.a]\nwrites = ["src/**"]\nwrites = ["**"]\n'),
    /set twice/);
  // two different roles with the same field are still normal
  assert.ok(parseToml('[roles.a]\nwrites = []\n\n[roles.b]\nwrites = []\n'));
});

test("a table named __proto__ cannot hand its settings to every other role", () => {
  // The worst kind: invisible when a person reviews it. [roles.__proto__] does
  // not appear in Object.keys(roles), so `check` prints the roles that exist and
  // says nothing — while every one of them inherits what that table declared. A
  // config that reads `[roles.frontend]` with no writes came out of the parser
  // owning the whole repo and holding GITHUB_TOKEN.
  for (const name of ["__proto__", "prototype", "constructor"])
    assert.throws(() => parseToml(`[roles.${name}]\nwrites = ["**"]\n`), /reserved name/, name);
  assert.throws(() => parseToml('[roles.a]\nconstructor = ["x"]\n'), /reserved name/);

  // And the global prototype is intact after all those attempts.
  assert.equal({}.writes, undefined);
  assert.deepEqual(Object.keys(parseToml('[roles.a]\nwrites = ["src/**"]\nkeys = []\n').roles), ["a"]);
});

test("a role never inherits a setting it did not write down", (t) => {
  // The second defense, alone. If a name ever slips through, loadConfig still
  // reads only own properties: two independent brakes, because what they prevent
  // is invisible — the file reads one way and the policy is another.
  Object.prototype.writes = ["**"];
  Object.prototype.env = ["GITHUB_TOKEN"];
  t.after(() => { delete Object.prototype.writes; delete Object.prototype.env; });

  const box = scratch("seisin-pp-");
  t.after(() => rmSync(box, { recursive: true, force: true }));
  writeFileSync(join(box, "seisin.toml"), "[roles.frontend]\nkeys = []\n");

  const c = loadConfig(join(box, "seisin.toml"));
  assert.deepEqual(c.roles.frontend.writes, []);
  assert.deepEqual(c.roles.frontend.env, []);
});

test("one rule decides what can be written into the config, everywhere", () => {
  // applyGrant checked it, init did not, and renderObserved built lines from
  // targets in the log — text the agent chose.
  assert.throws(() => tomlString('src/x"'), /no way to represent/);
  assert.throws(() => tomlString("src/x\n[roles.b]"), /no way to represent/);
  assert.equal(tomlString("src/web/**"), '"src/web/**"');
  assert.throws(() => tomlName("a b"), /letters, digits/);
  assert.equal(tomlName("dev-plat"), "dev-plat");
});

test("a role name with a dot is a typo, and says so at config time", (t) => {
  // In TOML a dot separates keys, so [roles.mimo-v2.5-free-1] declares a role
  // named "mimo-v2". `check` printed a list of plausible names without
  // complaining and the failure arrived later as `unknown role`. Fifteen of
  // someone's eighteen runs died of this; the three that survived were the
  // names without a dot. There is no ambiguity to preserve: a table nested
  // under [roles] means nothing here.
  const box = scratch("seisin-dot-");
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const f = join(box, "seisin.toml");

  writeFileSync(f, '[roles.mimo-v2.5-free-1]\nwrites = ["x/**"]\nkeys = []\n');
  assert.throws(() => loadConfig(f), /not "mimo-v2\.5-free-1"/);
  assert.throws(() => loadConfig(f), /mimo-v2-5-free-1/);   // suggests the name that does work

  writeFileSync(f, '[roles.mimo-v2-5-free-1]\nwrites = ["x/**"]\nkeys = []\n');
  assert.deepEqual(Object.keys(loadConfig(f).roles), ["mimo-v2-5-free-1"]);
});

test("SEC-05 a later [roles] cannot replace a role declared above it", () => {
  // Before: `a = true` in a [roles] written further down replaced the whole role;
  // its `network = []` came back as "not said" = the global list. check: exit 0.
  const box = scratch("seisin-sec05-");
  const load = (toml) => { writeFileSync(join(box, "seisin.toml"), toml); return () => loadConfig(join(box, "seisin.toml")); };
  const role = '[network]\nallow = ["evil.com"]\n\n[roles.a]\nwrites = ["src/**"]\nnetwork = []\n';
  assert.throws(load(role + '\n[roles]\na = true\n'), /already the table \[roles\.a\]/);
  assert.throws(load(role + '\n[roles]\na = []\n'), /already the table/);
  assert.throws(load('[roles]\na = "x"\n\n[roles.a]\nwrites = ["src/**"]\n'), /:4: .*already a value, not a table/);
  assert.throws(load('roles = "x"\n'), /"roles" must be tables/);
  assert.throws(load('roles = ["src/**"]\n'), /"roles" must be tables/);
  assert.throws(load('[roles]\nvalueOf = 1\n'), /a role is a table/);
  // the legitimate form still loads: the parent table declared later, with no keys
  assert.deepEqual(load(role + '\n[roles]\n')().roles.a.network, []);
});

/**
 * A time budget that follows the machine: `ms` on an idle one, and under load
 * `factor` times what a linear pass takes right now — measured here, so load
 * moves both. Anything super-linear still blows through it; a busy CI runner
 * no longer fails a parser that is fine.
 */
function budget(ms, factor, linear) {
  const t0 = performance.now();
  linear();
  return Math.max(ms, factor * (performance.now() - t0));
}

test("an unclosed multi-line array is refused quickly", () => {
  const box = scratch("seisin-long-");
  const text = '[roles.a]\nwrites = [\n' + '  "x",\n'.repeat(100_000);
  writeFileSync(join(box, "seisin.toml"), text);
  // Baseline: read the same file and walk its lines once each — what any
  // parser has to do at least.
  const limit = budget(2000, 20, () => {
    for (let i = 0; i < 3; i++)
      readFileSync(join(box, "seisin.toml"), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^"/.test(l));
  });
  const t0 = performance.now();
  assert.throws(() => loadConfig(join(box, "seisin.toml")));
  const took = performance.now() - t0;
  assert.ok(took < limit, `took ${Math.round(took)} ms, budget ${Math.round(limit)} ms`);
});

test("SEC-14 role names that differ only in case are refused", () => {
  const dir = scratch("seisin-case-");
  writeFileSync(join(dir, "seisin.toml"), '[roles.dev]\nwrites = ["a/**"]\n\n[roles.Dev]\nwrites = ["b/**"]\n');
  assert.throws(() => loadConfig(join(dir, "seisin.toml")), /differ only in case/);
});

// ── config: nothing outside the roles is ignored silently ───────────────────

test("a misspelt [runtime] setting is refused with its line", () => {
  assert.throws(() => policy(`[runtime]\nisolaet = true\n\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:2: \[runtime\] "isolaet" is not a setting .*did you mean "isolate"/);
});

test("an unknown table or root key is refused with its line", () => {
  assert.throws(() => policy(`[roles.a]\nwrites = ["a/**"]\n\n[netwrok]\nallow = []\n`),
    /seisin\.toml:4: "netwrok" is not a setting or a table .*did you mean "network"/);
  assert.throws(() => policy(`isolate = true\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:1: "isolate" is not a setting/);
  assert.throws(() => policy(`[keys.providers.k]\ncommand = ["x", "{ref}"]\nmodo = "env"\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:3: \[keys\.providers\.k\] "modo"/);
  assert.throws(() => policy(`[notify]\nurl_fiel = ".secrets/x"\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:2: \[notify\] "url_fiel"/);
  assert.throws(() => policy(`[runtime.isolate]\nx = true\n[roles.a]\nwrites = ["a/**"]\n`),
    /seisin\.toml:1: \[runtime\.isolate\] is a table/);
});

test("every setting the docs name still loads", () => {
  const cfg = policy(`
[keys]
dir = ".secrets/"
[keys.providers.k]
command = ["x", "{ref}"]
mode = "env"
[network]
allow = "github.com"
[runtime]
writes = []
isolate = "credentials"
redact = false
[scan]
ignore = ["fixtures/**"]
[protect]
instructions = true
[notify]
format = "text"
[roles.a]
writes = ["a/**"]
`);
  assert.deepEqual(cfg.allowedDomains, ["github.com"]);   // not ["g","i","t",…]
  assert.deepEqual(cfg.keyDirs, [".secrets"]);
  assert.equal(cfg.redact, false);
});

test("runtime.redact must be a boolean", () => {
  assert.throws(() => policy(`[runtime]\nredact = "no"\n[roles.a]\nwrites = ["a/**"]\n`),
    /runtime\.redact must be true or false/);
});

test("a ] inside a quoted item does not end a multi-line array", () => {
  const cfg = policy(`[roles.a]\nwrites = ["a]b/**",\n  "c/**"]\n`);
  assert.deepEqual(cfg.roles.a.writesDeclared, ["a]b/**", "c/**"]);
});
