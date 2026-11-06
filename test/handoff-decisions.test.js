/**
 * Who a handoff goes to, what limits it, and how it sits beside a request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "./_tmp.js";
import { record, settle, pending, recordHandoff } from "../src/requests.js";
import { decideHandoff, MAX_DEPTH, describeHandoff } from "../src/handoff.js";
import { renderQueue } from "../src/commands/requests.js";

/**
 * ── Handoff semantics ──
 *
 * These were written before anything routes anything, on purpose. Each one is
 * an invariant that was argued for in prose first, and prose invariants age
 * without telling anyone. A decision function with no spawn in it is the only
 * reason they can be checked at all without starting an agent.
 */
const POLICY = {
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"] },
    backend: { name: "backend", writes: ["src/api/**"] },
    qa: { name: "qa", writes: ["test/**"] },
  },
};

const ASKED = { role: "frontend", action: "write", target: "src/api/orders.ts" };

test("handoff · the receiver is derived from ownership, never supplied", () => {
  const d = decideHandoff({ request: ASKED, config: POLICY });
  assert.equal(d.type, "route");
  assert.equal(d.role, "backend");
  // the caller passed no role anywhere in the input
  assert.ok(!Object.keys(ASKED).includes("to"));
});

test("handoff · the stored owners on the request are not consulted", () => {
  // A request that was recorded when qa owned the path. The policy says backend
  // now, and the policy wins: a stale owner is evidence, not authority.
  const stale = { ...ASKED, owners: ["qa"] };
  assert.equal(decideHandoff({ request: stale, config: POLICY }).role, "backend");
});

test("handoff · resolves instead of asking a human when the asker became the owner", () => {
  const moved = { roles: { ...POLICY.roles, frontend: { name: "frontend", writes: ["src/web/**", "src/api/**"] } } };
  // Both own it now, so first make it unique: only frontend.
  const mine = { roles: { frontend: moved.roles.frontend, qa: POLICY.roles.qa } };
  const d = decideHandoff({ request: ASKED, config: mine });
  assert.equal(d.type, "resolved");
  assert.equal(d.resolution, "policy_changed");
  assert.notEqual(d.type, "human"); // nobody has anything left to decide
});

test("handoff · a target nobody owns goes to a person", () => {
  const d = decideHandoff({ request: { ...ASKED, target: "docs/readme.md" }, config: POLICY });
  assert.equal(d.type, "human");
  assert.equal(d.reason, "unowned");
});

test("handoff · a target two roles own goes to a person, not to a tiebreak", () => {
  const shared = { roles: { ...POLICY.roles, platform: { name: "platform", writes: ["src/**"] } } };
  const d = decideHandoff({ request: ASKED, config: shared });
  assert.equal(d.type, "human");
  assert.equal(d.reason, "ambiguous");
  assert.deepEqual(d.owners.sort(), ["backend", "platform"]);
});

test("handoff · a role already in the chain is not re-entered", () => {
  const back = { role: "backend", action: "write", target: "src/web/app.ts" };
  const d = decideHandoff({
    request: back,
    config: POLICY,
    chain: { id: "H-1", depth: 1, visited: ["frontend", "backend"] },
  });
  assert.equal(d.type, "cycle");
});

test("handoff · a cycle of any length is caught, not just the two-role one", () => {
  // frontend → backend → qa → frontend
  const d = decideHandoff({
    request: { role: "qa", action: "write", target: "src/web/app.ts" },
    config: POLICY,
    chain: { id: "H-2", depth: 2, visited: ["frontend", "backend", "qa"] },
  });
  assert.equal(d.type, "cycle");
});

test("handoff · depth is its own fuse, separate from cycle detection", () => {
  // No repeats — every role is new — so only depth can stop this.
  const long = { roles: Object.fromEntries(
    ["a", "b", "c", "d", "e", "f"].map((n) => [n, { name: n, writes: [`${n}/**`] }])) };
  const d = decideHandoff({
    request: { role: "a", action: "write", target: "f/x.ts" },
    config: long,
    chain: { id: "H-3", depth: MAX_DEPTH, visited: ["a", "b", "c", "d", "e"] },
  });
  assert.equal(d.type, "depth");
  assert.equal(d.max, MAX_DEPTH);
});

test("handoff · a sender cannot open unlimited chains", () => {
  const d = decideHandoff({
    request: ASKED, config: POLICY,
    limits: { senderChains: 3 }, load: { senderOpenChains: 3 },
  });
  assert.equal(d.type, "throttled");
  assert.equal(d.limit, "senderChains");
});

test("handoff · a receiver is not woken beyond its concurrency", () => {
  const d = decideHandoff({
    request: ASKED, config: POLICY,
    limits: { receiverConcurrent: 2 }, load: { receiverRunning: 2 },
  });
  assert.equal(d.type, "throttled");
  assert.equal(d.limit, "receiverConcurrent");
});

