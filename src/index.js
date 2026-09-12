/**
 * The public surface. Everything not re-exported here is internal and may move.
 *
 * Drawing this line is the point of the file. Without it every function in
 * `src/` is de facto public, which means either nothing can be refactored or
 * somebody's build breaks when it is. The rule applied below: a thing is public
 * if you would need it to make a decision — what is allowed, who owns a path,
 * what the policy resolves to. Rendering, dispatch and process handling are not.
 *
 *   import { loadConfig, explain } from "seisin";
 *
 * The CLI is the other entry point and uses exactly the same functions.
 */

/** Reading and validating a policy file. */
export { findConfig, loadConfig, parseToml } from "./config.js";

/** Where seisin's own files live. */
export { CONFIG_NAME, STATE_DIR, LOG_NAME } from "./layout.js";

/** Who owns a path, and the sentence to hand a blocked agent. */
export { covers, ownersOf, keyHolders, explain } from "./owners.js";

/** A policy, resolved into sandbox settings and a child environment. */
export { settingsFor, RUNTIME_WRITES, expand } from "./srt.js";
export { buildEnv, BASE as BASE_ENV } from "./env.js";

/** The report `check` prints, without the printing. */
export { inspect, sharedPaths } from "./inspect.js";

/** Credential-shaped content outside the declared key directories. */
export { scan, SHAPES, DEFAULT_IGNORE } from "./scan.js";

/** The append-only record, and what can be learned from it. */
export { read as readLog, logPath, observed, generalise } from "./log.js";

/** One PreToolUse decision. */
export { decide, targetsOf } from "./hook.js";

/** Masking a role's own secrets on the way out. */
export { secretsOf, redactor } from "./redact.js";
