import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const assetsDir = mkdtempSync(join(tmpdir(), "codeloom-dash-cmd-"));
mkdirSync(join(assetsDir, "assets"), { recursive: true });
writeFileSync(join(assetsDir, "index.html"), "<!doctype html><html></html>");
writeFileSync(join(assetsDir, "assets", "index-AbCd1234.js"), "");

vi.mock("../src/web/assets.js", () => ({ locateDashboardAssets: () => assetsDir }));
const spawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), spawn }));

const { runDashboard, openerFor } = await import("../src/commands/dashboard.js");
const { buildProgram, exitCodeFor } = await import("../src/cli.js");

afterEach(() => {
  vi.restoreAllMocks();
  spawn.mockClear();
});

describe("runDashboard", () => {
  it("prints the URL line and never calls the opener with open: false", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sigints = process.listenerCount("SIGINT");
    const server = await runDashboard(assetsDir, { port: 0, open: false });
    try {
      expect(log).toHaveBeenCalledWith(`codeloom dashboard: ${server.url}  (Ctrl+C to stop)`);
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
      expect(spawn).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGINT")).toBe(sigints + 1);
    } finally {
      await server.close();
    }
    // close() removes the SIGINT handler again.
    expect(process.listenerCount("SIGINT")).toBe(sigints);
  });

  it("opens the browser by default with the platform opener", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const server = await runDashboard(assetsDir, { port: 0 });
    try {
      expect(spawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = spawn.mock.calls[0] as unknown as [string, string[]];
      const expected = openerFor(process.platform, server.url);
      expect(cmd).toBe(expected.cmd);
      expect(args).toEqual(expected.args);
    } finally {
      await server.close();
    }
  });
});

describe("openerFor", () => {
  it("macOS open, Linux xdg-open, Windows start", () => {
    const url = "http://127.0.0.1:4747/?token=abc";
    expect(openerFor("darwin", url)).toEqual({ cmd: "open", args: [url] });
    expect(openerFor("linux", url)).toEqual({ cmd: "xdg-open", args: [url] });
    expect(openerFor("win32", url)).toEqual({ cmd: "cmd", args: ["/c", "start", '""', url] });
  });
});

describe("codeloom dashboard (cli)", () => {
  it("registers --port and --no-open", () => {
    const cmd = buildProgram().commands.find((c) => c.name() === "dashboard")!;
    expect(cmd).toBeDefined();
    expect(cmd.options.map((o) => o.long)).toEqual(expect.arrayContaining(["--port", "--no-open"]));
  });

  it("a bad --port value is a usage error (exit 2)", async () => {
    for (const bad of ["abc", "-1", "70000", "1.5"]) {
      const program = buildProgram().configureOutput({ writeOut: () => {}, writeErr: () => {} });
      const err = await program.parseAsync(["node", "codeloom", "dashboard", "--port", bad, "--no-open"]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(exitCodeFor(err), bad).toBe(2);
    }
  });
});
