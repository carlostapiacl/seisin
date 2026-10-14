/**
 * The splice srt-mach.mjs makes into srt's profile, kept apart so it can be
 * tested without loading into srt. See srt-mach.mjs for why it exists.
 */
import { MACH_PREFIX } from "../browsers.js";

export const MACH_FILE = "mach.json";
const ANCHOR = "/usr/bin/sandbox-exec -p '";

export function fail(why) {
  throw new Error(`seisin: cannot add the browser's Mach rule to the sandbox profile: ${why}`);
}

/** The profile with the rules appended, or an Error: exported so the splice is tested without srt. */
export function withRules(line, register) {
  for (const name of register) if (!MACH_PREFIX.test(name)) fail(`"${name}" is not a Mach name prefix`);
  const at = line.indexOf(ANCHOR);
  if (at === -1) fail("srt no longer runs sandbox-exec with an inline profile");
  if (line.indexOf(ANCHOR, at + 1) !== -1) fail("the command holds more than one profile");
  const start = at + ANCHOR.length;
  // Single-quoted by srt's quote(), which writes a quote inside it as '"'"'
  // (a comment in the profile says "doesn't"). The quote that ends it is the
  // first one that does not open that sequence, and the shell's path follows.
  let end = line.indexOf("'", start);
  while (end !== -1 && line.startsWith(`'"'"'`, end)) end = line.indexOf("'", end + 5);
  if (end === -1 || line[end + 1] !== " ") fail("the profile is not quoted the way it was");
  if (!line.slice(start, end).startsWith("(version 1)")) fail("the profile does not start with (version 1)");
  const rules = register.map((p) => `(allow mach-register (global-name-prefix "${p}"))`).join("\n");
  return `${line.slice(0, end)}\n; seisin: browsers (src/browsers.js)\n${rules}\n${line.slice(end)}`;
}

