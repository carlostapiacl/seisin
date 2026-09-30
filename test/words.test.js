/**
 * One word per thing, held by a test.
 *
 * docs/glossary.md says which word means what; CONTRIBUTING.md says a term
 * that reaches a reader arrives with its line there. Both were true on paper
 * and false in the product: the README closed with "the boundary denies" and
 * used "refused" for the boundary sixteen times above it, and the npm
 * description used the one word the glossary bans first. `grep` was the whole
 * enforcement, and grep is not run on a tired evening. This is.
 *
 * What it reads is what a person or an agent reads: string literals in src/
 * (comments stripped), the console's visible text and script strings, the
 * MCP server's descriptions, package.json's description, README, docs, site.
 * Not CHANGELOG.md, which is history and quotes the old words on purpose.
 *
 * A word **mentioned** rather than used — wrapped in `code`, *emphasis*,
 * **bold** or quotes, as the glossary does when it bans it — is not a use.
 * Anything else that has to stay goes in ALLOW with the reason, so the
 * exception is a decision somebody wrote down rather than a regex that
 * quietly grew.
 *
 * Two levels. `must` fails the suite. `should` is reported as a todo until
 * its cleanup lands, then moves up to `must` one rule at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ── what a reader reads ───────────────────────────────────────────────────

/** String and template literals of a JS source, comments skipped, with line numbers. */
function jsStrings(src, firstLine = 1) {
  const out = [];
  let i = 0, line = firstLine;
  const n = src.length;
  const push = (text, at) => { if (/\s/.test(text.trim()) && /[a-z]{3}/i.test(text)) text.split("\n").forEach((t, k) => out.push({ line: at + k, text: t })); };
  function template() {
    let buf = "", at = line;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { if (src[i + 1] === "\n") line++; buf += src[i + 1] ?? ""; i += 2; continue; }
      if (c === "`") { i++; push(buf, at); return; }
      if (c === "$" && src[i + 1] === "{") { push(buf, at); buf = ""; i += 2; code(1); at = line; continue; }
      if (c === "\n") line++;
      buf += c; i++;
    }
    push(buf, at);
  }
  function code(depth) {
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === "\n") { line++; i++; continue; }
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
      if (c === '"' || c === "'") {
        const q = c, at = line; let buf = ""; i++;
        while (i < n && src[i] !== q && src[i] !== "\n") { if (src[i] === "\\") { buf += src[i + 1]; i += 2; continue; } buf += src[i++]; }
        // A quote inside a regex literal opens a "string" the newline ends;
        // leave that newline for the line counter instead of eating it.
        if (src[i] === q) i++;
        push(buf, at); continue;
      }
      if (c === "`") { i++; template(); continue; }
      if (c === "{") { depth++; i++; continue; }
      if (c === "}") { if (--depth === 0) { i++; return; } i++; continue; }
      i++;
    }
  }
  code(Infinity);
  return out;
}

const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