test("handoff · throttling names which limit stopped it, so it cannot be silent", () => {
  const d = decideHandoff({
    request: ASKED, config: POLICY,
    limits: { senderChains: 0 }, load: { senderOpenChains: 0 },
  });
  assert.ok(d.limit && typeof d.max === "number");
});

test("handoff · authority is decided before admission", () => {
  // An unowned target under a chain that is also cyclic and throttled still
  // reports the policy hole. Reporting CYCLE here would send a person to read
  // the wrong thing entirely.
  const d = decideHandoff({
    request: { role: "frontend", action: "write", target: "docs/x.md" },
    config: POLICY,
    chain: { id: "H-4", depth: 9, visited: ["frontend", "backend", "qa"] },
    limits: { senderChains: 0, depth: 1 }, load: { senderOpenChains: 5 },
  });
  assert.equal(d.type, "human");
  assert.equal(d.reason, "unowned");
});

test("handoff · deciding changes no policy and settles no request", () => {
  const before = JSON.stringify(POLICY);
  const asked = { ...ASKED };
  const d = decideHandoff({ request: asked, config: POLICY, revision: "rev-41" });
  assert.equal(JSON.stringify(POLICY), before);
  assert.deepEqual(asked, ASKED);              // the request is not mutated either
  assert.ok(!("granted" in d) && d.type !== "granted");
  assert.equal(d.revision, "rev-41");          // the decision records what it was made against
});

/** A queue file with one denial already in it, for the handoff-visibility tests. */
function queueWithOneDenial() {
  const box = scratch("seisin-req-");
  const f = join(box, "requests.jsonl");
  record(f, { role: "frontend", action: "write", target: "src/api/orders.ts", owners: ["backend"] });
  return { box, f };
}

test("a throttled handoff leaves the request pending, not settled", () => {
  // The failure this prevents: admission refuses the work, the request drops
  // out of the queue as though it were decided, and nobody ever does it.
  const { box, f } = queueWithOneDenial();
  recordHandoff(f, pending(f)[0].key, { type: "throttled", role: "backend", limit: "senderChains", max: 3 });
  const q = pending(f);
  rmSync(box, { recursive: true, force: true });
  assert.equal(q.length, 1);                 // still in the human queue
  assert.equal(q[0].state, "pending");       // admission is not a verdict
  assert.equal(q[0].attempt.outcome, "throttled");
  assert.equal(q[0].attempt.limit, "senderChains");
});

test("the two lifecycles do not overwrite each other, in either order", () => {
  const { box, f } = queueWithOneDenial();
  const key = pending(f)[0].key;
  recordHandoff(f, key, { type: "throttled", limit: "senderChains", max: 3 });
  settle(f, key, "granted", "frontend owns checkout now");
  const after = pending(f, { includeSettled: true })[0];
  // and a handoff attempt recorded after the decision still does not revive it
  recordHandoff(f, key, { type: "route", role: "backend" });
  const later = pending(f, { includeSettled: true })[0];
  rmSync(box, { recursive: true, force: true });
  assert.equal(after.state, "granted");
  assert.equal(after.attempt.outcome, "throttled");
  assert.equal(later.state, "granted");
  assert.equal(later.attempt.outcome, "route");
});

test("a held handoff says which limit held it, in words a person reads", () => {
  const route = { type: "route", role: "backend", depth: 1 };
  assert.match(describeHandoff({ type: "throttled", role: "backend", limit: "senderChains", max: 3 }), /open handoff chains/);
  // Recorded by whatever starts roles, over a decision that still routes there.
  assert.match(describeHandoff(route, { outcome: "throttled", limit: "receiverConcurrent", max: 2, role: "backend" }), /backend already running/);
  assert.match(describeHandoff({ type: "cycle", role: "frontend" }), /already in this handoff chain/);
  assert.match(describeHandoff({ type: "depth", depth: 5, max: 4 }), /5 of 4/);
  assert.equal(describeHandoff(undefined), "");   // nothing decided says nothing
});

test("a recorded attempt cannot overrule the policy's own decision", () => {
  // Held back for backend, but the policy has since moved the path to nobody:
  // the person reads the policy hole, not a stale throttle.
  const held = { outcome: "throttled", limit: "senderChains", max: 3, role: "backend" };
  assert.match(describeHandoff({ type: "human", reason: "unowned", owners: [] }, held), /a person decides: no role owns this/);
  // And one recorded for another receiver says nothing about this one.
  assert.equal(describeHandoff({ type: "route", role: "qa", depth: 1 }, held), "handed to qa");
});

test("the queue shows a held handoff on the request it belongs to", () => {
  const plain = renderQueue([{
    key: "k", role: "frontend", action: "write", target: "src/api/orders.ts",
    owners: ["backend"], grant: "src/api/**", times: 1, state: "pending",
    handoff: { type: "route", role: "backend", owners: ["backend"], depth: 1 },
    attempt: { outcome: "throttled", role: "backend", limit: "senderChains", max: 3 },
  }]).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /1 pending request/);
  assert.match(plain, /handoff held/);
  assert.match(plain, /still to do/);   // it is work, not a verdict
});
