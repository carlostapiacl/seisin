/**
 * Agents that sandbox themselves.
 *
 * The rule being tested is not "does it warn" — it is "does it warn about a
 * thing that is happening". A warning on a command whose sandbox is already
 * off is worse than no warning, because it teaches people to skip the line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nestedSandboxWarning as warn } from "../src/nested.js";

test("codex confines by default, so plain `codex exec` is warned about", () => {
  // Measured: inside seisin it reaches `sandbox-exec: sandbox_apply:
  // Operation not permitted` on the first command it tries to run.
  assert.match(warn(["codex", "exec", "do a thing"]), /confines the commands it runs/);
});

test("and the warning says it will not fail HERE, which is the whole point", () => {
  // The agent starts, reads, thinks, and dies on its first command. A turn
  // that did nothing reads exactly like an agent with nothing to do.
  assert.match(warn(["codex", "exec", "x"]), /does not fail here/);
});

test("with its own sandbox off, there is nothing to say", () => {
  assert.equal(warn(["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "x"]), null);
});

test("`codex sandbox` gets a different sentence, because no flag fixes it", () => {
  const w = warn(["codex", "sandbox", "--", "ls"]);
  assert.match(w, /cannot run inside one/);
  assert.doesNotMatch(w, /dangerously-bypass/, "there is no flag to suggest for this one");
});

test("gemini is the other way round: quiet unless asked to confine", () => {
  assert.equal(warn(["gemini", "-p", "x"]), null);
  assert.match(warn(["gemini", "-s", "-p", "x"]), /confines the commands/);
  assert.match(warn(["gemini", "--sandbox", "-p", "x"]), /confines the commands/);
});

test("an agent that does not sandbox itself is not mentioned", () => {
  for (const c of [["claude", "-p", "x"], ["sh", "-c", "echo"], ["node", "x.js"], []])
    assert.equal(warn(c), null, c.join(" "));
});

test("the path in front of the binary does not hide it", () => {
  assert.match(warn(["/opt/homebrew/bin/codex", "exec", "x"]), /confines the commands/);
});

test("the list is closed — opencode is absent because nobody measured it", () => {
  // A closed list is only worth having if everything in it was checked. This
  // asserts the absence so that adding it needs a measurement, not a guess.
  assert.equal(warn(["opencode", "run", "x"]), null);
});
