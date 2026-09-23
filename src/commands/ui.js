/**
 * `seisin ui` — the console, reading the real config and the real log.
 *
 * The only long-lived process in the tool, and scoped hard on purpose: a
 * foreground command you start and stop, serving one page and one JSON
 * document, on loopback. Nothing in the enforcement path touches it. If it is
 * not running you lose a window, not a boundary.
 */
import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { serve } from "../serve.js";
import { C, out } from "../render.js";

export async function ui(config, argv = []) {
  const i = argv.indexOf("--port");
  const port = i === -1 ? 4178 : Number(argv[i + 1]);

  const server = await serve(config.path, port);
  const bound = server.address().port;
  // The token rides in the fragment, which the browser keeps to itself: no
  // request to this server, or to anything else, ever carries it. The page
  // moves it into the tab's storage and strips it from the address bar.
  const url = `http://127.0.0.1:${bound}/#t=${server.seisinToken}`;
  // local_binding opens every port (macOS); local_ports opens the ones it
  // names, on every platform — so only a role that names THIS port counts.
  const reach = Object.values(config.roles)
    .filter((r) => (r.localBinding && process.platform === "darwin") || (r.localPorts ?? []).includes(bound))
    .map((r) => r.name);

  out(
    `\n  ${C.b}${url}${C.off}\n` +
    `  ${C.dim}reading ${relative(process.cwd(), config.path)} and the log, live. ctrl-c to stop.${C.off}\n` +
    `  ${C.dim}the link carries this run's token: open it here, do not paste it anywhere.${C.off}\n` +
    (reach.length
      ? `  ${C.yellow}${reach.join(", ")} can reach this port on localhost: they can load this page, ` +
        `but not the token, which only travels in the link above.${C.off}\n`
      : "") + "\n"
  );

  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore", shell: process.platform === "win32" });

  process.on("SIGINT", () => { server.close(); process.exit(0); });
  return server;
}
