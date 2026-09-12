/**
 * Where seisin's own files live. Names only — no logic, no imports.
 *
 * These were spread across the modules that happened to create each file, and
 * that produced one dependency that points the wrong way: `srt.js`, whose job
 * is translating a policy into a sandbox, imported `log.js` purely to learn the
 * name of the state directory it has to keep writable. A module that decides
 * what the kernel may allow should not know that logging exists.
 *
 * A leaf with no imports is the cheapest place to put a shared name, and it
 * keeps the graph honest: everything here is depended upon, nothing here
 * depends on anything.
 */

/** The policy file, looked up from the working directory upward. */
export const CONFIG_NAME = "seisin.toml";

/** Everything seisin writes goes under this, at the policy file's directory. */
export const STATE_DIR = ".seisin";

/** The append-only record of every decision, inside STATE_DIR. */
export const LOG_NAME = "log.jsonl";
