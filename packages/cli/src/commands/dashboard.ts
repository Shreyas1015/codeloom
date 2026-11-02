import { spawn } from "node:child_process";
import { type DashboardServer, startDashboardServer } from "../web/server.js";

/** The command that opens `url` in the default browser: macOS `open`, Windows `start ""` (through cmd),
 * everything else `xdg-open`. */
export function openerFor(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", '""', url] };
  return { cmd: "xdg-open", args: [url] };
}

/** Best effort: a missing or failing opener is ignored (the printed URL is enough). */
function openBrowser(url: string): void {
  const { cmd, args } = openerFor(process.platform, url);
  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore: the URL is printed
  }
}

/** `codeloom dashboard`: start the local dashboard server, print its token URL, open the browser unless
 * `open: false`. Ctrl+C (SIGINT) closes the server and exits 0. close() also removes the SIGINT handler. */
export async function runDashboard(start: string, opts: { port?: number; open?: boolean }): Promise<DashboardServer> {
  const server = await startDashboardServer({ start, port: opts.port });
  const onSigint = () => {
    server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSigint);
  const close = server.close.bind(server);
  const wrapped: DashboardServer = {
    ...server,
    close: () => {
      process.off("SIGINT", onSigint);
      return close();
    },
  };
  console.log(`codeloom dashboard: ${server.url}  (Ctrl+C to stop)`);
  if (opts.open !== false) openBrowser(server.url);
  return wrapped;
}
