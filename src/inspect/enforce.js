import { settingsFor } from "../srt.js";

export function enforceWarnings(config, roles) {
  const warnings = [];
  // A pattern the kernel cannot be given is not a policy, it is a sentence that
  // reads like one. `run` refuses it; `check` exists precisely so you find that
  // out while reading the map rather than mid-run.
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
  return warnings;
}
