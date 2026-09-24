/**
 * `seisin ui` — the console, reading the real config and the real log.
 *
 * The only long-lived process in the tool, and scoped hard on purpose: a
 * foreground command you start and stop, serving one page and one JSON
 * document, on loopback. Nothing in the enforcement path touches it. If it is
 * not running you lose a window, not a boundary.
 *
 * The token that authorizes the page travels only in the link's fragment and is
 * never in an HTTP response (see serve.js). So a lost link cannot be recovered
 * over the wire — only from the terminal that printed it. `writeUiLink` keeps a
 * user-only copy on disk so it can be recovered without reopening that leak:
 * `--link` prints it, and starting over a busy port reopens it instead of just
 * failing. See uilink.js.
 */
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { serve } from "../serve.js";
import { writeUiLink, readUiLink, clearUiLink } from "../uilink.js";
import { C, out } from "../render.js";

function open(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore", shell: process.platform === "win32" });
}

export async function ui(config, argv = []) {
  const i = argv.indexOf("--port");
  const port = i === -1 ? 4178 : Number(argv[i + 1]);

  // `seisin ui --link`: print the live link a running console left, and open
  // it, without starting anything. For when the terminal that had it is gone.
  if (argv.includes("--link")) {
    const found = readUiLink(port);
    if (found && found.alive !== false) {
      out(`\n  ${C.b}${found.url}${C.off}\n  ${C.dim}the link a seisin ui on ${port} is serving. open it here, do not paste it anywhere.${C.off}\n\n`);
      open(found.url);
      return;
    }
    if (found && found.alive === false) clearUiLink(port);
    out(`\n  ${C.dim}no seisin ui running on ${port} — start one with: seisin ui${port === 4178 ? "" : ` --port ${port}`}${C.off}\n\n`);
    return;
  }

  let server;
  try {
    server = await serve(config.path, port);
  } catch (e) {
    // A console is already on this port: hand back its live link rather than
    // erroring, which is the case that sends people digging in the terminal.
    if (e.code === "EADDRINUSE") {
      const found = readUiLink(port);
      if (found && found.alive !== false) {
        out(
          `\n  ${C.b}${found.url}${C.off}\n` +
          `  ${C.dim}a seisin ui is already running on ${port}; reopening its link. ctrl-c that terminal to stop it.${C.off}\n\n`
        );
        open(found.url);
        return;
      }
      // The port is busy but no live console left a link — a stale record, or
      // something else is on the port. Drop the stale one and let the original
      // "port is busy" message stand.
      if (found && found.alive === false) clearUiLink(port);
    }
    throw e;
  }

  const bound = server.address().port;
  const url = `http://127.0.0.1:${bound}/#t=${server.seisinToken}`;
  // Recorded before we print, so `--link` and a second `seisin ui` can find it.
  writeUiLink(bound, url);

  // local_binding opens every port (macOS); local_ports opens the ones it
  // names, on every platform — so only a role that names THIS port counts.
  const reach = Object.values(config.roles)
    .filter((r) => (r.localBinding && process.platform === "darwin") || (r.localPorts ?? []).includes(bound))
    .map((r) => r.name);

  out(
    `\n  ${C.b}${url}${C.off}\n` +
    `  ${C.dim}reading ${relative(process.cwd(), config.path)} and the log, live. ctrl-c to stop.${C.off}\n` +
    `  ${C.dim}the link carries this run's token: open it here, do not paste it anywhere.${C.off}\n` +
    `  ${C.dim}lost it? this terminal has it above, or run: seisin ui --link${bound === 4178 ? "" : ` --port ${bound}`}${C.off}\n` +
    (reach.length
      ? `  ${C.yellow}${reach.join(", ")} can reach this port on localhost: they can load this page, ` +
        `but not the token, which only travels in the link above.${C.off}\n`
      : "") + "\n"
  );

  open(url);

  const stop = () => { clearUiLink(bound); server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return server;
}
