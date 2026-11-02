/**
 * `[notify]` as the config loader reads it: validation only, so loading a
 * policy does not pull in the request queue the sender needs (notify.js).
 * Why each rule exists is in notify.js.
 */
import { join, resolve, sep } from "node:path";
import { realAncestor } from "./paths.js";

export const FORMATS = ["text", "json", "slack"];
export const ENV_URL = "SEISIN_NOTIFY_URL";

/**
 * `[notify]` from seisin.toml, refused rather than guessed when it would leak.
 * Called by the config loader.
 */
export function readNotify(table, { path, root, keyDirs, roles, own }) {
  if (table === undefined) return null;
  if (own(table, "url") !== undefined)
    throw new Error(
      `${path}: [notify] url is readable by every role — seisin.toml is not a secret. ` +
      `Put the URL in a file inside a key directory no role declares and name it with url_file, ` +
      `or set ${ENV_URL} in the environment that starts seisin.`);
  const urlFile = own(table, "url_file");
  const format = own(table, "format") ?? "text";
  if (!FORMATS.includes(format))
    throw new Error(`${path}: [notify] format = "${format}" is not one of ${FORMATS.join(", ")}`);
  if (urlFile === undefined) return { urlFile: null, format };
  if (typeof urlFile !== "string" || !urlFile.trim() || urlFile.startsWith("/") || urlFile.split("/").includes(".."))
    throw new Error(`${path}: [notify] url_file must be a path inside the repo`);
  const canonical = (p) => realAncestor(resolve(root, p));
  const file = canonical(urlFile);
  const inKeyDir = keyDirs.some((d) => file.startsWith(canonical(d) + sep));
  if (!inKeyDir)
    throw new Error(
      `${path}: [notify] url_file "${urlFile}" is not inside a key directory, so every role can read ` +
      `it. Move it under ${keyDirs[0] ?? "a [keys] dir"}.`);
  // A file key is written bare (`netlify.txt`, meaning the first key directory)
  // or with its directory (`shared/api.txt`) — the same resolution settingsFor uses.
  const fileKey = (raw) => canonical(raw.includes("/") ? raw : join(keyDirs[0] ?? "", raw));
  const holders = Object.entries(roles)
    .filter(([, r]) => r.keyEntries?.some((k) => {
      if (k.kind === "file") {
        const held = fileKey(k.raw);
        return file === held || file.startsWith(held + sep);
      }
      if (k.kind !== "ref" || k.scheme !== "file") return false;
      // Match the builtin resolver's last-fragment rule. A reference delivers
      // the contents even though it opens no filesystem read for the role.
      const hash = k.ref.lastIndexOf("#");
      return canonical(hash === -1 ? k.ref : k.ref.slice(0, hash)) === file;
    }))
    .map(([n]) => n);
  if (holders.length)
    throw new Error(
      `${path}: [notify] url_file "${urlFile}" is declared as a key by ${holders.join(", ")} — ` +
      `that role could read it and send the person a fake "grant this". No role may hold it.`);
  return { urlFile, format };
}
