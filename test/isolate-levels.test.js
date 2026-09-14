/**
 * The two things `isolate` used to be, and why they had to come apart.
 *
 * Closing the places credentials live, and giving each role a home of its own,
 * were one switch. Only the second needs a new HOME — and only the second signs
 * every CLI in the box out, because on macOS the agent's credential is in the
 * login keychain and the keychain is found through HOME. Welded together, the
 * half worth having was unreachable.
 *
 * Measured against the real kernel while this was written:
 *
 *   isolate = false          ~/.ssh ~/.aws ~/.npmrc ~/.config/gh   open   agent OK
 *   isolate = "credentials"  all four closed, ~/.claude open              agent OK
 *   isolate = "home"         all five closed                              Not logged in
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { readIsolate } from "../src/config.js";
import { settingsFor, expand, CREDENTIAL_HOMES } from "../src/srt.js";

const policy = (isolate) => ({
  root: "/repo", path: "/repo/seisin.toml", keyDirs: [".secrets"],
  runtimeWrites: [], isolate,
  roles: { dev: { name: "dev", writes: ["src/**"], keys: [] } },
});

const denied = (isolate) => settingsFor(policy(isolate), "dev").filesystem.denyRead;
const has = (list, p) => list.includes(expand(p));

/* ── what each level reads ────────────────────────────────────────────── */

test("an unknown word is off, never a stronger setting than was meant", () => {
  // A permission tool must not read a typo as more confinement than the writer
  // asked for, and never as less than it says either. Off is the safe end.
  assert.equal(readIsolate("credentials"), "credentials");
  assert.equal(readIsolate("home"), "home");
  assert.equal(readIsolate(true), "home", "what `true` has always meant");
  for (const v of [false, undefined, "CREDENTIALS", "yes", "credential", 1])
    assert.equal(readIsolate(v), false, `${JSON.stringify(v)} is off`);
});

test("off by default: a role reads your home like any process you run", () => {
  const list = denied(false);
  for (const p of CREDENTIAL_HOMES) assert.ok(!has(list, p), `${p} is not denied`);
});

test("credentials closes where credentials live, and nothing else", () => {
  const list = denied("credentials");
  for (const p of CREDENTIAL_HOMES) assert.ok(has(list, p), `${p} must be denied`);
});

test("credentials leaves the agent's own directories open, on purpose", () => {
  // This is the difference that makes the level adoptable. `~/.claude` holds a
  // session, and at this level HOME is untouched, so closing it would cost the
  // login without buying the separation that closing it is for.
  const list = denied("credentials");
  assert.ok(!has(list, "~/.claude"));
  assert.ok(!has(list, "~/.codex"));
});

test("home closes those too, and that is the price it is named for", () => {
  const list = denied("home");
  for (const p of [...CREDENTIAL_HOMES, "~/.claude", "~/.codex"])
    assert.ok(has(list, p), `${p} must be denied`);
});

/* ── only one level moves HOME ────────────────────────────────────────── */

test("only home gives the role a home of its own", () => {
  const own = (level) => {
    const w = settingsFor(policy(level), "dev").filesystem.allowWrite;
    return w.some((p) => p.includes("/sn-"));
  };
  assert.equal(own("credentials"), false, "credentials writes to the real home");
  assert.ok(own("home"));

  // And with the ordinary runtime grants in place, `credentials` keeps the
  // shared agent directory writable — which is the same one it left readable.
  const shared = { ...policy("credentials") };
  delete shared.runtimeWrites;
  assert.ok(settingsFor(shared, "dev").filesystem.allowWrite.includes(expand("~/.claude")));
});

test("the socket limit only constrains the level that has a home", () => {
  // A role home too deep for the runtime's socket is refused by name rather
  // than left to fail as EINVAL. That check belongs to `home`; `credentials`
  // creates no home, so no role name can be too long for it.
  const long = "a-role-name-far-too-long-for-a-unix-socket-path-to-hold";
  const cfg = (level) => ({ ...policy(level), roles: { [long]: { name: long, writes: ["src/**"], keys: [] } } });
  assert.doesNotThrow(() => settingsFor(cfg("credentials"), long));
  assert.throws(() => settingsFor(cfg("home"), long), /isolate/);
});

test("true still means what it meant, for a config written before the split", () => {
  assert.deepEqual(denied(true), denied("home"));
});
