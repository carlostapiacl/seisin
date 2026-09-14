/**
 * The kernel's half of the record.
 *
 * Every fixture here is a real chunk, captured from a real refusal on macOS 15
 * against sandbox-runtime 0.0.76 — not a shape invented to match the parser.
 * That matters more than usual: this module reads someone else's log format, so
 * a test written from the code rather than from the stream would keep passing
 * after the format moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  parseChunk, actionOf, shellSplit, isOurs, descends, inScope, scopeOf, watchDenials,
} from "../src/violations.js";

/* ── captured chunks ──────────────────────────────────────────────────── */

const WRITE_DENY =
  "2026-09-14 15:51:48.212 E  kernel[0:78a1c2] (Sandbox) Sandbox: bash(65518) deny(1) " +
  "file-write-create /private/tmp/demo/src/api/tagprobe.txt\n" +
  "CMD64_c2ggLWMgJ2VjaG8gaGkgPiBzcmMvYXBpL3RhZ3Byb2JlLnR4dCc=_END__qlvxb5sax_SBX";

const DUPLICATE =
  "2026-09-14 15:37:36.916 E  kernel[0:767fba] [com.apple.sandbox.reporting:violation] " +
  "3 duplicate reports for Sandbox: imagent(538) deny(1) file-write-data /tmp/x\n" +
  "CMD64_c2g=_END__qlvxb5sax_SBX";

const MACH_LOOKUP =
  "2026-09-14 15:37:36.916 E  kernel[0:767fba] Sandbox: searchpartyuseragent(588) deny(1) " +
  "mach-lookup com.apple.contactsd.persistence\n" +
  "CMD64_c2g=_END__qlvxb5sax_SBX";

test("a refused write parses into an action, a path and an attribution", () => {
  const d = parseChunk(WRITE_DENY);
  assert.equal(d.action, "write");
  assert.equal(d.operation, "file-write-create");
  assert.equal(d.path, "/private/tmp/demo/src/api/tagprobe.txt");
  assert.equal(d.pid, 65518);
  assert.equal(d.suffix, "_qlvxb5sax_SBX");
  assert.equal(d.command, "sh -c 'echo hi > src/api/tagprobe.txt'");
});

test("the OS collapsing repeats does not become a second denial", () => {
  // `review` does arithmetic over this file. Counting the summary line as well
  // as the event it summarises would make a policy look four times as wrong as
  // it is.
  assert.equal(parseChunk(DUPLICATE), null);
});

test("a denial that is not about a file is not a territory question", () => {
  assert.equal(parseChunk(MACH_LOOKUP), null);
});

test("a path that is not absolute is dropped rather than guessed at", () => {
  const relative = WRITE_DENY.replace("/private/tmp/demo/src/api/tagprobe.txt", "src/api/x.ts");
  assert.equal(parseChunk(relative), null);
});

test("operations map onto the two verbs the log speaks", () => {
  assert.equal(actionOf("file-write-create"), "write");
  assert.equal(actionOf("file-write-unlink"), "write");
  assert.equal(actionOf("file-read-data"), "read");
  assert.equal(actionOf("network-outbound"), null);
  assert.equal(actionOf("sysctl-read"), null);
});

/* ── attribution ──────────────────────────────────────────────────────── */

test("the tagged command parses back to the argument list it was made from", () => {
  assert.deepEqual(shellSplit("sh -c 'echo hi > src/api/orders.ts'"),
    ["sh", "-c", "echo hi > src/api/orders.ts"]);
  assert.deepEqual(shellSplit(`claude -p 'it'"'"'s fine'`), ["claude", "-p", "it's fine"]);
});

test("a command cut off at 100 characters still matches the run that launched it", () => {
  // The tag holds a prefix, so the last word is a fragment and its quote is
  // unclosed. Treating that as malformed would lose attribution on exactly the
  // long commands an agent actually runs.
  assert.ok(isOurs("sh -c 'echo hi > src/api/or", ["sh", "-c", "echo hi > src/api/orders.ts"]));
  assert.ok(isOurs("claude -p 'write the", ["claude", "-p", "write the migration"]));
});

test("another sandbox's command is not credited to this run", () => {
  assert.equal(isOurs("git commit -m 'x'", ["sh", "-c", "echo hi"]), false);
  assert.equal(isOurs("sh -c 'echo bye'", ["sh", "-c", "echo hi"]), false);
  assert.equal(isOurs(null, ["sh", "-c", "echo hi"]), false);
  // More words than we launched cannot be a prefix of our command.
  assert.equal(isOurs("sh -c 'x' extra", ["sh", "-c", "x"]), false);
});

test("descent is computed through the tree, not just the parent", () => {
  const tree = new Map([[400, 300], [300, 200], [200, 100], [100, 1]]);
  assert.ok(descends(400, 200, tree));
  assert.ok(descends(200, 200, tree));
  assert.equal(descends(400, 999, tree), false);
});

test("a cycle in the tree terminates instead of hanging", () => {
  // ps output is a snapshot of a moving system and has been seen to disagree
  // with itself. A permission tool that spins on it is worse than one that
  // says no.
  assert.equal(descends(2, 999, new Map([[2, 3], [3, 2]])), false);
});

/* ── what gets recorded ───────────────────────────────────────────────── */

test("only paths the policy names are recorded", () => {
  const scope = ["/repo", "/private/tmp/scratch"];
  assert.ok(inScope("/repo/src/api/orders.ts", scope));
  assert.ok(inScope("/repo", scope));
  assert.equal(inScope("/dev/tty", scope), false);
  // A prefix that is not a path boundary is not a match: /repo-backup is a
  // different repo.
  assert.equal(inScope("/repo-backup/x", scope), false);
});

