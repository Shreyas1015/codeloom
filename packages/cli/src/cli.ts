import { Command, CommanderError } from "commander";
import { runCheck } from "./commands/check.js";
import { runDashboard } from "./commands/dashboard.js";
import { CodeloomError, dataError } from "./errors.js";
import { formatDoctor, runDoctor } from "./commands/doctor.js";
import { codeloomBin, formatInit, runInit } from "./commands/init.js";
import { formatIndexSummary, runIndex } from "./commands/index-cmd.js";
import { parseReviewFormat, runReview } from "./commands/review.js";
import { runServeCommand } from "./commands/serve.js";
import { parseMaxSize, parsePrNumber, runSnapshot, runSnapshotSite } from "./commands/snapshot.js";
import { formatViewsList, runViewsReset } from "./commands/views.js";
import { VERSION } from "./version.js";

export { VERSION };

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("codeloom")
    .description("Map a codebase into user journeys, for you and your AI agent.")
    .version(VERSION)
    // Throw instead of exiting, so bin.ts maps usage errors to exit 2 (subcommands inherit this).
    .exitOverride();

  program
    .command("init")
    .description("Set up codeloom in a repo, or in a folder of repos (a workspace)")
    .argument("[dir]", "folder to set up", ".")
    .option("--github", "also write .github/workflows/codeloom-review-build.yml and codeloom-review-publish.yml, pinned to this codeloom version")
    .action((dir: string, opts: { github?: boolean }) => {
      console.log(formatInit(runInit(dir, { bin: codeloomBin(), github: opts.github })));
    });

  program
    .command("index")
    .description("Index every repo in this workspace (only changed files are re-parsed)")
    .option("--quiet", "print nothing on success")
    .action(async (opts: { quiet?: boolean }) => {
      const result = await runIndex(process.cwd());
      if (!opts.quiet) console.log(formatIndexSummary(result));
    });

  program
    .command("check")
    .description("Report how complete the journey map is")
    .option("--json", "print the report as JSON")
    .option("--fail-under <percent>", "exit 1 when the complete percentage is below this")
    .option(
      "--traces",
      'compare the map with runtime traces from "traces" in codeloom.workspace.json (an otlp-file path or a Tempo url)',
    )
    .action(async (opts: { json?: boolean; failUnder?: string; traces?: boolean }) => {
      const { output, exitCode } = await runCheck(process.cwd(), opts);
      console.log(output);
      process.exitCode = exitCode;
    });

  program
    .command("review")
    .description("The PR block (summary + Mermaid diagram) for merge-base(<ref>, HEAD)..HEAD, ready to paste into a pull request")
    .requiredOption("--base <ref>", 'the ref to compare against, e.g. "origin/main"')
    .option("--format <format>", 'markdown (default) or json (the Review model)', "markdown")
    .option("--link <url>", 'add an "Open the full review map" line to the markdown, pointing at this URL')
    .action((opts: { base: string; format: string; link?: string }) => {
      const { output } = runReview(process.cwd(), { base: opts.base, format: parseReviewFormat(opts.format), link: opts.link });
      console.log(output);
    });

  program
    .command("snapshot")
    .description("Write a hosted PR snapshot's data/*.json for merge-base(<ref>, HEAD)..HEAD, and, unless --data-only, the dashboard site + review.md next to it")
    .requiredOption("--base <ref>", 'the ref to compare against, e.g. "origin/main"')
    .requiredOption("--out <dir>", "folder to write the snapshot into")
    .option("--max-size <size>", 'size cap for the snapshot, e.g. "25MB" (default 25MB)')
    .option("--data-only", "write only data/*.json: no dashboard assets, no review.md (the untrusted build step)")
    .action(async (opts: { base: string; out: string; maxSize?: string; dataOnly?: boolean }) => {
      const result = await runSnapshot(process.cwd(), { base: opts.base, out: opts.out, maxBytes: parseMaxSize(opts.maxSize), dataOnly: opts.dataOnly });
      process.exitCode = result.exitCode;
    });

  program
    .command("snapshot-site")
    .description("The trusted publish step: validate a build artifact's data/*.json, add this codeloom version's dashboard assets, and write the PR block")
    .requiredOption("--out <dir>", "folder to write the site, review.md and body.md/comment.md into")
    .option("--data <dir>", "the build artifact's data/ folder to validate and publish")
    .option("--head <sha>", "the event's own head SHA; must match data/manifest.json's head")
    .option("--failed <run-url>", "the build itself failed: write only the error block, linking to this run")
    .option("--previous <manifest>", 'with --failed: the last good snapshot\'s own data/manifest.json, for the "last good map" link')
    .option("--pr <n>", "pull request number, filled into the manifest")
    .option("--repo <owner/name>", "repo slug, filled into the manifest")
    .option("--link <url>", "the hosted snapshot's URL (or, with --failed, the last good one's)")
    .option("--body <file>", "a file holding the PR's current description, to splice the block into (out/body.md, or out/comment.md over GitHub's body limit)")
    .option("--max-size <size>", 'size cap, e.g. "25MB" (default 25MB)')
    .action((opts: { out: string; data?: string; head?: string; failed?: string; previous?: string; pr?: string; repo?: string; link?: string; body?: string; maxSize?: string }) => {
      const result = runSnapshotSite({
        out: opts.out,
        data: opts.data,
        head: opts.head,
        failed: opts.failed,
        previousManifest: opts.previous,
        pr: parsePrNumber(opts.pr),
        repoSlug: opts.repo,
        link: opts.link,
        bodyFile: opts.body,
        maxBytes: parseMaxSize(opts.maxSize),
      });
      process.exitCode = result.exitCode;
    });

  program
    .command("doctor")
    .description("Check and repair data files, hooks, the .gitignore line and the MCP entry")
    .option("--fix", "repair what is safe to repair (never hand-written or committed map files)")
    .option("--json", "print the report as JSON")
    .action((opts: { fix?: boolean; json?: boolean }) => {
      const report = runDoctor(process.cwd(), { fix: opts.fix, bin: codeloomBin() });
      console.log(opts.json ? JSON.stringify(report, null, 2) : formatDoctor(report));
      process.exitCode = report.summary.error > 0 ? 1 : 0;
    });

  program
    .command("serve")
    .description("Run the codeloom MCP server on stdio, for Claude or any MCP agent")
    .action(async () => {
      await runServeCommand(process.cwd());
    });

  program
    .command("dashboard")
    .description("Open the codeloom dashboard (Home, Journey, Map) in your browser, served from 127.0.0.1")
    .option("--port <port>", "port to listen on (default: the first free one from 4747)")
    .option("--no-open", "print the URL but do not open a browser")
    .action(async (opts: { port?: string; open: boolean }) => {
      await runDashboard(process.cwd(), { port: parsePort(opts.port), open: opts.open });
    });

  const views = program
    .command("views")
    .description("List the dashboard views your agent saved, or delete one (views are written only through MCP)");
  views
    .command("list")
    .description("List the saved views with their dashboard links")
    .action(() => {
      console.log(formatViewsList(process.cwd()));
    });
  views
    .command("reset")
    .description('Delete a view; "reset home" brings back the built-in Home')
    .argument("<id>", "view id")
    .action((id: string) => {
      console.log(runViewsReset(process.cwd(), id));
    });

  return program;
}

/** --port: a whole number 0–65535 (0 = any free port), else a usage error (exit 2). */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n > 65535) throw dataError(`--port must be a whole number between 0 and 65535, got "${raw}".`);
  return n;
}

/** The process exit code for an error thrown out of the program. Commander's own exits (help, version)
 * keep their 0; every other commander error is a usage error (unknown option or command, missing option
 * value): 2. A CodeloomError carries its own code; anything else is unexpected: 1. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CommanderError) return err.exitCode === 0 ? 0 : 2;
  return err instanceof CodeloomError ? err.exitCode : 1;
}
