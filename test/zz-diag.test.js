import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxed, CLI } from "./_tmp.js";
import { loadConfig } from "../src/config.js";
import { settingsFor } from "../src/srt-settings.js";
const seisin = (a, cwd) => spawnSync(process.execPath, [CLI, ...a], { cwd, encoding: "utf8" });
const P = (s) => console.log(`DIAG ${s}`);
const probe = [".seisin/policies/x.json", ".seisin/n", ".seisin/log.jsonl", "src/ok.ts", "src/nuevo"].map((p) => `(echo x >> ${p}) 2>/dev/null && echo "yes ${p}" || echo "no ${p}"`).join("; ");
function make(toml = '[runtime]\nwrites = []\n[roles.all]\nwrites = ["**"]\n') {
  const d = boxed("diag-"); mkdirSync(join(d, "src")); for (const f of ["held.ts", "ok.ts"]) writeFileSync(join(d, "src", f), "");
  writeFileSync(join(d, "seisin.toml"), toml); return d;
}
const go = (d, flags) => seisin(["run", "all", ...flags, "--agent", "none", "--", "/bin/sh", "-c", probe], d);
const say = (name, r) => P(`${name}: ${r.stdout.trim().split("\n").join(" | ")} rc=${r.status} ${r.stderr.split("\n").filter((l) => /tartaros|srt|runs under/.test(l)).join(" ").slice(0, 200)}`);
test("diag", () => {
  let d = make(); say("A --var, primera", go(d, ["--var", "A=/x"]));
  d = make(); say("B --deny, primera", go(d, ["--deny", "src/held.ts"]));
  d = make(); go(d, ["--var", "A=/x"]); say("C --var, segunda", go(d, ["--var", "A=/x"]));
  d = make(); seisin(["run", "all", "--agent", "none", "--", "/usr/bin/true"], d); mkdirSync(join(d, ".seisin/policies")); say("D plano con policies a mano", go(d, []));
  d = make('[runtime]\nwrites = []\n[roles.all]\nwrites = ["**"]\nnever_writes = ["src/held.ts"]\n'); seisin(["run", "all", "--agent", "none", "--", "/usr/bin/true"], d); mkdirSync(join(d, ".seisin/policies")); say("E plano never_writes en toml", go(d, []));
  d = make(); say("F --var fuera de .seisin", go(d, ["--state-dir", join(boxed("diag-st-"), "st"), "--var", "A=/x"]));
  d = make(); go(d, ["--var", "A=/x"]);
  const files = readdirSync(join(d, ".seisin/policies")).filter((f) => f.endsWith(".json") && f !== "x.json");
  for (const [n, cfg] of [["toml", loadConfig(join(d, "seisin.toml"))], ["efectiva", Object.assign(loadConfig(join(d, ".seisin/policies", files[0]), undefined, { root: d }), { sourcePolicy: join(d, "seisin.toml") })]]) {
    const fs = settingsFor(cfg, "all", "/tmp/s", false, { agent: null }).filesystem;
    P(`${n} allowWrite=${JSON.stringify(fs.allowWrite).replaceAll(d, "$D")}`);
    P(`${n} denyWrite=${JSON.stringify(fs.denyWrite.filter((p) => p.includes(d))).replaceAll(d, "$D").slice(0, 700)}`);
    const f = join(boxed("diag-s-"), "s.json"); writeFileSync(f, JSON.stringify(settingsFor(cfg, "all", "/tmp/s", false, { agent: null })));
    const e = spawnSync(join(process.cwd(), "node_modules/.bin/tartaros"), ["explain", "--settings", f], { encoding: "utf8" });
    P(`${n} explain rc=${e.status} ${(e.stdout + e.stderr).replaceAll(d, "$D").slice(0, 1200).split("\n").join(" // ")}`);
  }
  P(`node ${process.version} kernel ${spawnSync("uname", ["-r"], { encoding: "utf8" }).stdout.trim()} tartaros ${spawnSync("node_modules/.bin/tartaros", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
});
