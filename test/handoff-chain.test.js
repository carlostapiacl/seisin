import { test } from "node:test";
import assert from "node:assert/strict";
import { decideHandoff } from "../src/handoff.js";

const config = {
  root: "/repo",
  roles: {
    frontend: { name: "frontend", writes: ["src/web/**"], keys: [] },
    backend: { name: "backend", writes: ["src/api/**"], keys: [] },
  },
};
const request = { role: "frontend", target: "src/api/orders.ts", owners: ["frontend"] };

test("preserves requester in visited even when supplied history is incomplete", () => {
  const result = decideHandoff({ request, config, chain: { visited: [], depth: 1 } });
  assert.equal(result.type, "route");
  assert.deepEqual(result.visited, ["frontend", "backend"]);
});

test("a supplied history without the requester still records it beside the cycle it reports", () => {
  const result = decideHandoff({
    request, config, chain: { visited: ["backend"], depth: 1 },
  });
  assert.equal(result.type, "cycle");
  assert.deepEqual(result.visited, ["backend", "frontend"]);
});

test("authorization precedes admission and throttling", () => {
  const result = decideHandoff({
    request: { role: "frontend", target: "src/web/view.ts" }, config,
    limits: { senderChains: 0, receiverConcurrent: 0 },
    load: { senderOpenChains: 99, receiverRunning: 99 },
  });
  assert.equal(result.type, "resolved");
  assert.equal(result.resolution, "policy_changed");
});

test("a chain started with empty history cannot hand the work back to the role that began it", () => {
  // The case the fix exists for: frontend opens a chain with no history,
  // backend is routed, and backend reaches back into frontend's territory.
  // Before, the first hop's history was ["backend"] and the second hop routed
  // straight back to frontend.
  const one = decideHandoff({ request, config, chain: { id: "c", visited: [], depth: 0 } });
  assert.equal(one.type, "route");
  const two = decideHandoff({
    request: { role: "backend", target: "src/web/view.ts" }, config,
    chain: { id: "c", visited: one.visited, depth: one.depth },
  });
  assert.equal(two.type, "cycle");
  assert.equal(two.role, "frontend");
});
