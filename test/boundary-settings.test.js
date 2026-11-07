/**
 * What a role's policy becomes in the settings handed to the sandbox.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { settingsFor, RUNTIME_WRITES, roleHomeRoot, homeFits } from "../src/srt-settings.js";
import { twoRoles as cfg } from "./_tmp.js";

test("the emitted settings carry every field the runtime requires", () => {
  // The runtime refuses to start on a partial settings file rather than falling
  // back to its defaults. Emitting the whole object is what makes that safe.
  const s = settingsFor(cfg, "frontend");
  assert.deepEqual(Object.keys(s.network).sort(), ["allowLocalBinding", "allowUnixSockets", "allowedDomains", "deniedDomains"]);
  assert.deepEqual(Object.keys(s.filesystem).sort(), ["allowRead", "allowWrite", "denyRead", "denyWrite"]);
});

test("the key directory is denied wholesale and re-allowed one file at a time", () => {
  const s = settingsFor(cfg, "frontend");
  assert.ok(s.filesystem.denyRead.includes("/repo/.secrets"));
  assert.deepEqual(s.filesystem.allowRead, ["/repo/.secrets/netlify.txt"]);
});

test("sandbox-runtime convenience logs are removed from every role", () => {
  // The runtime adds these write grants behind the caller's allowWrite list.
  // A read deny makes it omit that implicit grant; the write deny also closes
  // .claude/debug beneath Seisin's intentional ~/.claude scratch grant.
  // On Linux only the ones that exist once the profile is built are named (a
  // missing one is not creatable there, or seisin creates it first).
  const { denyRead, denyWrite } = settingsFor(cfg, "frontend").filesystem;
  for (const suffix of ["/.npm/_logs", "/.claude/debug"]) {
    if (process.platform === "linux" && !existsSync(join(homedir(), suffix))) {
      assert.ok(!denyWrite.some((p) => p.endsWith(suffix)), `${suffix} named although missing`);
      continue;
    }
    assert.ok(denyRead.some((p) => p.endsWith(suffix)), `${suffix} still readable`);
    assert.ok(denyWrite.some((p) => p.endsWith(suffix)), `${suffix} still writable`);
  }
});

test("a write glob becomes a directory, because the kernel grants subtrees", () => {
  // Passing `src/web/**` straight through would ask the OS for a directory
  // literally named `**`, which grants nothing and says nothing.
  assert.equal(settingsFor(cfg, "frontend").filesystem.allowWrite[0], "/repo/src/web");
});

test("every role also gets the scratch space an agent cannot run without", () => {
  // Territory alone is correct and unusable: an agent writes its session state
  // under its own config dir and its tools write to the temp dir. Measured
  // against a real config — with territory only, nothing started.
  const w = settingsFor(cfg, "frontend").filesystem.allowWrite;
  assert.equal(w.length, 1 + RUNTIME_WRITES.length);     // territory + scratch, and nothing else
  assert.ok(w.some((p) => p.endsWith("/.claude")));
  // The literal "/tmp" is deliberately NOT what lands: on macOS it is a symlink
  // and the sandbox enforces on the destination, so the grant is resolved first.
  assert.ok(w.some((p) => p.endsWith("/tmp")));
  assert.ok(!w.includes("/tmp") || realpathSync("/tmp") === "/tmp");
});

test("the scratch grants can be turned off, and then territory is all there is", () => {
  // Turning off scratch is a choice about the agent's toolchain. Nothing else
  // is smuggled back in — the audit directory is not here either, because the
  // instrument no longer needs a hole to write through.
  const strict = { ...cfg, runtimeWrites: [] };
  assert.deepEqual(settingsFor(strict, "frontend").filesystem.allowWrite, ["/repo/src/web"]);
});

test("the scratch grants never include the home directory itself", () => {
  // A grant that reaches ~ would hand over the shell profile, the ssh config
  // and every dotfile with a token in it. Scratch space is not a back door.
  const home = settingsFor(cfg, "frontend").filesystem.allowWrite.filter((p) => /\/Users\/[^/]+$|^\/home\/[^/]+$/.test(p));
  assert.deepEqual(home, []);
});

test("an unknown role fails loudly", () => {
  assert.throws(() => settingsFor(cfg, "nope"), /unknown role/);
});

test("the audit directory is not writable from inside the box", () => {
  // It used to be, because the hook runs inside and has to record what it
  // decided — which made the log and the queue writable by the process they
  // are a record of. An external review named it: nothing enforced the word
  // "append-only" that those files use about themselves.
  const w = settingsFor(cfg, "frontend").filesystem.allowWrite;
  assert.ok(!w.some((p) => p.endsWith("/.seisin")), ".seisin is reachable from inside");
});

test("the audit socket is granted by path, and only when there is one", () => {
  // The replacement for that grant: the hook sends a line to the parent, which
  // holds the file. One socket, named, not "unix sockets are on now".
  assert.deepEqual(settingsFor(cfg, "frontend").network.allowUnixSockets, []);
  const s = settingsFor(cfg, "frontend", "/tmp/seisin-1.sock");
  assert.deepEqual(s.network.allowUnixSockets, ["/tmp/seisin-1.sock"]);
  // and it does not quietly become a filesystem grant
  assert.ok(!s.filesystem.allowWrite.includes("/tmp/seisin-1.sock"));
});

test("scratch covers the XDG dirs, and never ~/.config", () => {
  // The first list named ~/.claude and ~/.codex and stopped there, so the first
  // agent that was neither — opencode, logging to ~/.local/share — died at
  // startup. ~/.config stays out on purpose: that is where gh keeps its token.
  const w = settingsFor(cfg, "frontend").filesystem.allowWrite;
  assert.ok(w.some((p) => p.endsWith("/.local/share")));
  assert.ok(!w.some((p) => p.endsWith("/.config")));
});

test("a pattern the kernel cannot express is refused, not widened", () => {
  // The finding of an outside review, and the worst one possible. ownersOf()
  // reads `src/*` as one level (`*` → [^/]*), and the old translation trimmed
  // the `/*` and handed `src` to the kernel, which is the whole subtree. That is:
  // `seisin explain` said denied and the write went through. Checked against
  // the real sandbox, not reasoned about.
  const mk = (w) => ({ root: "/repo", keyDirs: [], allowedDomains: [],
                       roles: { r: { name: "r", writes: [w], keys: [], network: null } } });

  // There is no exact translation left to find: the sandbox allows prefixes,
  // and "one level down" is not a prefix.
  for (const bad of ["src/*", "src/*/foo/**", "src/??/**", "src/[ab]/**"])
    assert.throws(() => settingsFor(mk(bad), "r"), /cannot be enforced/, bad);

  // And what can be expressed still can, without changing meaning.
  const w = (g) => settingsFor(mk(g), "r").filesystem.allowWrite;
  assert.ok(w("src/**").includes("/repo/src"));
  assert.ok(w("src/api/x.ts").includes("/repo/src/api/x.ts"));
  assert.ok(w("**").includes("/repo"));
});

test("the confinement's own paperwork is never writable, however wide the territory", () => {
  // `writes = ["**"]` is reasonable for a lone agent, and it handed the agent
  // its own policy file: rewrite seisin.toml and run again with more territory.
  // Checked against the real kernel before fixing it.
  const cfg = {
    root: "/repo", path: "/repo/seisin.toml", keyDirs: [".secrets"], allowedDomains: [],
    roles: { owner: { name: "owner", writes: ["**"], keys: [], network: null } },
  };
  const { denyWrite, allowWrite } = settingsFor(cfg, "owner").filesystem;
  assert.ok(allowWrite.includes("/repo"), "the role does have the whole repo");
  for (const p of ["/repo/seisin.toml", "/repo/.seisin", "/repo/.secrets"])
    assert.ok(denyWrite.includes(p), `${p} should be unwritable`);
  // and the audit socket, which lives in shared scratch
  assert.ok(settingsFor(cfg, "owner", "/tmp/s.sock").denyWrite === undefined ||
            settingsFor(cfg, "owner", "/tmp/s.sock").filesystem.denyWrite.includes("/tmp/s.sock"));
});

test("isolated mode gives each role its own home, and the real one to nobody", () => {
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [], isolate: true,
                roles: { a: { name: "a", writes: ["src/**"], keys: [], network: null },
                         b: { name: "b", writes: ["src/**"], keys: [], network: null } } };
  const wa = settingsFor(cfg, "a").filesystem.allowWrite;
  const wb = settingsFor(cfg, "b").filesystem.allowWrite;
  assert.ok(!wa.some((p) => p.includes("/.claude")), "the real ~/.claude is still allowed");
  assert.ok(!wa.some((p) => wb.includes(p) && p.includes("seisin-home")), "the roles share scratch");
  assert.ok(wa.some((p) => p.endsWith("/a")), "the role has no home of its own");
});

test("isolated mode closes reading too, not just writing", () => {
  // By default the model is "read whatever you like except the declared key
  // directories", so ~/.ssh and ~/.aws are ordinary files to any role.
  // Reasonable for your own agents; the whole game for anything else.
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [], isolate: true,
                roles: { a: { name: "a", writes: ["src/**"], keys: [], network: null } } };
  const { denyRead } = settingsFor(cfg, "a").filesystem;
  for (const p of [".ssh", ".aws", ".config"])
    assert.ok(denyRead.some((d) => d.endsWith("/" + p)), `${p} readable in isolated mode`);
  // and without isolate it stays open, which is what the docs say
  const open = settingsFor({ ...cfg, isolate: false }, "a").filesystem.denyRead;
  assert.ok(!open.some((d) => d.endsWith("/.ssh")));
});

test("isolated roles cannot read each other's homes, not just write", () => {
  // The most uncomfortable finding of all: the audit document said this was
  // closed because the only thing I measured was WRITING. Reading was open, so
  // `a` read the session token `b`'s CLI had just written. Same pattern as the
  // key directories: deny the parent, allow its own.
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [], isolate: true,
                roles: { a: { name: "a", writes: ["src/**"], keys: [], network: null },
                         b: { name: "b", writes: ["src/**"], keys: [], network: null } } };
  const fa = settingsFor(cfg, "a").filesystem;
  // realOrSelf in the code, the same here: the root does not exist on disk for
  // a fake repo, and realpathSync on something that does not exist throws.
  // Against the function, not the name: the first version looked for the text
  // "seisin-home" and broke when that prefix had to be shortened so the socket
  // path would fit in macOS's 104 bytes. A test that pins the name of an
  // internal detail fails on the fix, not on the defect.
  const expected = roleHomeRoot(cfg);
  const root = fa.denyRead.find((p) => p === expected);
  assert.ok(root, "the root of the homes is not denied");
  assert.ok(fa.allowRead.some((p) => p === join(root, "a")), "the role does not get its own back");
  assert.ok(!fa.allowRead.some((p) => p === join(root, "b")), "it reaches another role's home");
});

test("the audit socket's directory is denied, not just the socket", () => {
  // Denying only the socket left `mv /tmp/seisin-xxxx /tmp/gone` as a way to
  // remove the channel without ever touching the protected file.
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [],
                roles: { a: { name: "a", writes: ["src/**"], keys: [], network: null } } };
  const { denyWrite } = settingsFor(cfg, "a", "/tmp/seisin-abc/spool.sock").filesystem;
  assert.ok(denyWrite.includes("/tmp/seisin-abc/spool.sock"));
  assert.ok(denyWrite.includes("/tmp/seisin-abc"));
});

test("observing means the kernel stops refusing, or there is nothing to observe", () => {
  // --observe relaxed only the hook, so the sandbox denied anyway and the banner
  // said "nothing denied" over a transcript of denials. And
  // `init --from-observations` builds a policy from that transcript: it would
  // come out as "the agent needs nothing outside its territory", which is the
  // opposite of the truth.
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [".secrets"], allowedDomains: [],
                roles: { dev: { name: "dev", writes: ["src/web/**"], keys: [], network: null } } };

  const normal = settingsFor(cfg, "dev").filesystem;
  assert.ok(normal.allowWrite.includes("/repo/src/web"));
  assert.ok(!normal.allowWrite.includes("/repo"));

  const observing = settingsFor(cfg, "dev", null, true).filesystem;
  assert.ok(observing.allowWrite.includes("/repo"), "observing does not open the repo");
  // and the confinement's own paperwork stays closed even while observing
  for (const p of ["/repo/seisin.toml", "/repo/.seisin", "/repo/.secrets"])
    assert.ok(observing.denyWrite.includes(p), `${p} was left open while observing`);
});

/**
 * ── The isolated home has to fit a socket ──
 *
 * `isolate = true` never started on macOS, for every role name including `qa`:
 * the runtime creates `<home>/tmp/srt-mux-<pid>-0.sock` inside the role's home,
 * a unix socket path is capped near 104 bytes, and `tmpdir()` alone is 48 of
 * them there. It failed as `listen EINVAL` with no role and no mention of
 * isolate. No test enabled the feature, so a green suite said nothing.
 */