/** Every unit of reader-facing text: { area, file, line, text }. */
function corpus() {
  const units = [];
  const add = (area, file, line, text) => units.push({ area, file: relative(ROOT, file), line, text });

  for (const f of walk(join(ROOT, "src")).filter((f) => f.endsWith(".js")))
    for (const s of jsStrings(readFileSync(f, "utf8")))
      add(f.endsWith("mcp.js") ? "mcp" : "src", f, s.line, s.text);

  {
    const f = join(ROOT, "ui", "index.html");
    const lines = readFileSync(f, "utf8").split("\n");
    let script = null, style = false, comment = false;
    lines.forEach((l, k) => {
      if (script) {
        if (/<\/script>/i.test(l)) { for (const s of jsStrings(script.buf.join("\n"), script.from)) add("ui", f, s.line, s.text.replace(/<[^>]*>/g, " ")); script = null; }
        else script.buf.push(l);
        return;
      }
      if (/<script\b/i.test(l) && !/<\/script>/i.test(l)) { script = { from: k + 2, buf: [] }; return; }
      if (/<style\b/i.test(l)) style = true;
      if (style) { if (/<\/style>/i.test(l)) style = false; return; }
      let t = l;
      if (comment) { if (!t.includes("-->")) return; t = t.slice(t.indexOf("-->") + 3); comment = false; }
      t = t.replace(/<!--[\s\S]*?-->/g, " ");
      if (t.includes("<!--")) { t = t.slice(0, t.indexOf("<!--")); comment = true; }
      for (const m of t.matchAll(/(?:title|placeholder|aria-label|content)="([^"]+)"/g)) add("ui", f, k + 1, m[1]);
      const text = t.replace(/<[^>]*>/g, " ").trim();
      if (text) add("ui", f, k + 1, text);
    });
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  add("npm", join(ROOT, "package.json"), 4, pkg.description);

  // A fence tagged with a programming language quotes somebody's source; it is
  // not our voice. Untagged, `text`, `sh`, `toml` fences are: they show seisin's
  // own output and seisin's own config, and those are exactly what must agree.
  const QUOTED_SOURCE = /^(js|javascript|ts|typescript|json|jsonc|py|python|go|c|rust|swift|diff)$/i;
  const md = (f, area) => {
    let fence = null;
    readFileSync(f, "utf8").split("\n").forEach((l, k) => {
      const open = l.match(/^\s*(```|~~~)\s*(\S*)/);
      if (open) { fence = fence ? null : { source: QUOTED_SOURCE.test(open[2]) }; return; }
      if (fence?.source) return;
      units.push({ area, file: relative(ROOT, f), line: k + 1, text: l, fence: !!fence, quote: /^\s*>/.test(l) });
    });
  };
  md(join(ROOT, "README.md"), "readme");
  md(join(ROOT, "CONTRIBUTING.md"), "docs");
  md(join(ROOT, "SECURITY.md"), "docs");
  for (const f of walk(join(ROOT, "docs")).filter((f) => f.endsWith(".md")))
    md(f, f.includes("/upstream/") ? "upstream"
      : f.endsWith("field-notes.md") ? "field-notes" : f.endsWith("glossary.md") ? "glossary" : "docs");

  {
    const f = join(ROOT, "site", "index.html");
    let skip = false;
    readFileSync(f, "utf8").split("\n").forEach((l, k) => {
      if (/<(style|script)\b/i.test(l)) skip = true;
      if (skip) { if (/<\/(style|script)>/i.test(l)) skip = false; return; }
      for (const m of l.matchAll(/(?:title|alt|aria-label|content)="([^"]+)"/g)) add("site", f, k + 1, m[1]);
      const text = l.replace(/<[^>]*>/g, " ").trim();
      if (text) add("site", f, k + 1, text);
    });
  }
  return units;
}

// ── mentions are not uses ─────────────────────────────────────────────────

/** Remove inline code, and any single word or short phrase wrapped in emphasis or quotes. */
function used(text) {
  return text
    .replace(/`[^`]*`/g, " ")
    // a link's target is an address, not prose: a repo called *-permissions-hook is its name
    .replace(/\]\([^)\s]*\)/g, "]")
    .replace(/\*\*[^*]{1,40}\*\*|\*[^*\s][^*]{0,38}\*|_[^_\s][^_]{0,38}_/g, " ")
    .replace(/"[^"]{1,40}"|“[^”]{1,40}”|'[a-z -]{1,30}'/gi, " ");
}

// ── the word lists ────────────────────────────────────────────────────────

/** Where the product itself speaks. */
const PRODUCT = new Set(["src", "mcp", "ui", "npm", "site"]);
/** Everything a reader reads in seisin's own voice. */
const EVERYWHERE = new Set([...PRODUCT, "readme", "docs", "field-notes", "glossary"]);
/**
 * docs/upstream/ is written to the sandbox runtime's maintainers, in their
 * vocabulary (violation, blocked). It is held to the jargon rule only.
 */
const WITH_UPSTREAM = new Set([...EVERYWHERE, "upstream"]);

/**
 * `must` rules. Each one is a sentence of the glossary, turned into a pattern.
 * `in`: the areas it applies to. `why`: what the failure message says.
 */
const MUST = [
  {
    id: "block",
    re: /\bblock(s|ed|ing)?\b/i,
    in: EVERYWHERE,
    why: "the boundary **denies**; `block` is not a word this project uses (glossary: Three actors)",
  },
  {
    id: "jargon",
    re: /\b(cells?|c[ée]lulas?|rondas?|bit[aá]cora|portfolio|equipo|plataforma(-dev)?|operador)\b|\brounds?\b(?! trip)(?<!way round)/i,
    in: WITH_UPSTREAM,
    why: "private team vocabulary: say team (prose only) / run / a neutral example path (glossary: Words this project does not use)",
  },
  {
    id: "refuse-in-product",
    re: /\brefus(e|ed|es|al|als|ing)\b/i,
    in: PRODUCT,
    why: "in product text *refuse* is only seisin rejecting input; add the line to ALLOW with that reason, or say *deny*",
  },
  {
    id: "refuse-for-boundary",
    // the boundary, the kernel, the proxy, the runtime… followed closely by refuse;
    // or the passive shapes a denial takes in prose.
    re: /\b(kernel|boundary|proxy|sandbox|bubblewrap|seatbelt|os)\b('s)?[^.;:]{0,30}\brefus(e|ed|es|al|als|ing)\b|\brefus(ed|al|als)\b[^.;]{0,25}\b(reads?|writes?|connections?|path|paths)\b|\b(been|get|gets|got) refused\b|\bstill refuses\b/i,
    in: new Set(["readme", "docs", "field-notes", "glossary", "site"]),
    why: "the boundary **denies**; *refuse* is what seisin does to input it will not act on",
  },
  {
    id: "person-denies",
    re: /\bseisin deny\b(?! still works)|\b(approve|grant) or (refuse|deny)\b/i,
    in: EVERYWHERE,
    why: "a person **declines**; `seisin deny` is an undocumented alias",
  },
  // Promoted from `should` once their cleanup landed (0.5.0 language pass).
  { id: "approve", re: /\bapprov(e|ed|es|al|ing)\b/i, in: new Set(["src", "mcp", "ui", "npm"]), why: "a person **grants**; *approve* is other tools' one-action-now" },
  { id: "box", re: /\bbox\b/i, in: new Set(["src", "mcp", "ui", "npm"]), why: "say *sandbox*" },
  { id: "unsandboxed", re: /\bunsandbox(ed)?\b|\bsandboxed\b/i, in: new Set(["ui"]), why: "say *confined* / *unconfined*" },
  { id: "turn-as-run", re: /\b(the|a|each|this) turn\b(?! (on|off|into))/i, in: new Set(["src", "mcp", "ui", "glossary"]), why: "seisin's unit is a *run*; *turn* is the agent's" },
  { id: "approver", re: /\b(operators?|humans?)\b/i, in: new Set(["src", "mcp", "ui", "readme"]), why: "the approver is *a person*" },
  { id: "permission-request", re: /\bpermission requests?\b/i, in: new Set(["src", "mcp", "ui", "readme", "site"]), why: "say *request*; Claude Code's `PermissionRequest` is a synchronous prompt" },
  // Promoted in the second pass, once the CLI files were in the corpus and each reached zero.
  { id: "permission-countable", re: /(?<!\bfile )\bpermissions\b(?! (layer|error|errors|file|files|tool|tools|rules|system|mode))|\b(a|the) permission\b(?! (layer|error|file|tool|rules))/i, in: new Set(["src", "mcp", "ui", "npm", "readme"]), why: "there is no permission object: territory, key, request or grant" },
  { id: "friction", re: /\bfriction\b|\bstopped, repeatedly\b/i, in: new Set(["src", "ui", "readme", "glossary", "site"]), why: "say *repeated denials*" },
  { id: "log-line-as-decision", re: /\b\d+ decisions\b|every decision\b/i, in: new Set(["src", "ui", "readme"]), why: "a log line is an *entry*; *decision* is a person's" },
];

/**
 * `should` rules — reported as todo until their cleanup lands, then promoted
 * one at a time. Empty since the second language pass: add the next synonym
 * cleanup here, not straight into MUST, so its count is visible while it lands.
 */
const SHOULD = [];

/**
 * Written-down exceptions. `file` and `re` must both match; `why` is required.
 * A new entry is a claim that the word is right there, and review reads it.
 */
const ALLOW = [
  // seisin refusing input — the one correct use of *refuse* in product text
  { file: "src/config.js", re: /unknown name is refused/, why: "seisin refuses a policy it will not load" },
  { file: "src/grants.js", re: /Refusing rather than widening/, why: "seisin refuses a glob it cannot enforce" },
  { file: "src/keys.js", re: /refused rather than half-available/, why: "seisin refuses a key mode it cannot honour" },
  // an editor's own feature, named: what a role writing .vscode/ can switch on
  { file: "src/inspect.js", re: /auto-approval/, why: "the editors' name for the setting that runs an agent's tool calls unasked" },
  // a PEM header, not a denial
  { file: "src/scan.js", re: /private key block/, why: "the name of a PEM block, which is what scan looks for" },
  // other tools' words, quoted
  { file: /^docs\/(decisions|what-it-has-been-put-through)\.md$/, re: /blocked by network allowlist/, why: "the runtime's own message" },
  { file: "docs/nono-backend.md", re: /\bblock\w*|rejects/, why: "nono's `network.block` setting and its feature list, in nono's words" },
  { file: "docs/what-it-has-been-put-through.md", re: /missing boundary refuses to run/, why: "a test name: seisin refusing to start without its boundary" },
  { file: "docs/upstream/cli-violations.md", re: /deny\(1\)/, why: "the macOS log line, verbatim" },
  { file: "README.md", re: /fall through to the permission mode/, why: "Claude Code's documentation, quoted" },
  { file: "README.md", re: /`bwrap: No permissions to create new$/, why: "bubblewrap's error message, verbatim (the code span wraps to the next line)" },
  { file: /^docs\//, re: /\bthe other way round\b/, why: "idiom" },
  // the glossary names the words it bans, in its *Not:* lists and its table
  { file: "docs/glossary.md", re: /\*Not:\*|^\| \*\*/, why: "the glossary lists the words it bans" },
  // …and says what each source page was checked for, in that page's own words
  { file: "docs/glossary.md", re: /^\d+\. \[/, why: "the sources list quotes each page's vocabulary, which is the point of checking it" },
  // history, kept as history — found by its first and last lines, not by line numbers that move
  { file: "docs/decisions.md", between: [/^- ~~\*\*The queue says "refused"/, /which did not exist and is why this drifted\./],
    why: "the dated record of the vocabulary change itself; superseded in place, not rewritten" },
  { file: "CONTRIBUTING.md", re: /It had four|renamed from \*refuse\*|kept saying `Refuse`/, why: "the history the rule comes from" },
];

/** Measured anecdotes: in field notes, quoted and fenced text is evidence, not voice. */
const exemptBlock = (u) => u.area === "field-notes" && (u.fence || u.quote);

/** The line range a `between` entry covers, found once per file. */
const RANGES = new Map();
function rangeOf(a, file) {
  if (!RANGES.has(a)) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    const from = lines.findIndex((l) => a.between[0].test(l));
    const to = lines.findIndex((l, k) => k >= from && a.between[1].test(l));
    // A marker that is gone is a failure, not a silent widening: the history
    // was moved or rewritten, and the exception has to be looked at again.
    assert.ok(from >= 0 && to >= from, `${file}: the ALLOW markers ${a.between.join(" … ")} no longer match`);
    RANGES.set(a, [from + 1, to + 1]);
  }
  return RANGES.get(a);
}

function allowed(u, text) {
  return ALLOW.some((a) => {
    const f = typeof a.file === "string" ? u.file === a.file : a.file.test(u.file);
    if (!f) return false;
    if (a.between) { const [from, to] = rangeOf(a, u.file); return u.line >= from && u.line <= to; }
    return a.re.test(text);
  });
}

function violations(rules, units) {
  const out = [];
  for (const u of units) {
    if (exemptBlock(u)) continue;
    const text = used(u.text);
    for (const r of rules) {
      if (!r.in.has(u.area)) continue;
      const m = text.match(r.re);
      if (m && !allowed(u, u.text)) out.push(`${u.file}:${u.line}  [${r.id}] "${m[0]}" — ${r.why}\n      ${u.text.trim().slice(0, 140)}`);
    }
  }
  return out;
}

// ── the tests ─────────────────────────────────────────────────────────────

const UNITS = corpus();

for (const r of MUST)
  test(`words: ${r.id} — ${r.why.split(";")[0]}`, () => {
    const v = violations([r], UNITS);
    assert.equal(v.length, 0, `\n${v.join("\n")}\n`);
  });

for (const r of SHOULD)
  test(`words (cleanup): ${r.id}`, { todo: `${violations([r], UNITS).length} left` }, () => {
    const v = violations([r], UNITS);
    assert.equal(v.length, 0, `\n${v.join("\n")}\n`);
  });

test("every banned word is listed in the glossary's table of words not used", () => {
  const g = readFileSync(join(ROOT, "docs", "glossary.md"), "utf8");
  const table = g.slice(g.indexOf("## Words this project does not use"));
  for (const w of ["block", "refuse", "deny", "reject", "approve", "permission", "cell", "round", "box", "unsandboxed", "friction", "operator"])
    assert.match(table, new RegExp(`\\*\\*${w}`, "i"), `${w} is banned here and not in the glossary's list`);
});

test("every word the product prints about its own model has a glossary line", () => {
  const g = readFileSync(join(ROOT, "docs", "glossary.md"), "utf8");
  const TERMS = ["policy", "role", "agent", "territory", "owner", "unowned", "never_writes", "key", "holder",
    "reference", "provider", "protected", "control file", "family", "isolate", "scratch", "run directory",
    "boundary", "sandbox", "confined", "unconfined", "settings", "run", "observe mode", "denial", "verdict",
    "request", "grant", "decline", "revoke", "refuse", "handoff", "log", "entry", "hash chain",
    "genesis record", "tamper-evident", "window", "standing", "kind", "cause", "wall", "repeated denials",
    "surface", "console", "hook"];
  for (const t of TERMS) assert.match(g, new RegExp(`^\\*\\*\`?${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi"), `no glossary line for "${t}"`);
});

test("the README's sample of `seisin walls` says what `seisin walls` says", async () => {
  // Two voices, one list: the terminal speaks to the person who ran the
  // command, the session-start context to the agent. The README shows both,
  // and each has to be what the product prints.
  const { renderForPerson } = await import(join(ROOT, "src", "commands", "walls.js"));
  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const shown = plain(renderForPerson("dev", [
    { times: 19, action: "write", target: "../shared/.git/index.lock", owners: ["platform"] },
    { times: 6, action: "read", target: "~/.npmrc", owners: [], reason: "no role declares ~/.npmrc — add it under a [roles.<name>] keys list" },
  ]));
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes(`$ seisin walls dev\n${shown.replace(/\n+$/, "")}\n\`\`\``),
    `README's terminal sample is not what \`seisin walls dev\` prints:\n${shown}`);
  const said = readFileSync(join(ROOT, "src", "diagnose.js"), "utf8").match(/"(Already denied more than once[^"]*)"/)[1];
  assert.ok(readme.includes(said), `README's session-start sample is not the hook's sentence:\n  product: ${said}`);
});

test("the README's sample of `seisin review` is what `seisin review` prints for that log", async (t) => {
  const { boxed } = await import("./_tmp.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { loadConfig } = await import(join(ROOT, "src", "config.js"));
  const { reviewCommand } = await import(join(ROOT, "src", "commands", "review.js"));
  const dir = boxed("readme-review-");
  writeFileSync(join(dir, "seisin.toml"),
    '[roles.frontend]\nwrites = ["src/web/**", "public/**"]\n\n[roles.backend]\nwrites = ["src/api/**", "migrations/**"]\n');
  for (const d of ["src/web", "src/api", "public", "migrations", "legacy"]) mkdirSync(join(dir, d), { recursive: true });
  // The log the sample describes: 60 entries over three weeks.
  const log = [];
  const e = (day, role, verdict, target, owners = []) =>
    log.push({ at: `2026-${day}T10:00:00.000Z`, role, action: "write", kind: "file", target, verdict, owners });
  e("08-23", "frontend", "allowed", "src/web/a.js");
  for (let i = 0; i < 9; i++) e("08-25", "frontend", "denied", "src/api/checkout/index.ts", ["backend"]);
  for (let i = 0; i < 4; i++) e("08-27", "backend", "denied", "src/web/app.js", ["frontend"]);
  for (let i = 0; i < 2; i++) e("09-01", "backend", "denied", "legacy/old.js");
  for (let i = 0; i < 2; i++) e("09-02", "frontend", "denied", "legacy/old.js");
  while (log.length < 59) e("09-05", log.length % 2 ? "frontend" : "backend", "allowed", log.length % 2 ? "src/web/b.js" : "src/api/c.py");
  e("09-11", "backend", "allowed", "src/api/d.py");
  mkdirSync(join(dir, ".seisin"));
  writeFileSync(join(dir, ".seisin", "log.jsonl"), log.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const printed = [];
  t.mock.method(process.stdout, "write", (s) => { printed.push(String(s)); return true; });
  try { reviewCommand(loadConfig(join(dir, "seisin.toml")), []); } finally { t.mock.restoreAll(); }
  const shown = printed.join("").replace(/\x1b\[[0-9;]*m/g, "").replace(/\n+$/, "");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes(`$ seisin review\n${shown}\n\`\`\``), `README's review sample is not what review prints:\n${shown}`);
});

test("the console's decline button does not send the boundary's verb", () => {
  const ui = readFileSync(join(ROOT, "ui", "index.html"), "utf8");
  assert.ok(!/data-d="denied"/.test(ui), 'the Decline button posts decision "denied": a person declines');
});
