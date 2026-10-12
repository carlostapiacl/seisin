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

test("recomputes owners from policy instead of trusting the request", () => {
  const result = decideHandoff({ request, config });
  assert.equal(result.type, "route");
  assert.equal(result.role, "backend");
});

test("preserves requester in visited even when supplied history is incomplete", () => {
  const result = decideHandoff({ request, config, chain: { visited: [], depth: 1 } });
  assert.equal(result.type, "route");
  assert.deepEqual(result.visited, ["frontend", "backend"]);
});

test("rejects cycles even when the requester is missing from chain history", () => {
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
