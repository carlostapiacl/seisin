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

/** Who owns a path, and the sentence to hand a denied agent. */
export { covers, ownersOf, keyHolders, explain, explainFileRead, readTarget } from "./owners.js";

/** A policy, resolved into sandbox settings. */
export { settingsFor } from "./srt.js";

/**
 * Keys that are references, and how a resolved value reaches a role.
 *
 * `parseKey` and `MODES` are here because reading somebody's policy means
 * knowing whether an entry is a path or a reference; `resolveRef` is not,
 * because resolving is something seisin does and not something you ask it.
 */
export { parseKey, defaultName, entriesOf, MODES } from "./keys.js";

/** What a role keeps being denied, recomputed against the policy as it stands. */
export { walls, wasted } from "./walls.js";

/** The report `check` prints, without the printing. */
export { inspect, sharedPaths } from "./inspect.js";

/** Credential-shaped content outside the declared key directories. */
export { scan } from "./scan.js";

/** The append-only record, and what can be learned from it. */
export { read as readLog, logPath, observed, generalise } from "./log.js";

/**
 * The queue of requests waiting on a person.
 *
 * `pending` and `grantFor` are public because reading the queue and drafting a
 * proposal are things a caller — including an MCP server — legitimately does.
 * `settle` and `applyGrant` are NOT exported: granting is not a tool call, and
 * the surface should make that hard to get wrong rather than merely document
 * it. See docs/permission-requests.md.
 */
export { pending as pendingRequests, requestsPath, grantFor } from "./requests.js";

/** One PreToolUse decision. */
export { decide, targetsOf } from "./hook.js";
