/**
 * The environment a role runs with: what is dropped, what it names, what is set for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnv, DEFAULTS as ENV_DEFAULTS } from "../src/env.js";
import { twoRoles as cfg } from "./_tmp.js";

/** The names that crossed FROM THE PARENT, which is what these tests are about.
 *  `buildEnv` also SETS a couple of variables the parent never had (see
 *  `DEFAULTS` in env.js); asserting on the raw key set would make every test
 *  here fail the next time one is added, for a reason none of them is testing. */
const forwarded = (env) => Object.keys(env).filter((k) => !(k in ENV_DEFAULTS)).sort();

test("the built environment drops what the policy did not name", () => {
  // Measured before this existed: 93 variables crossed into every turn, a
  // planted secret among them. denyRead guards files; an environment variable
  // is not a file.
  const parent = { PATH: "/bin", HOME: "/h", MY_API_TOKEN: "tok", RANDOM_THING: "x" };
  const { env, dropped } = buildEnv(parent, cfg.roles.frontend);
  assert.deepEqual(forwarded(env), ["HOME", "PATH"]);
  assert.ok(dropped.includes("MY_API_TOKEN"));
});

test("a role can name the one variable it needs, and only that one", () => {
  const parent = { PATH: "/bin", BUILD_ID: "42", OTHER: "no" };
  const role = { ...cfg.roles.frontend, env: ["BUILD_ID"] };
  assert.deepEqual(forwarded(buildEnv(parent, role).env), ["BUILD_ID", "PATH"]);
});

test("git's optional locks are off, so reading a repo you do not own is not a request", () => {
  // The measurement this exists for: of the last 60 denials in a multi-repo
  // workspace, 58 were `.git/index.lock`, most of them with no owner at all.
  // `git status` refreshes the index as a courtesy and the refresh takes the
  // lock, so a role that only reads a repo trips the boundary doing nothing.
  // The parent does NOT have the variable — it is set, not forwarded, which is
  // the whole difference between this and BASE.
  const { env } = buildEnv({ PATH: "/bin" }, cfg.roles.frontend);
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
});

test("a role that wants git's locks back can have them", () => {
  // The escape hatch has to work, or the default is a decision nobody can undo.
  // Naming it is not enough on its own: the parent has to carry the value, same
  // as every other variable a role names.
  const role = { ...cfg.roles.frontend, env: ["GIT_OPTIONAL_LOCKS"] };
  const { env } = buildEnv({ PATH: "/bin", GIT_OPTIONAL_LOCKS: "1" }, role);
  assert.equal(env.GIT_OPTIONAL_LOCKS, "1");
});

test("a default is not a way in: the parent cannot overwrite one it was not granted", () => {
  // Control in the other direction. Without this, seeding defaults would be a
  // second, quieter channel for the parent environment to cross — which is the
  // exact thing buildEnv exists to close.
  const { env } = buildEnv({ PATH: "/bin", GIT_OPTIONAL_LOCKS: "1" }, cfg.roles.frontend);
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
});

test("naming a credential explicitly works; sweeping one up does not", () => {
  // The block is on accident, not on intent. A role that says DEPLOY_TOKEN gets
  // it; what cannot happen is a credential riding along because nobody looked.
  const parent = { PATH: "/bin", DEPLOY_TOKEN: "t" };
  assert.ok(!("DEPLOY_TOKEN" in buildEnv(parent, cfg.roles.frontend).env));
  const named = { ...cfg.roles.frontend, env: ["DEPLOY_TOKEN"] };
  assert.equal(buildEnv(parent, named).env.DEPLOY_TOKEN, "t");
});
