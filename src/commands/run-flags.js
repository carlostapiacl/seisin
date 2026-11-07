/**
 * What `seisin run` reads off its own argv, before the `--`: which agent, which
 * run, which request it takes and which denials the caller expects.
 *
 * Apart from run.js, which starts the sandbox, because none of this touches it:
 * each is a pure answer to "what did the caller ask for", and run.js re-exports
 * them where callers and the tests have always found them.
 */
import { agentOf, AGENTS, AGENT_HOMES } from "../srt-settings.js";
import { queueOf } from "../requests.js";
import { chainFrom, describeHandoff } from "../handoff.js";
import { flagsOf } from "../help.js";
import { WILD } from "../paths.js";

/**
 * Ours before the `--`, theirs after it.
 *
 * `argv.includes("--observe")` scanned the whole line, so `seisin run x --
 * claude --observe` put seisin into observe mode over a flag that belonged to
 * the agent. It is the same mistake the `--` separator was added to stop srt
 * making with the agent's flags, made one layer up.
 */
export function splitRunArgv(argv) {
  const split = argv.indexOf("--");
  const role = argv[0];
  let mine, cmd;
  if (split !== -1) {
    mine = argv.slice(1, split);
    cmd = argv.slice(split + 1);
  } else {
    // No `--`: seisin's own flags are the leading `-options` only. From the
    // first token that is not an option, everything is the command — its own
    // flags are its business. `seisin run x echo hi --observe` used to read
    // `--observe` as seisin's and put the run in observe mode; now that flag
    // belongs to `echo`, and observe needs `seisin run x --observe -- echo hi`.
    let i = 1;
    const values = flagsOf("run").values;
    while (i < argv.length && argv[i].startsWith("-")) i += values.includes(argv[i]) ? 2 : 1;
    mine = argv.slice(1, i);
    cmd = argv.slice(i);
  }
  return { role, mine, cmd };
}

/**
 * Which agent this run is: `--agent <name>` when given, else read off the
 * command. It decides whose home is scratch and whose sign-in is closed (see
 * AGENT_HOMES in grants.js). `--agent none` says "no agent", for a run that
 * must get neither home whatever its command looks like.
 */
export function agentFor(mine, cmd) {
  const at = mine.lastIndexOf("--agent");
  if (at === -1) return agentOf(cmd);
  const given = mine[at + 1];
  if (given === "none") return null;
  if (!AGENTS.includes(given))
    throw new Error(
      `--agent ${given ?? ""}: seisin knows ${AGENTS.join(", ")} and none.\n` +
      `  It decides whose home a run may write (${AGENTS.map((a) => AGENT_HOMES[a]).join(", ")}) ` +
      `and whose sign-in it cannot read.`);
  return given;
}

/**
 * `--run-id <id>`: the launcher's own id for this run (an orchestrator's ULID),
 * used instead of a random one wherever the run is named. Letters, digits, `-`
 * and `_`, 64 at most: it becomes part of a directory name and of log lines.
 */
export function runIdOf(mine) {
  const at = mine.lastIndexOf("--run-id");
  if (at === -1) return null;
  const id = mine[at + 1];
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new Error(`--run-id ${id ?? ""}: letters, digits, "-" and "_" only, 64 at most`);
  return id;
}

/**
 * `--handoff <id>`: this run is the role a pending request was handed to.
 *
 * The flag names a request, never a role. Which role takes it is the decision
 * handoff.js makes from the policy as it stands, and a run of any other role
 * is refused — so whatever starts roles can act on `handoff.role` but cannot
 * substitute its own choice, and a model upstream of it choosing "backend"
 * changes nothing. What the run carries forward is the chain the decision
 * extends; every request it files is recorded in that chain, which is how a
 * cycle back to a role the work came from, or a chain past its depth, is
 * caught instead of routed.
 */
export function handoffOf(config, role, mine) {
  const at = mine.indexOf("--handoff");
  if (at === -1) return null;
  // Said before the request is looked up: whatever the id, this role is not
  // one the policy hands work to, and that is the answer.
  if (config.roles[role]?.handoff === false)
    throw new Error(`${role} does not take handed work (handoff = false in its role): no request is handed to it. Nothing was started.`);
  const id = mine[at + 1];
  if (!id || id.startsWith("-")) throw new Error("usage: seisin run <role> --handoff <id> -- <command...> (the id from seisin requests)");
  const request = queueOf(config).find((r) => r.key === id);
  if (!request) throw new Error(`no pending request has the id "${id}" — seisin requests lists them`);
  const d = request.handoff;
  if (d.type !== "route")
    throw new Error(`${id} is not handed to anybody: ${describeHandoff(d, request.attempt)}. Nothing was started.`);
  if (d.role !== role)
    throw new Error(`${id} is handed to ${d.role}, not ${role}: the policy decides who takes it. Nothing was started.`);
  return { request, chain: chainFrom(d) };
}

/**
 * `--expect-denied <path>`, as many times as given: the paths whose denial the
 * caller is waiting for (intake.js). Read from this process's argv and nowhere
 * else — not the environment, not a file in the repo — because everything
 * else is something the sandboxed side could reach, and a list it could add
 * to would be a way to keep its own denials out of the queue.
 *
 * Or a port, `tcp:<port>`, for a canary that dials a decoy: the kernel's denial
 * names only the port, so a real connection to that same port in the same run
 * would read as expected too. The caller picks a port nothing else would dial.
 *
 * A path, exactly. A glob is refused rather than read literally: `*` meaning
 * "this one file" is not what anyone who typed it meant, and meaning "every
 * file" would make a probe a way to silence a whole directory.
 */
export function expectedDenials(mine) {
  const out = [];
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] !== "--expect-denied") continue;
    const p = mine[++i];
    if (!p || p.startsWith("-") || !p.trim())
      throw new Error("usage: seisin run <role> --expect-denied <path> -- <command...> (a path, relative to the repo or absolute)");
    if (WILD.test(p))
      throw new Error(`--expect-denied ${p}: a path, not a pattern. Only a denial of exactly that path is expected; ` +
        `name each one with its own --expect-denied.`);
    if (/^tcp:/.test(p) && !(/^tcp:\d{1,5}$/.test(p) && Number(p.slice(4)) >= 1 && Number(p.slice(4)) <= 65535))
      throw new Error(`--expect-denied ${p}: a port is tcp:<1-65535>.`);
    out.push(p);
  }
  return out;
}