test("the scope is read off what was handed to the kernel, not off the config", () => {
  const settings = {
    filesystem: { allowWrite: ["/repo/src/web"], denyWrite: ["/repo/.seisin"],
                  allowRead: ["/repo/.secrets/k"], denyRead: ["/repo/.secrets"] },
  };
  const scope = scopeOf(settings, "/repo");
  assert.ok(scope.includes("/repo"));
  assert.ok(scope.includes("/repo/.secrets"));
  assert.ok(scope.includes("/repo/src/web"));
});

/* ── the watcher ──────────────────────────────────────────────────────── */

test("Linux says why it cannot watch instead of quietly recording less", () => {
  const w = watchDenials(() => {}, { platform: "linux" });
  assert.equal(w.available, false);
  assert.match(w.reason, /Linux/);
  assert.match(w.reason, /upstream/);       // points at the filed ask
  w.close();
});

/** A fake `log stream` we can feed captured chunks into. */
function fakeStream() {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.kill = () => { child.killed = true; };
  return child;
}

/** A stream delivers on the next tick, the same as the real one. */
const delivered = () => new Promise((r) => setImmediate(r));

test("a denial from this run is recorded, one from another sandbox is not", async () => {
  const child = fakeStream();
  const seen = [];
  const w = watchDenials((d) => seen.push(d.path), {
    argv: ["sh", "-c", "echo hi > src/api/tagprobe.txt"],
    platform: "darwin",
    spawnFn: () => child,
    treeFn: () => new Map(),          // no tree: the command tag has to carry it
  });

  child.stdout.push(WRITE_DENY);
  const foreign = WRITE_DENY
    .replace("_qlvxb5sax_SBX", "_zzzzzzzzz_SBX")
    .replace("CMD64_c2ggLWMgJ2VjaG8gaGkgPiBzcmMvYXBpL3RhZ3Byb2JlLnR4dCc=",
             "CMD64_" + Buffer.from("git gc --aggressive").toString("base64"));
  child.stdout.push(foreign);
  await delivered();

  assert.deepEqual(seen, ["/private/tmp/demo/src/api/tagprobe.txt"]);
  assert.equal(w.stats.attributed, 1);
  w.close();
});

test("denials that arrive before the child has a pid are held, not lost", async () => {
  // The stream starts before the spawn on purpose: a short command is refused
  // and gone in milliseconds, and a monitor started afterwards records nothing.
  // Everything that lands in that window has to survive until there is
  // something to attribute it to.
  const child = fakeStream();
  const seen = [];
  const w = watchDenials((d) => seen.push(d.path), {
    platform: "darwin",
    spawnFn: () => child,
    treeFn: () => new Map([[65518, 900]]),
  });

  child.stdout.push(WRITE_DENY);
  await delivered();
  assert.deepEqual(seen, [], "nothing can be attributed yet");
  assert.equal(w.stats.unattributed, 1);

  w.attributeTo(900);
  assert.deepEqual(seen, ["/private/tmp/demo/src/api/tagprobe.txt"]);
  assert.equal(w.stats.unattributed, 0);
  w.close();
});

test("the watcher never throws into the run it is watching", () => {
  // append() swallows its errors for the same reason: a permission tool that
  // takes the build down because its instrument failed has done more damage
  // than the thing it was watching for.
  const w = watchDenials(() => {}, {
    platform: "darwin",
    spawnFn: () => { throw new Error("log: command not found"); },
  });
  assert.equal(w.available, false);
  assert.match(w.reason, /could not start/);
  assert.doesNotThrow(() => w.close());
});

test("undecided denials cannot accumulate for the length of a session", async () => {
  // A run that is never refused anything never learns its own suffix, so every
  // denial from every other sandbox on the machine stays undecided. Several
  // cells running at once for hours is that shape, and an unbounded queue is
  // how the instrument becomes the leak.
  const child = fakeStream();
  const w = watchDenials(() => {}, {
    argv: ["sh", "-c", "never refused"],
    platform: "darwin",
    spawnFn: () => child,
    treeFn: () => new Map(),
  });

  for (let i = 0; i < 700; i++)
    child.stdout.push(WRITE_DENY.replace("bash(65518)", `bash(${70000 + i})`));
  await delivered();

  assert.ok(w.stats.unattributed <= 500, `held ${w.stats.unattributed}`);
  assert.equal(w.stats.unattributed + w.stats.foreign, 700, "nothing is lost from the count");
  w.close();
});

test("one refusal reported twice by the OS is one line", async () => {
  // macOS emits the violation from `kernel` and, for some of them, a second
  // extended report from `sandboxd` with the identical Sandbox: line. `review`
  // counts lines, so a denial that shows as two is a policy that reads as twice
  // as wrong as it is.
  const child = fakeStream();
  const seen = [];
  const w = watchDenials((d) => seen.push(d.path), {
    argv: ["sh", "-c", "echo hi > src/api/tagprobe.txt"],
    platform: "darwin",
    spawnFn: () => child,
    treeFn: () => new Map(),
  });

  child.stdout.push(WRITE_DENY);
  child.stdout.push(WRITE_DENY.replace("kernel[0:78a1c2]", "sandboxd[166:7128ca]"));
  await delivered();

  assert.equal(seen.length, 1);
  w.close();
});

test("a refused stat is not an attempt to read a secret", async () => {
  // Any directory walk against a denied path produces one of these per file.
  // The first real run wrote 721 of them against 4 genuine read attempts,
  // which buried the lines that mattered and filed a request per file.
  const stat = WRITE_DENY.replace("file-write-create", "file-read-metadata");
  assert.equal(parseChunk(stat), null);

  // The operation that means content was actually reached for still counts.
  const real = WRITE_DENY.replace("file-write-create", "file-read-data");
  assert.equal(parseChunk(real).action, "read");
});
