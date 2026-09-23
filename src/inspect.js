/**
 * What `check` knows, without printing any of it.
 *
 * The warnings below used to live inside the command, interleaved with the
 * writes that printed them, which made them unreachable from a test: the only
 * way to assert that seisin notices a repo sitting inside shared scratch was to
 * run the binary and grep its output. They are the most valuable thing `check`
 * does — each one is a way the policy silently does not hold — so they belong
 * where they can be exercised directly.
 */
import { resolve, dirname, basename, relative, join, delimiter } from "node:path";
import { realpathSync, lstatSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { ownersOf, covers, enforcedNeverWrites } from "./owners.js";
import { ROLE_KEYS } from "./config.js";
import { entriesOf } from "./keys.js";
import { SHAPES } from "./scan.js";
import { wired } from "./commands/wire.js";
import { RUNTIME_WRITES, CREDENTIAL_HOMES, expand, settingsFor } from "./srt.js";

/**
 * A report on one config: the roles, and every way the map lies.
 *
 * `only` narrows to a single role, and an unknown name is an error rather than
 * an empty report — asking about a role that does not exist is a typo, and
 * answering it with silence is how a typo becomes a belief.
 */
export function inspect(config, only = null, where = config.path) {
  if (only && !config.roles[only]) throw new Error(`unknown role "${only}"`);
  const roles = only ? [config.roles[only]] : Object.values(config.roles);

  return {
    where,
    roles: roles.map((r) => ({ name: r.name, writes: r.writes, keys: r.keys, neverWrites: r.neverWrites ?? [], localBinding: r.localBinding === true, localPorts: r.localPorts ?? [], mcp: r.mcp ?? null, trustd: r.trustd === true })),
    /**
     * The provider commands this config would run, listed because they are the
     * one thing in a `seisin.toml` that **executes**, and it executes in the
     * parent, unsandboxed, as you. Everything else in the file only describes a
     * boundary. `check` runs nothing, so this is where you see them first — and
     * seeing them first is the whole point when the file came with a repo you
     * cloned rather than one you wrote.
     */
    providers: Object.values(config.keyProviders ?? {}).map((p) => ({
      name: p.name, command: p.command, mode: p.mode,
    })),
    shared: sharedPaths(config, roles),
    warnings: warningsFor(config, roles),
    limits: LIMITS,
  };
}

/**
 * What the tool cannot do at all — as opposed to `warnings`, which are things
 * wrong with *this* config.
 *
 * Kept apart on purpose. A limit printed as a warning reads as something the
 * operator could fix, and after the third run it reads as nothing at all.
 *
 * These are the sentences someone needs before they trust the map on screen
 * more than it deserves, so `check` prints them every time rather than behind a
 * flag: the moment to learn that deletes are not covered is while you are
 * looking at the policy, not afterwards.
 */
const LIMITS = [
  ...(process.platform === "darwin" ? [] : [{
    kind: "kernel-denials-unreadable",
    headline: "refusals by the kernel are not recorded on this platform",
    detail:
      "on macOS `seisin run` reads them out of the system log, so a denial the hook never " +
      "saw still lands in `seisin log` with its owner and still queues a request. There is no " +
      "equivalent to read here — bubblewrap does not log refusals, and the runtime's substitute " +
      "is not reachable from outside it. The boundary holds exactly as well; what you lose is " +
      "seeing it work. Run `seisin wire` so the hook records what it can. The ask is upstream: " +
      "github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md",
  }]),
  {
    kind: "keys-only-what-you-declared",
    headline: "key isolation covers the directory you declared, and nothing else",
    detail:
      "a credential sitting in the repo outside [keys] dir is ordinary readable " +
      "content to every role. Run `seisin scan` to find them — check does not, " +
      "because reading the whole tree on every invocation is how a command stops " +
      "being run.",
  },
  {
    kind: "observe-cannot-see-the-network",
    headline: "`--observe` opens the filesystem, never the network",
    detail:
      "so it cannot tell you which domains an agent needs. The runtime does record every " +
      "refusal the proxy makes — host, port and reason — but only a caller that embeds the " +
      "library can read them; nothing reaches a caller that runs the binary, which is what " +
      "seisin does. So for an agent whose endpoints are not published, the options are to " +
      "find them another way or drop the network restriction for it. The ask is upstream: " +
      "github.com/carlostapiacl/seisin/blob/main/docs/upstream/cli-violations.md",
  },
  {
    kind: "unlink-uncovered",
    headline: "a role can delete inside its own territory",
    detail:
      // The path that used to be here ships with the repo and not with the npm
      // package, so for most readers it named a file they do not have.
      "writes and deletes are one permission to the kernel, so `rm` inside a " +
      "role's own folders succeeds. Closing it needs denyUnlink in the sandbox " +
      "runtime: github.com/carlostapiacl/seisin#how-it-holds",
  },
];

/**
 * What is wrong with a role table's keys, as opposed to its paths.
 *
 * Two things, both about `never_writes` and both ways a subtraction can look
 * written and not be:
 *
 *   - a key seisin does not know. It used to be dropped without a word, which
 *     for `writes` is a role with less than it thinks, and for a misspelt
 *     `never_writes` is a role with MORE than its owner thinks — the one
 *     direction a permission file must not fail in. Named with the nearest
 *     known key when there is one close enough to be the intended spelling.
 *   - a `never_writes` entry that no `writes` of the same role covers. It
 *     subtracts from nothing, so it is either a typo in the path or a rule
 *     that stopped applying when the territory moved. Either way it reads as
 *     protection and is not.
 *
 * Silent when `never_writes` is absent. Absent is valid; a check that asks for
 * the key would turn an optional subtraction into a required migration.
 */
function roleKeyWarnings(roles, config = null) {
  const warnings = [];
  for (const r of roles) {
    const enforced = new Set(enforcedNeverWrites(config, r));
    const skipped = (r.neverWritesDeclared ?? r.neverWrites ?? []).filter((g) => !enforced.has(g));
    if (skipped.length)
      warnings.push({
        kind: "never-writes-not-enforced-here",
        headline: `${r.name}: never_writes ${skipped.join(" ")} — not enforced on Linux until it exists`,
        detail: "bubblewrap denies a path by mounting over it, and would create a missing one on the host " +
          "for the whole run — for a lock file, locking everyone else out, and for good if the role is " +
          "killed. seisin skips those, and explain says allowed for them, so the sentence matches the kernel.",
      });
    for (const k of r.unknownKeys ?? []) {
      const near = nearest(k, ROLE_KEYS);
      warnings.push({
        kind: "unknown-role-key",
        headline: `${r.name}: unknown key "${k}" in [roles.${r.name}] — ignored` +
          (near ? `. Did you mean "${near}"?` : ""),
        detail: `Known keys: ${ROLE_KEYS.join(", ")}. ` +
          (near === "never_writes"
            ? "As written this subtracts nothing: the role can still write every path it lists."
            : "Nothing in it takes effect."),
      });
    }
    // macOS only, and not by omission: on Linux the runtime removes the network
    // namespace, so every role already has a loopback of its own — it can serve
    // and reach its own server with or without the key, and reaches nothing on
    // the host either way (measured in Docker, Debian 12, bwrap 0.8.0).
    if (r.localBinding && process.platform === "darwin")
      warnings.push({
        kind: "local-binding-reaches-localhost",
        headline: `${r.name}: local_binding lets it connect to every port on localhost, not only listen`,
        detail: "The runtime grants bind on any interface, inbound, and outbound to localhost:*. " +
          "Anything listening on this machine without authentication — a local control API, a " +
          "database, a dev server — is within this role's reach, outside its territory.",
      });
    // Both at once is a config that says "these ports" and grants "every port".
    // macOS only: on Linux local_binding reaches nothing on the host, so there
    // local_ports is the only one of the two that does anything.
    if (r.localBinding && r.localPorts?.length && process.platform === "darwin")
      warnings.push({
        kind: "local-ports-moot",
        headline: `${r.name}: local_ports names ${r.localPorts.join(", ")}, but local_binding already opens every localhost port`,
        detail: "local_binding grants outbound to localhost:* in the kernel profile, so the port list " +
          "restricts nothing for this role. Drop local_binding if the role only needs to reach " +
          "those ports; keep it only if the role has to listen.",
      });
    // trustd is a macOS service; on Linux the key changes nothing.
    if (r.trustd && process.platform === "darwin")
      warnings.push({
        kind: "trustd-open",
        headline: `${r.name}: trustd = true opens com.apple.trustd.agent, a path out that the domain list does not see`,
        detail: "trustd verifies certificates for Go (before 1.27) and Dart on macOS, and to do it fetches, " +
          "outside the sandbox, the URLs a certificate carries. The runtime calls it an exfiltration vector; " +
          "no public demonstration exists. Go 1.27+ does not need it: seisin sets SSL_CERT_FILE.",
      });
    for (const g of r.neverWrites ?? []) {
      if (r.writes.some((w) => covers(w, g) || covers(w, g.replace(/\/\*\*$/, ""))))
        continue;
      warnings.push({
        kind: "never-writes-subtracts-nothing",
        headline: `${r.name}: never_writes "${g}" is not inside any of its writes`,
        detail: "It denies something that was already denied, so it protects nothing. " +
          "Check the path, or drop the entry if the territory moved.",
      });
    }
  }
  return warnings;
}

/** The candidate within edit distance 3 of `word`, or null. */
function nearest(word, candidates) {
  // Spellings of the same idea in another vocabulary, checked first because
  // letters mislead here: `no_writes` is three edits from `writes`, and
  // suggesting the grant for a misspelt subtraction is the worst answer.
  if (/deny|never|no_?write/i.test(word)) return "never_writes";
  let best = null, bestD = 4;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * Paths more than one role claims.
 *
 * Overlap is allowed and sometimes right — a hotfix role deliberately reaches
 * into the territory of the role that normally owns a repo. It is reported so
 * that it stays a decision somebody made rather than a thing that drifted.
 */
export function sharedPaths(config, roles = Object.values(config.roles)) {
  const seen = new Set();
  for (const r of roles)
    for (const glob of r.writes)
      if (ownersOf(config, glob.replace(/\/\*\*$/, "")).length > 1) seen.add(glob);
  /**
   * A shared database counts once, not four times.
   *
   * `writes` carries the sidecar expansion so that the grant and the sentence
   * agree (see config.js), and this list read straight off it turned nine
   * shared things into thirty-three — the same name with three suffixes,
   * announced as if it were three more decisions to make. The expansion exists
   * to stop a policy saying one thing four times; a warning that undoes that
   * is the feature leaking into the place it was meant to clean up.
   *
   * A sidecar shared WITHOUT its database still counts on its own, because
   * that is a real and odd thing to have.
   */
  const todas = new Set(seen);
  return [...seen].filter((p) => !(/-(wal|shm|journal)$/.test(p) && todas.has(p.replace(/-(wal|shm|journal)$/, ""))));
}

/**
 * What a role can still read in YOUR home, which is the limit people are most
 * surprised by.
 *
 * `~/.ssh`, `~/.aws/credentials`, `~/.npmrc` and `~/.config/gh/hosts.yml` are
 * ordinary readable files to every role unless `[runtime] isolate` says
 * otherwise, and nothing on screen said so. Reads outside the key directories
 * being open is a deliberate trade - an agent that cannot read the machine
 * cannot work - but a trade nobody was shown is not a trade they made.
 *
 * It reports the level rather than pushing one. `credentials` closes those four
 * and leaves the agent logged in; `home` closes the agent's own directories too
 * and costs the session. Which of the two you want is the threat model, which
 * is why there is no default beyond off.
 */
function homeReachWarning(config) {
  const level = config.isolate === true ? "home" : config.isolate;
  if (level === "home") return null;             // nothing left to say

  const where = CREDENTIAL_HOMES.slice(0, 4).join(" ");
  return level === "credentials"
    ? {
        kind: "home-partly-open",
        headline: "your credentials are closed to every role; the agent's own directories are not",
        detail:
          `isolate = "credentials" denies ${where} and the rest. What stays open is ` +
          "~/.claude and ~/.codex, which is what keeps the agent logged in, so the roles " +
          'share one session and can read each other. `isolate = "home"` closes those ' +
          "too, and then every CLI in the box will ask you to log in again.",
      }
    : {
        kind: "home-open",
        headline: `every role can read ${where} and the rest of your home`,
        detail:
          "reads outside the [keys] dir are open on purpose - an agent that cannot read the " +
          "machine cannot work - but that includes the places credentials live. " +
          '`[runtime] isolate = "credentials"` closes them, and the agent stays logged in.',
      };
}


/** Every way this policy does not hold, each with what to do about it. */
/**
 * Credential-shaped names at the top of the repository, and nothing deeper.
 *
 * One `readdir`, no recursion, conventional names only. It exists to answer
 * "does this repo plausibly have secrets" fast enough to run on every `check`,
 * not to find them — `seisin scan` is the one that looks properly.
 */
const CREDENTIAL_NAMES = /^(\.env(\..+)?|\.secrets|secrets|\.netrc|.*\.(pem|key|p12|pfx))$/i;

function credentialish(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = new Set(entries.filter((e) => CREDENTIAL_NAMES.test(e.name)).map((e) => e.name));

  /**
   * And the ones whose name gives nothing away.
   *
   * The name test misses `credentials.txt`, `tokens.conf`, `config.local` —
   * which a field review found by writing a test file this did not catch, and
   * then blaming the test. The test was fine; the detector was name-only.
   *
   * So the root's small text files are also read, with the same shapes
   * `seisin scan` uses. Root only, small only, and it stops at the first hit
   * per file: this runs on every `check` and the full walk is `scan`'s job.
   */
  const CERTAIN = SHAPES.filter(([c]) => c === "certain").map(([, , re]) => re);
  for (const e of entries) {
    if (found.size >= 4) break;
    if (!e.isFile() || found.has(e.name)) continue;
    try {
      const p = join(root, e.name);
      if (statSync(p).size > 64 * 1024) continue;
      const text = readFileSync(p, "utf8");
      if (CERTAIN.some((re) => re.test(text))) found.add(e.name);
    } catch {
      /* unreadable, or not text: not our business here */
    }
  }
  return [...found].sort().slice(0, 4);
}

/** Is this a command the shell would find? Walks PATH; asks no shell. */
function onPath(cmd) {
  if (cmd.includes("/")) return existsSync(cmd);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((d) => existsSync(join(d, cmd)));
}

function warningsFor(config, roles) {
  const warnings = [];

  // A pattern the kernel cannot be given is not a policy, it is a sentence that
  // reads like one. `run` refuses it; `check` exists precisely so you find that
  // out while reading the map rather than mid-turn.
  for (const r of roles) {
    try {
      settingsFor(config, r.name);
    } catch (e) {
      // Whatever settingsFor refuses, `run` will refuse too. The label used to
      // say "unenforceable-glob" for every one of them, which mislabelled the
      // key-outside-its-directory error as a glob problem — a warning that
      // names the wrong cause sends the reader to the wrong line.
      warnings.push({
        kind: "cannot-be-enforced",
        headline: `${r.name}: ${e.message.split("\n")[0]}`,
        detail: e.message.split("\n").slice(1).map((s) => s.trim()).filter(Boolean).join(" "),
      });
    }
  }
  warnings.push(...roleKeyWarnings(roles, config));
  const shared = sharedPaths(config, roles);

  if (shared.length)
    warnings.push({
      kind: "shared",
      headline: `${shared.length} path(s) claimed by more than one role: ${shared.join(" ")}`,
      detail: "Overlap is allowed — seisin will name every owner. It is listed so it stays a decision.",
    });

  // Scratch is granted to every role, so a repo sitting inside it is writable
  // by all of them no matter what the territory says. Saying so is the
  // difference between a limitation and a trap — and it is not hypothetical:
  // the test fixture lived in the temp dir and made a boundary test pass for
  // the wrong reason.
  // Both sides resolved, or the comparison is a coin flip. `expand()` follows
  // symlinks — it has to, because on macOS /tmp is a link to /private/tmp and a
  // grant written as /tmp grants nothing — so the root has to be followed too.
  // Without this a repo at /tmp/x is never reported as sitting in scratch,
  // which is the one case where the warning matters most.
  const scratch = (config.runtimeWrites ?? RUNTIME_WRITES).map(expand);
  const root = realOrSelf(resolve(config.root));
  const inside = scratch.filter((s) => root === s || root.startsWith(s + "/"));
  if (inside.length)
    warnings.push({
      kind: "scratch",
      headline: `this repo lives inside shared scratch space (${inside[0]})`,
      detail: "Every role can write scratch, so territory does not hold here. Move the repo, or set [runtime] writes = [].",
    });

  /**
   * A role that can write code and cannot reach any inference API.
   *
   * Reported three separate times, by three different people, with the same
   * shape each time: a list of what agents need, written somewhere that does
   * not know which agent will run. The last instance cost six bench runs that
   * finished in eight seconds with `403 Connection blocked by network
   * allowlist` — which in a results table reads as "this model cannot do the
   * task", not as a policy error.
   *
   * What is deliberately NOT here: a registry of agents and their endpoints.
   * That is the same defect in a new place, and the reporter said so before I
   * could. The list below is only ever consulted to decide whether to print a
   * sentence, so being wrong about it costs a false warning — never a broken
   * run. That asymmetry is the whole reason it is allowed to exist, and the
   * warning says out loud that the list is ours and may not know your agent.
   */
  const INFERENCE = /(anthropic|openai|googleapis|generativelanguage|bedrock|azure|openrouter|mistral|groq|together|deepseek|x\.ai|cohere|ollama|localhost|127\.0\.0\.1)/i;
  for (const r of roles) {
    const domains = r.network ?? config.allowedDomains ?? [];
    if (domains.some((d) => INFERENCE.test(d))) continue;
    warnings.push({
      kind: "no-model-endpoint",
      headline: domains.length
        ? `${r.name} has ${domains.length} allowed domain(s) and none looks like a model API`
        : `${r.name} may reach no network at all`,
      detail:
        "an agent that cannot reach its own model fails at startup with a 403 from the " +
        "egress proxy, which reads as a broken install or a bad model rather than a policy. " +
        "This check knows a handful of providers and will not know yours — it is a question, " +
        "not a verdict.",
    });
  }

  // Without the hook, half the record is missing rather than all of it: on macOS
  // `seisin run` reads the kernel's own refusals, so denials still land and
  // still queue a request. What goes unrecorded is everything the kernel
  // allowed — which is the half `init --from-observations` is built out of, and
  // the half that tells "nothing was denied" apart from "nobody was watching".
  // The one limit that is about YOUR machine rather than about the repo.
  const reach = homeReachWarning(config);
  if (reach) warnings.push(reach);

  if (!wired(config.root))
    warnings.push({
      kind: "hook-not-wired",
      headline: "only denials are being recorded: the agent has not been told to run the hook",
      detail:
        process.platform === "darwin"
          ? "the boundary holds either way, and refusals are still logged and still queue a " +
            "request — `seisin run` reads them from the kernel. What is missing is every " +
            "action that was allowed, so `review` cannot tell you which grants are dead and " +
            "`init --from-observations` has nothing to build from. Run `seisin wire` once in " +
            "this repo."
          : "the boundary holds either way — but on this platform the kernel's refusals are " +
            "not readable either, so log, watch, requests, grant and review all read a record " +
            "that nobody is writing. Run `seisin wire` once in this repo.",
    });

  // A territory that leaves the repo is supported — a role can own its handover
  // note one level up — but it is a different promise from "this repo, divided",
  // and it should be a sentence somebody chose rather than a line that drifted.
  const loose = [];      // roles granting individual files
  const listed = [];     // role + folder pairs that enumerate

  for (const r of roles) {
    const out = r.writes.filter((w) => w.startsWith("/") || w.startsWith("../"));
    if (out.length)
      warnings.push({
        kind: "territory-outside-repo",
        headline: `${r.name} writes outside this repo: ${out.join(" ")}`,
        detail: "the sandbox will grant it. Nothing here checks what lives there.",
      });
  }

  /**
   * A file granted by name does not come with its neighbours.
   *
   * Measured, in production, and it survived two human reviews of the policy:
   * a role was granted its database file and still could not write the
   * database. The database opens a second file beside the first — a journal —
   * and the sibling was outside the grant, so the write failed in the
   * database's own words ("readonly") rather than as a permission error.
   *
   * What is deliberately NOT here: a list of which programs write which
   * siblings. That would ask seisin to know about databases, and the next
   * question is why it does not know about a lock file, the temporary file of
   * an atomic write, or an editor's backup. The list has no end and every entry
   * is a guess about a repo nobody foresaw. The general form needs no list: the
   * kernel grants a path and everything under it, so a grant on a file covers
   * the file and nothing else. Whether a tool will want a neighbour is the
   * reader's to know; that the neighbour is not granted is arithmetic.
   */
  for (const r of roles) {
    const { files, subtrees } = territoryOf(config, r);
    // A file inside one of the role's own subtrees has its siblings covered by
    // that subtree, so naming it changes nothing and warns about nothing.
    const alone = files.filter((f) => !subtrees.some((s) => under(dirname(f.abs), s)));
    if (alone.length)
      loose.push({ role: r.name, n: alone.length, of: r.writes.length, globs: alone.map((f) => f.glob) });


    /**
     * A territory written as a list of files is a photograph of the folder.
     *
     * A sandbox cannot say "the source files in this folder" — one level down
     * is not a prefix, and `src/*` is refused above for exactly that reason,
     * correctly. So a territory that means that has to be written as the files
     * that exist today, and the day a file is added the policy is one behind:
     * the owning role cannot write its own new file, and nothing fails loudly.
     *
     * Reported as a count, never as a verdict. "Comparable" here means only
     * "a regular file in the same folder" — not the same extension, not the
     * same shape of name, because either of those is a guess about what the
     * territory *meant*, and a guess about intent is the thing this check
     * exists to avoid. The unnamed files are listed by name instead, so the
     * reader can see in one glance whether the gap is an oversight or a
     * decision. seisin cannot tell, and does not pretend to.
     *
     * Silent when a folder has fewer than two named files (one file is a
     * grant, not an enumeration) and when the folder is also granted as a
     * subtree (then the list is decorative).
     */
    const byDir = new Map();
    for (const f of alone) {
      const dir = dirname(f.abs);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(basename(f.abs));
    }
    for (const [dir, named] of byDir) {
      if (named.length < 2) continue;
      const onDisk = regularFilesIn(dir);
      const unnamed = onDisk.filter((n) => !named.includes(n));
      if (!unnamed.length) continue;
      const shown = relative(resolve(config.root), dir);
      const more = unnamed.length > 8 ? ` … and ${unnamed.length - 8} more` : "";
      listed.push({ role: r.name, named: named.length, total: onDisk.length,
                    where: shown ? shown + "/" : "the repo root", unnamed });

    }
  }

  /**
   * One warning per finding, not one per role.
   *
   * These were emitted inside the role loop, which reads fine on the two-role
   * fixture they were written against and falls apart on a real policy: 30
   * roles produced 39 of these lines and took `seisin check` from 30 lines to
   * **297**. That is the defect the detail text below is about — a check nobody
   * finishes reading protects nobody — reached from the other side.
   *
   * So the count leads and a few examples follow. Whoever wants the full list
   * has `seisin check <role>`, which is the question they were asking anyway.
   */
  if (loose.length) {
    const shown = loose.slice(0, 3).map((l) => `${l.role} (${l.n} of ${l.of})`).join(", ");
    const more = loose.length > 3 ? `, and ${loose.length - 3} more` : "";
    warnings.push({
      kind: "siblings-uncovered",
      headline:
        `${loose.length} role(s) grant individual files rather than folders: ${shown}${more}`,
      detail:
        "the kernel grants exactly that path. Anything a tool creates beside it — a " +
        "database's journal, a lock file, the temporary file of an atomic write — is a " +
        "sibling, and a sibling is outside the grant; the failure arrives in the tool's " +
        "own words, not as a permission error. Grant the folder where the tool needs " +
        "neighbours. `seisin check <role>` names the paths for one role.",
    });
  }

  if (listed.length) {
    const shown = listed.slice(0, 3)
      .map((l) => `${l.role} names ${l.named} of ${l.total} in ${l.where}`).join("; ");
    const more = listed.length > 3 ? `; and ${listed.length - 3} more` : "";
    warnings.push({
      kind: "enumerated-territory",
      headline: `${listed.length} territory(ies) list some files of a folder: ${shown}${more}`,
      detail:
        `not named, in the first of them: ${listed[0].unnamed.slice(0, 8).join(" ")}` +
        `${listed[0].unnamed.length > 8 ? ` … and ${listed[0].unnamed.length - 8} more` : ""}` +
        `. A sandbox grants a path, ` +
        `not "the files of this kind here", so a territory that means that is the list of files ` +
        `that existed when it was written — the next one added lands outside it, and nothing ` +
        `fails loudly. Whether these are left out on purpose is not something a count can tell.`,
    });
  }

  // `env` is a hole in the [keys] model, on purpose: some tools only take a
  // credential through the environment. It should still be loud, because it is
  // the one place a secret reaches a role without being a declared key.
  const SECRETISH = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|SESSION|PRIVATE|CREDENTIAL)/i;
  for (const r of roles) {
    const risky = (r.env ?? []).filter((n) => SECRETISH.test(n));
    if (risky.length)
      warnings.push({
        kind: "secret-through-env",
        headline: `${r.name} receives ${risky.join(", ")} through the environment`,
        detail:
          "that bypasses [keys] entirely: it is not scoped, not redacted by name, and not " +
          "visible in the key map. Declare it as a key file where the tool allows one.",
      });
  }

  /**
   * A policy with no credential floor at all, in a repo that has credentials.
   *
   * `[keys] dir` is what produces `denyRead`. Without it the emitted settings
   * carry an empty deny list, so every role reads every secret in the
   * repository — and until this warning, nothing said so. The existing
   * `keys-unscoped` only fires when a role *lists* keys, which is the case
   * where somebody already thought about it.
   *
   * The dangerous shape is the other one, and it is not hypothetical: a policy
   * generated by a script. The deployment this was built against generates its
   * `seisin.toml` from a Python program, and declares `[keys] dir` mostly so
   * `scan` skips those directories. A generator that dropped that one line
   * would hand every role the credential tree and produce a clean `check`.
   *
   * Credit where it is due: this is `L-01` of a code review of another
   * project's contract type, which makes its credential floor impossible to
   * construct empty. That is the right shape and it is a bigger change than a
   * warning. This is the cheap half — and the review's claim that the file
   * path was safe turned out to be generous: it was not.
   *
   * Deliberately NOT a full `seisin scan`: that walks the tree and `check` has
   * to stay instant. A shallow look at the repository root catches the
   * conventional places and costs one `readdir`.
   */
  if ((config.keyDirs ?? []).length === 0) {
    const found = credentialish(config.root);
    if (found.length)
      warnings.push({
        kind: "no-key-floor",
        headline: `no [keys] dir is declared, and this repo has ${found.join(", ")} — every role can read them`,
        detail:
          "Without a key directory the emitted policy denies no reads at all. Declare the " +
          "directory your secrets live in, and the roles that may read each one.",
      });
  }

  // Only a key that is a PATH needs a key directory. A config whose secrets all
  // live in a vault has no `[keys] dir` and nothing wrong with it, and warning
  // there would be the tool insisting on the arrangement it was built for.
  if (config.keyDirs.length === 0 &&
      Object.values(config.roles).some((r) => entriesOf(r).some((k) => k.kind === "file")))
    warnings.push({
      kind: "keys-unscoped",
      headline: "keys are listed but [keys] dir is unset — nothing will be scoped",
      detail: null,
    });

  /**
   * A provider whose command is not on PATH.
   *
   * This is the half of validating references that can be done without
   * resolving one — which is the whole requirement: a broken policy has to be
   * visible in `check`, not on the first run, and certainly not by asking
   * somebody's keychain for a password to find out. The scheme and the
   * provider are checked when the config loads, so by the time we are here
   * they exist; what is left is whether the command does.
   *
   * A warning and not an error: the binary can legitimately be missing on the
   * machine reading the policy and present on the one that runs it, which is
   * every CI checkout.
   */
  const used = new Set();
  for (const r of Object.values(config.roles))
    for (const k of entriesOf(r)) if (k.kind === "ref") used.add(k.scheme);
  for (const scheme of [...used].sort()) {
    const provider = config.keyProviders?.[scheme];
    if (!provider || onPath(provider.command[0])) continue;
    warnings.push({
      kind: "provider-missing",
      headline: `the ${scheme} provider runs "${provider.command[0]}", which is not on PATH`,
      detail:
        "every key of that scheme will stop the run rather than resolve. Nothing is " +
        "substituted for a key that did not resolve, so this fails closed — but it fails " +
        "at the start of a turn, not here.",
    });
  }

  return warnings;
}

/**
 * A role's territory, sorted by what the kernel will do with each line.
 *
 * Three shapes get through `settingsFor` (see EXPRESSIBLE in srt.js): the whole
 * repo, a subtree `x/**`, and a literal path. The literal path is the one the
 * text cannot settle on its own — `data/base.sqlite` and `data` are both
 * literal, and to the kernel the second is a subtree because it is a directory.
 * So the disk is asked, once per line: a regular file is a file, a directory is
 * a subtree, and anything else — absent, a symlink, a socket — goes in neither
 * count rather than being guessed at. That is one `lstat` per declared path,
 * bounded by the length of the policy and not the size of the repo, which is
 * the line `check` stays on.
 *
 * Subtrees come back as the absolute prefix the kernel will be handed, so that
 * "is this file's folder inside that grant" is the same comparison the kernel
 * makes — a prefix — and not a second reading of the glob.
 */
function territoryOf(config, role) {
  const root = resolve(config.root);
  const abs = (p) => resolve(root, p);
  const files = [];
  const subtrees = [];
  for (const glob of role.writes) {
    if (glob === "**" || glob.endsWith("/**")) {
      subtrees.push(abs(glob === "**" ? "." : glob.slice(0, -3)));
      continue;
    }
    if (/[*?[\]]/.test(glob)) continue;      // already refused above as cannot-be-enforced
    const s = lstatOrNull(abs(glob));
    if (s?.isFile()) files.push({ glob, abs: abs(glob) });
    else if (s?.isDirectory()) subtrees.push(abs(glob));
  }
  return { files, subtrees };
}

/** Is `p` the prefix, or somewhere beneath it. The kernel's own test, in one line. */
function under(p, prefix) {
  return p === prefix || p.startsWith(prefix + "/");
}

/** The regular files directly inside `dir`, by name. Not folders, not links, not deeper. */
function regularFilesIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** The path with symlinks followed, or the path itself if it is not on disk. */
function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
