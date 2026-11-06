/**
 * A path a role may write and may not read back: a tool creates a directory
 * there, cannot find it again and fails with EPERM, and the refused stat is
 * not logged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writableButUnreadable } from "../src/territory.js";

const check = (fs) => writableButUnreadable(fs);

test("a read-denied path inside a writable one is named, and one holding a writable path too", () => {
  assert.deepEqual(check({ denyRead: ["/h/.config"], allowWrite: ["/h"] }), ["/h/.config"]);
  assert.deepEqual(check({ denyRead: ["/h/.config"], allowWrite: ["/h/.config/tool"] }), ["/h/.config/tool"]);
});

test("nothing is named when the two rules do not meet or a rule settles it", () => {
  // No overlap.
  assert.deepEqual(check({ denyRead: ["/h/.ssh"], allowWrite: ["/repo"] }), []);
  // Shut both ways: a key directory inside the repo.
  assert.deepEqual(check({ denyRead: ["/repo/.secrets"], allowWrite: ["/repo"], denyWrite: ["/repo/.secrets"] }), []);
  // Read back by name: deny the parent, allow your own.
  assert.deepEqual(check({ denyRead: ["/runs"], allowRead: ["/runs/me"], allowWrite: ["/runs/me"] }), []);
  assert.deepEqual(check({ denyRead: ["/h/x"], allowRead: ["/h/x"], allowWrite: ["/h"] }), []);
  // A write inside the denied path that is itself shut to writes.
  assert.deepEqual(check({ denyRead: ["/h/x"], allowWrite: ["/h/x/y"], denyWrite: ["/h/x"] }), []);
});

test("a deny spelt with a bracket reads as the same path, and a pattern is left alone", () => {
  assert.deepEqual(check({ denyRead: ["/h/.confi[g]"], allowWrite: ["/h"] }), ["/h/.config"]);
  assert.deepEqual(check({ denyRead: ["/h/*.pem"], allowWrite: ["/h"] }), []);
});

test("a moved HOME: the account's credential homes stay closed, and what the role writes there is its own", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir, userInfo } = await import("node:os");
  const moved = realpathSync(mkdtempSync(join(tmpdir(), "seisin-moved-home-")));
  const src = `
    import { credentialHomes } from ${JSON.stringify(new URL("../src/grants.js", import.meta.url).href)};
    console.log(JSON.stringify({ own: credentialHomes([process.env.HOME]), other: credentialHomes(["/somewhere/else"]) }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
    env: { ...process.env, HOME: moved }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const { own, other } = JSON.parse(r.stdout);
  const account = realpathSync(userInfo().homedir);
  // Closed at the account either way.
  for (const list of [own, other]) assert.ok(list.includes(join(account, ".ssh")), list.join(" "));
  // The moved home: open to the role that writes it, closed to the one that does not.
  assert.ok(!own.includes(join(moved, ".config")), own.join(" "));
  assert.ok(other.includes(join(moved, ".config")), other.join(" "));
});
