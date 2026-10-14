/**
 * Loaded into the `srt` process with `node --import`, for a role whose
 * `browsers` need a Mach service registered (browsers.js).
 *
 * sandbox-runtime lets a policy name Mach services to look up
 * (`allowMachLookup`) and has no field for registering one, which is what a
 * Chromium browser process does first. So for those roles, and only those,
 * this adds the one rule the profile cannot otherwise carry:
 *
 *   (allow mach-register (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer."))
 *
 * It wraps `SandboxManager.wrapWithSandbox` — the module instance srt's own CLI
 * uses, loaded from beside it — and appends the rule to the profile that call
 * returns, before srt runs it. Nothing else in the profile is touched, and
 * every run still starts with the canary under the result.
 *
 * Fails closed. The names come from `mach.json` in the run's directory, which
 * seisin writes; each is checked against the shape a prefix may have before
 * it goes into the profile. And the profile must be where and what it was
 * when this was written — `/usr/bin/sandbox-exec -p '(version 1)…'`, once. If
 * a later srt builds its command another way, this throws, srt does not run
 * the command, and the canary reports a sandbox that did not start (exit 86).
 * A role that asked for a browser gets no browser; it never gets less sandbox.
 */
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MACH_FILE, withRules, fail } from "./mach-profile.js";

const at = process.argv.indexOf("--settings");
const settings = at === -1 ? null : process.argv[at + 1];
if (!settings) fail("srt was not given --settings");
const { register } = JSON.parse(readFileSync(join(dirname(settings), MACH_FILE), "utf8"));
if (!Array.isArray(register) || register.length === 0) fail(`${MACH_FILE} names nothing to register`);

// The same file srt's CLI imports as "./index.js", so the same module instance.
const cli = realpathSync(process.argv[1]);
const { SandboxManager } = await import(pathToFileURL(join(dirname(cli), "index.js")).href);
if (typeof SandboxManager?.wrapWithSandbox !== "function") fail("srt has no SandboxManager.wrapWithSandbox");
const wrap = SandboxManager.wrapWithSandbox;
SandboxManager.wrapWithSandbox = async function (...args) {
  return withRules(await wrap.apply(this, args), register);
};