test("an isolated home leaves room for the runtime's socket, on this platform", () => {
  const cfg = { root: "/Users/someone/Desktop/projects/a-repo-with-a-fairly-long-path/here" };
  for (const role of ["qa", "dev", "dev-front", "dev-compras", "arquitecto"])
    assert.ok(homeFits(cfg, role) >= 0,
      `${role}: ${-homeFits(cfg, role)} byte(s) over the socket limit`);
});

test("a role whose isolated home cannot fit is refused by name, not by EINVAL", () => {
  const longName = "a".repeat(120);
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [], isolate: true,
                roles: { [longName]: { name: longName, writes: ["src/**"], keys: [], network: null } } };
  assert.throws(() => settingsFor(cfg, longName), (e) =>
    /isolate/.test(e.message) && /socket/.test(e.message) && e.message.includes(longName));
});

test("without isolate the home length is nobody's problem", () => {
  // The guard only runs in isolated mode: in the ordinary one there is no home to create.
  const longName = "b".repeat(120);
  const cfg = { root: "/repo", path: "/repo/seisin.toml", keyDirs: [], allowedDomains: [], isolate: false,
                roles: { [longName]: { name: longName, writes: ["src/**"], keys: [], network: null } } };
  assert.ok(settingsFor(cfg, longName).filesystem);
});

test("two checkouts that end the same way do not share an isolated home", () => {
  // The id was the TAIL of the path's base64, which is the tail of the path.
  // These pairs collided — and a collision here is one repo's HOME handed to the
  // other, with its CLI session inside.
  const pairs = [
    ["/Users/ana/dev/project", "/Users/bob/dev/project"],
    ["/home/a/work/api", "/home/b/work/api"],
    ["/Users/uno/x/seisin", "/Users/dos/x/seisin"],
  ];
  for (const [a, b] of pairs)
    assert.notEqual(roleHomeRoot({ root: a }), roleHomeRoot({ root: b }), `${a} vs ${b}`);
});

test("the same repo always gets the same isolated home", () => {
  // The other thing a hash has to do: stay stable across runs, or the role
  // loses its state on every invocation.
  const cfg = { root: "/Users/someone/repo" };
  assert.equal(roleHomeRoot(cfg), roleHomeRoot({ ...cfg }));
});
