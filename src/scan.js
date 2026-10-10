/**
 * Finds credential-shaped content that is NOT under a declared key directory.
 *
 * seisin scopes what a role may read from the directories you named. Every
 * secret living somewhere else is readable by every role, because reads outside
 * the denied paths stay open — an agent has to be able to read the repo.
 *
 * So the honest completion of "seisin protects your keys" is a command that
 * says which keys it is not protecting. This is that command. It reports and
 * never edits: moving a credential breaks whatever reads it today, and that is
 * a decision, not a cleanup.
 *
 * ── Why this file is mostly about precision ──
 * The first version was run against a real 18,000-file tree and returned 200
 * findings, of which 5 had a specific shape and 2 were actual credentials. A
 * scanner at that ratio does not get read a second time, which makes it worse
 * than no scanner: it converts a real risk into a wall of noise someone learns
 * to skip. Three things were wrong and all three are handled below.
 */
import { readdirSync, readFileSync, statSync, realpathSync, existsSync } from "node:fs";
import { join, resolve, relative, sep, dirname } from "node:path";
import { covers } from "./owners.js";
import { toWritePath } from "./grants.js";

/**
 * A match is `certain` when the shape alone is enough — these strings are
 * issued by a provider and do not occur by accident. It is `review` when the
 * shape only says "this line talks about a secret", which is true of a great
 * deal of ordinary code.
 *
 * The split is the point. Mixing them produces one list nobody triages; keeping
 * them apart lets `certain` be the thing that fails a build.
 */
