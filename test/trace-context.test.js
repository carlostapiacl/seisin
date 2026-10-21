/**
 * The launcher's W3C trace, carried into the log and to the agent: so the log of a
 * run joins the launcher's trace (and anything else that observed the same run) by
 * trace id, without seisin knowing who else is looking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { intake } from "../src/intake.js";
import { buildEnv } from "../src/env.js";
import { parseTraceparent, traceFields } from "../src/trace.js";
import { scratch } from "./_tmp.js";

const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

test("a TRACEPARENT is read only when it is well-formed W3C", () => {
  assert.deepEqual(parseTraceparent(TP), { trace_id: "0af7651916cd43dd8448eb211c80319c", span_id: "b7ad6b7169203331" });
  for (const bad of [
    undefined, "", "garbage",
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331",       // no flags
    "00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01",   // uppercase
    "00-00000000000000000000000000000000-b7ad6b7169203331-01",   // zero trace id
    "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01",   // zero span id
    "ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",   // invalid version
    "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-x", // version 00 has four parts
  ]) assert.equal(parseTraceparent(bad), null, `${bad} must be ignored`);
  assert.deepEqual(traceFields({}), {});
  assert.deepEqual(traceFields({ TRACEPARENT: "nope" }), {});
});

function setup() {
  const dir = scratch("seisin-trace-");
  mkdirSync(join(dir, ".secrets"));
  writeFileSync(join(dir, "seisin.toml"), '[keys]\ndir = ".secrets"\n\n[roles.web]\nwrites = ["web/**"]\n');
  const config = loadConfig(join(dir, "seisin.toml"));
  const lines = () => existsSync(join(dir, ".seisin", "log.jsonl"))
    ? readFileSync(join(dir, ".seisin", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];
  return { config, lines };
}

const settings = { filesystem: { allowWrite: [], denyWrite: [], allowRead: [], denyRead: [] } };

test("every line of a traced run carries the launcher's trace, and the sandbox cannot forge it", () => {
  const { config, lines } = setup();
  const take = intake({ config, role: "web", runId: "1234abcd-0000", settings, trace: traceFields({ TRACEPARENT: TP }) });
  // a hook line that claims another trace: the stamp wins, as it does for the run id
  take.fromHook("log", {
    at: new Date().toISOString(), tool: "Write", action: "write", target: "web/a.ts", verdict: "allowed",
    trace_id: "ffffffffffffffffffffffffffffffff", span_id: "ffffffffffffffff",
  });
  const [line] = lines();
  assert.equal(line.trace_id, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(line.span_id, "b7ad6b7169203331");
  assert.equal(line.run, "1234abcd");
});

test("a run with no trace writes the lines it always wrote", () => {
  const { config, lines } = setup();
  const take = intake({ config, role: "web", runId: "1234abcd-0000", settings });
  take.fromHook("log", { at: new Date().toISOString(), tool: "Write", action: "write", target: "web/a.ts", verdict: "allowed" });
  const [line] = lines();
  assert.equal("trace_id" in line, false);
  assert.equal("span_id" in line, false);
});

test("the trace context reaches the agent, and a credential still does not", () => {
  const { env, dropped } = buildEnv({ TRACEPARENT: TP, TRACESTATE: "vendor=x", PATH: "/bin", GITHUB_TOKEN: "s" }, {});
  assert.equal(env.TRACEPARENT, TP);
  assert.equal(env.TRACESTATE, "vendor=x");
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.ok(dropped.includes("GITHUB_TOKEN"));
});