export const SHAPES = [
  ["certain", "private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["certain", "Anthropic/OpenAI key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["certain", "GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["certain", "AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["certain", "Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["certain", "Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["certain", "Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ["certain", "JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["review", "assigned secret", /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*\s*[=:]\s*["']?([^\s"'#,;)]{12,})/i],
];

/**
 * The value is code, not a secret.
 *
 * `TOKEN = os.environ["TOKEN"]` matches every naive secret pattern ever
 * written, and it is the single most common line in any codebase that handles
 * secrets *correctly*. Measured on the real tree: 46 of 159 loose findings were
 * exactly this — the scanner was flagging the good practice.
 */
const REFERENCE = /(os\.environ|process\.env|import\.meta\.env|getenv|ENV\[|Deno\.env|config\(|settings\.|secrets\.|\$\{|\$\(|%\(|\{\{|<%|%s|%d|\.get\(|request\.|req\.|headers\[|params\[|argv|prompt\(|input\()/i;

/** Values that are obviously not secrets, however secret-shaped the name is. */
const PLACEHOLDER = /^(?:changeme|change_me|xxx+|your[-_a-z]*|example|placeholder|dummy|sample|redacted|null|none|true|false|test|todo|fixme|\.{3}|-+|\*+)$/i;

/**
 * Paths skipped by default.
 *
 * Two kinds, and both were learned the same way. Machinery nobody wrote
 * (`node_modules`, `dist`) has always been obvious. What was not: caches of
 * pages fetched from other people's sites, and `.bak` copies of a config, which
 * between them produced most of the noise in the first real run — the same
 * finding repeated five times, and three keys belonging to a company that is
 * not the one running the scan.
 */
/**
 * A password inside a URL — `postgres://app:hunter2@db/prod`.
 *
 * The commonest way a database credential sits in a repo, and no issued shape
 * covers it: `.env` with a DATABASE_URL scanned clean. Certain, because a URL
 * with a password in it is a credential whatever the password is, unless the
 * password is plainly a stand-in (`password`, `${DB_PASS}`, `<pass>`, `xxx`).
 */
export const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@\/'"]+):([^\s@\/'"]+)@[^\s\/'"]+/i;
const PASSWORD_STANDIN = /^(?:pass(?:word)?|passwd|pwd|pw|secret|user|username)$|[{}$<>%]/i;

/**
 * Files that usually hold secrets, by their name alone.
 *
 * Listed, never read for this — a name is not proof, and the list says so.
 * A `.env` of `DEBUG=1` is a false alarm; a `.env` nobody declared that holds
 * the production database is the most common credential there is, and a scan
 * that only knows issued shapes calls it clean. `.example`, `.sample`,
 * `.template` and `.dist` are the checked-in stand-ins and are left out.
 */
export const SECRET_NAMES = /^(?:\.env(?:\..+)?|.+\.(?:pem|key|p12|pfx|jks|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass|credentials\.json|service-account.*\.json)$/i;
const STAND_IN_FILE = /\.(?:example|sample|template|dist|tmpl)$|\.(?:example|sample|template)\./i;

export const DEFAULT_IGNORE = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**",
  "**/vendor/**", "**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/coverage/**",
  "**/_cache/**", "**/.cache/**", "**/.angular/**", "**/.parcel-cache/**",
  "**/.turbo/**", "**/.nuxt/**", "**/target/**", "**/out/**",
  "**/*.bak", "**/*.bak-*", "**/*.orig",
  "**/*.min.js", "**/*.min.css", "**/*-lock.json", "**/*.lock",
];

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|bz2|xz|mp[34]|mov|wav|woff2?|ttf|otf|eot|so|dylib|a|o|class|jar|wasm|sqlite3?|db|pyc|pyo)$/i;
const MAX_BYTES = 512 * 1024;
// Written as an escape, not as the byte itself. A literal NUL in the source
// makes git classify this file as binary, and a file with no readable diff
// cannot be reviewed — in a repo whose whole argument is that you should read
// it before you trust it. Same value at runtime, same test.
const NUL = "\u0000";

/**
 * Walks `root` and returns [{file, line, shape, level}].
 *
 * `protectedDirs` are the declared key directories: a hit inside one is the
 * system working, not a finding. `ignore` adds to DEFAULT_IGNORE rather than
 * replacing it, so a user's list stays short.
 *
 * `limit` caps the `review` lines and the links, never the `certain` ones.
 * It used to cap all of them together, and the walk stopped at the cap: 500
 * ordinary `PASSWORD =` lines early in the tree hid a `ghp_` token after them,
 * `certain` came back empty and a CI job gated on it exited 0. A certain hit is
 * the finding the command exists for, so the walk always finishes and every
 * one of them is kept; what the cap drops is counted in `omitted`.
 *
 * ── Nested checkouts: pruned inside a repo, walked outside one ──
 * When the root is inside a git repository, a directory below it with its own
 * `.git` (a clone, a submodule, a worktree, an agent's work copy) is somebody
 * else's repository, and is skipped whole: counted in `skipped.nested`, named
 * in `nestedPaths`. Measured on a real tree: two such directories held 207k
 * files, and scanning them took 145 s and 413 MB for findings that belong to
 * somebody else's policy.
 *
 * When the root is NOT a repository, the same rule made the command blind: a
 * folder that holds projects (a workspace) is nothing BUT nested
 * checkouts, so every one of them was pruned, the scan read almost nothing
 * and exited 0 with "nothing credential-shaped". There is no "somebody else"
 * there — the checkouts are the tree — so they are walked. A tree of work
 * copies that is too big to walk goes in `[scan] ignore`.
 *
 * Either way a pruned checkout is still readable by every role; the renderer
 * says so in yellow and says how to scan it, so a pruned tree never reads as
 * a clean one.
 *
 * `.gitignore` is deliberately NOT honoured (no `git ls-files`): the files a
 * repository ignores are precisely where credentials sit — `.env`, a local
 * config — and every role can read them all the same. Skipping them would
 * make the command quiet about the case it was written for.
 */
export function scan(root, protectedDirs = [], ignore = [], limit = 500, { roots = null } = {}) {
  // The real root, so a symlink's destination is compared like with like: on
  // macOS a tree under /tmp is really under /private/tmp, and every link
  // inside it pointed "out of the repo" until both sides were resolved.
  try { root = realpathSync.native(root); } catch { /* scanned as written */ }
  // `.secrets/` and `.secrets` are one directory. With the slash kept, the
  // prefix test below never matched and the protected directory was scanned.
  const safe = protectedDirs.map((d) => {
    const path = resolve(root, d);
    // The root was canonicalised above. Match the same spelling for absolute
    // directories, including macOS's /var -> /private/var ancestor.
    try { return realpathSync.native(path); } catch { return path; }
  });
  const patterns = [...DEFAULT_IGNORE, ...ignore];
  const hits = [];
  const skipped = { ignored: 0, protectedDirs: 0, reference: 0, placeholder: 0, nested: 0 };
  const nestedPaths = [];
  // With `roots`, only those directories are walked, and a checkout inside one
  // is another repository — pruned, unless it is itself one of the roots.
  const walked = roots ? roots.map((r) => { try { return realpathSync.native(r); } catch { return r; } }) : null;
  const prune = walked ? true : insideRepo(root);
  let capped = 0;                         // review lines and links counted against `limit`
  let omitted = 0;                        // … and the ones dropped because of it
  const keep = (hit) => {
    if (hit.level === "certain") return hits.push(hit);
    if (capped >= limit) return omitted++;
    capped++;
    hits.push(hit);
  };

  const isIgnored = (rel) => patterns.some((p) => covers(p, rel));

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is a permission, not a finding
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full);

      if (safe.some((s) => full === s || full.startsWith(s + sep))) { skipped.protectedDirs++; continue; }
      if (isIgnored(rel)) { skipped.ignored++; continue; }

      /**
       * A symlink pointing out of the repo, reported without being followed.
       *
       * `scan` is the command that answers "do I have credentials outside the
       * declared key directories", and a link is the one way a credential is
       * present in the tree without being a file in it. It was skipped
       * silently, because a symlink is not `isFile()` — so `loose-link ->
       * ~/.ssh/id_rsa` scanned clean.
       *
       * The destination is named, not read. Opening it would put whatever is
       * there into a report that people paste into issues, and the point is
       * that it exists, not what it says.
       */
      if (e.isSymbolicLink()) {
        let real;
        try {
          real = realpathSync.native(full);
        } catch {
          continue;                       // a broken link has nothing to leak
        }
        if (!real.startsWith(root + sep) && real !== root)
          keep({ file: rel, line: 0, level: "link", shape: real });
        continue;
      }

      if (e.isDirectory()) {
        if (prune && existsSync(join(full, ".git"))) {
          if (walked?.includes(full)) continue;   // walked on its own
          skipped.nested++; nestedPaths.push(rel); continue;
        }
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (SECRET_NAMES.test(e.name) && !STAND_IN_FILE.test(e.name))
        keep({ file: rel, line: 0, level: "named", shape: "usually holds secrets, by its name" });
      if (SKIP_EXT.test(e.name)) continue;

      let text;
      try {
        if (statSync(full).size > MAX_BYTES) continue;
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes(NUL)) continue; // binary

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const url = URL_CREDENTIAL.exec(line);
        if (url) {
          const pw = url[2];
          if (PASSWORD_STANDIN.test(pw) || PLACEHOLDER.test(pw) || /^[x*]+$/i.test(pw)) skipped.placeholder++;
          else { keep({ file: rel, line: i + 1, shape: "password in a URL", level: "certain" }); continue; }
        }
        for (const [level, shape, re] of SHAPES) {
          const m = re.exec(line);
          if (!m) continue;
          if (level === "review") {
            // A captured value that is code, or that is plainly a stand-in, is
            // the pattern working correctly on a line that holds no secret.
            if (REFERENCE.test(line)) { skipped.reference++; break; }
            if (m[1] && PLACEHOLDER.test(m[1])) { skipped.placeholder++; break; }
          }
          keep({ file: rel, line: i + 1, shape, level });
          break; // one finding per line; the first shape is the most specific
        }
      }
    }
  }
  for (const r of walked ?? [root]) walk(r);

  // A file with a certain finding is already listed with its line; naming it
  // again as "usually holds secrets" says less about the same file.
  const sure = new Set(hits.filter((h) => h.level === "certain").map((h) => h.file));
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].level === "named" && sure.has(hits[i].file)) hits.splice(i, 1);

  return { hits, skipped, nestedPaths, truncated: omitted > 0, omitted };
}

/**
 * Whether `dir` is inside a git checkout: a `.git` (directory, or the file a
 * worktree or submodule has) at `dir` or at any directory above it. Read from
 * the filesystem, not from `git`, so a machine without git scans the same way.
 */
export function insideRepo(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * What `seisin scan` walks when the policy sits in a folder that is not a
 * repository — the repositories its territories live in, whole.
 *
 * A policy at the root of one repository scans that repository, and that is
 * right: a `.env` at its root is outside every territory and every role reads
 * it. A policy at the root of a folder that holds many repositories (a
 * workspace, a monorepo of clones) is a different shape. Walking the whole
 * folder read everything the person running it ever kept there — archives, experiments,
 * copies — measured at 155 s and 1,137 certain hits on one such folder, most of
 * them in directories no agent works in. The question the command answers is
 * "which credentials will an agent come across", and the agents work in their
 * territories: so the scan follows the policy, and moves with it when the
 * folder is reorganised. `--all` still walks everything.
 *
 * Each territory is widened to the repository that contains it, because a
 * credential at a repository's root is read by an agent working anywhere in it.
 * A territory outside any repository is walked as itself. Territories outside
 * the policy's folder are left out: they are another folder's to scan.
 */
export function territoryRoots(config) {
  const root = config.root;
  const inside = (p) => p === root || p.startsWith(root + sep);
  const found = new Set();
  for (const role of Object.values(config.roles)) {
    for (const glob of role.writes ?? []) {
      let p;
      try { p = join(root, toWritePath(glob)); } catch { continue; }
      if (!inside(p)) continue;
      found.add(repositoryOf(p, root));
    }
  }
  // A plain folder inside another root is walked already; a checkout is not
  // (the walk prunes checkouts), so it stays a root of its own.
  const all = [...found];
  return all.filter((r) => r === root || existsSync(join(r, ".git")) ||
    !all.some((o) => o !== r && (o === root || r.startsWith(o + sep))));
}

/** The nearest checkout at or above `p`, stopping below `root`; else the territory itself. */
function repositoryOf(p, root) {
  let d = p;
  while (d !== root && !isDir(d)) d = dirname(d);   // a file, or not created yet
  const territory = d;
  for (let at = d; at !== root && at.startsWith(root + sep); at = dirname(at))
    if (existsSync(join(at, ".git"))) return at;
  return territory;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
