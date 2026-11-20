import { Command, CommanderError } from "commander";
import { findClaude, runClaudeHeadless } from "./claude/headless.js";
import { runCheck } from "./commands/check.js";
import { openBrowser, runDashboard } from "./commands/dashboard.js";
import { CodeloomError, dataError } from "./errors.js";
import { formatDoctor, runDoctor } from "./commands/doctor.js";
import { codeloomBin, formatInit, runInit } from "./commands/init.js";
import { effectiveYes, formatInitWizard, readlineAsk, runInitWizard } from "./commands/init-wizard.js";
import { formatIndexSummary, formatLinkSummary, runIndex, runLink } from "./commands/index-cmd.js";
import { runAskCommand, runGaps, spawnInherit } from "./commands/gaps.js";
import { isInteractive, parseReviewFormat, runReviewCommand, terminalConfirm } from "./commands/review.js";
import { runPrCommand } from "./commands/pr.js";
import { runServeCommand } from "./commands/serve.js";
import { parseMaxSize, parsePrNumber, runSnapshot, runSnapshotSite } from "./commands/snapshot.js";
import { formatViewsList, runViewsReset } from "./commands/views.js";
import { VERSION } from "./version.js";
import { serveStaticSite } from "./web/static-site.js";

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
    .description("Guided one-step setup: pick your repos, commit or keep codeloom local, connect Claude Code, index, and open the dashboard")
    .argument("[dir]", "folder to set up", ".")
    .option("--github", "also write .github/workflows/codeloom-review-build.yml and codeloom-review-publish.yml, pinned to this codeloom version (skips the guided questions)")
    .option("--yes", "take every default instead of asking (for CI and scripts; also the default when stdin or stdout is not a terminal)")
    .action(async (dir: string, opts: { github?: boolean; yes?: boolean }) => {
      if (opts.github) {
        // --github is an automation flag (CI workflow install): run the plain, non-interactive setup.
        console.log(formatInit(runInit(dir, { bin: codeloomBin(), github: true })));
        return;
      }
      const ask = readlineAsk();
      try {
        const result = await runInitWizard(dir, {
          ask,
          yes: effectiveYes(opts.yes),
          bin: codeloomBin(),
          claude: findClaude(),
          run: runClaudeHeadless,
          openDashboard: async (root) => {
            await runDashboard(root, {});
          },
        });
        console.log(formatInitWizard(result));
      } finally {
        // Closes the readline interface so an interactive run returns to the shell; without this the
        // open stdin listener keeps the process alive even after the wizard is done.
        ask.close();
      }
    });

  program
    .command("index")
    .description("Index this repo and link it with the other repos of its group, or every repo of a workspace folder (only changed files are re-parsed)")
    .option("--quiet", "print nothing on success")
    .option("--group <name>", "the group this repo joins (default: its git remote's host/owner, else its parent folder's name)")
    .action(async (opts: { quiet?: boolean; group?: string }) => {
      const result = await runIndex(process.cwd(), opts.group !== undefined ? { group: opts.group } : {});
      if (!opts.quiet) console.log(formatIndexSummary(result));
    });

  program
    .command("link")
    .description("Link the map again from every repo's saved map, parsing nothing (after editing answers.json: a group's is in ~/.codeloom/groups/<group>-<hash>/.codeloom/, a workspace folder's in its .codeloom/)")
    .action(() => {
      console.log(formatLinkSummary(runLink(process.cwd())));
    });

  program
    .command("gaps")
    .description("List what codeloom could not settle about the map, as short questions, the ones touching most journeys first")
    .option("--json", "print the list as JSON (what the map_gaps MCP tool returns)")
    .action((opts: { json?: boolean }) => {
      console.log(runGaps(process.cwd(), opts));
    });

  program
    .command("ask")
    .description("Go through the open questions with Claude Code: asks before starting it (the map-interview prompt), else prints how")
    .action(async () => {
      process.exitCode = await runAskCommand(process.cwd(), {
        claude: findClaude(), interactive: isInteractive(), confirm: terminalConfirm, spawn: spawnInherit, print: (t) => console.log(t),
      });
    });

  program
    .command("check")
    .description("Report how complete the journey map is")
    .option("--json", "print the report as JSON (at most 200 items of each kind; see --all)")
    .option("--verbose", "list every info-only item (calls that could not be resolved, calls to other services) instead of counts and 5 examples")
    .option("--all", "with --json: every item of every kind")
    .option("--fail-under <percent>", "exit 1 when the complete percentage is below this")
    .option(
      "--traces",
      'compare the map with runtime traces from "traces" in codeloom.workspace.json (an otlp-file path or a Tempo url)',
    )
    .action(async (opts: { json?: boolean; failUnder?: string; traces?: boolean; verbose?: boolean; all?: boolean }) => {
      const { output, exitCode } = await runCheck(process.cwd(), opts);
      console.log(output);
      process.exitCode = exitCode;
    });

  program
    .command("review")
    .description("The PR block for merge-base(<ref>, HEAD)..HEAD (what it writes, where it matters, risks, code to check, the changed path), ready to paste into a pull request")
    .requiredOption("--base <ref>", 'the ref to compare against, e.g. "origin/main"')
    .option("--repo <id>", "in a folder of separate repos: the repo the pull request is in (only its history is diffed)")
    .option("--format <format>", "markdown (default: the draft), full (every touched chain, the 0.4 layout) or json (the Review model)", "markdown")
    .option("--link <url>", 'add an "Open the full review map" line to the markdown, pointing at this URL')
    .option("--packet", "print the check packet Claude reads (JSON, at most 24,000 characters) instead of the block")
    .option("--check", "let Claude check and correct the draft now (runs your Claude Code, allowed only save_pr_review), then print the checked block")
    .action(async (opts: { base: string; format: string; link?: string; repo?: string; packet?: boolean; check?: boolean }) => {
      await runReviewCommand(
        process.cwd(),
        { base: opts.base, format: parseReviewFormat(opts.format), link: opts.link, repo: opts.repo, packet: opts.packet, check: opts.check },
        { claude: findClaude(), run: runClaudeHeadless, interactive: isInteractive(), confirm: terminalConfirm, print: (t) => console.log(t), warn: (l) => console.error(l) },
      );
    });

  program
    .command("pr")
    .description("On a PR branch: index, build the PR review, let Claude check it if you say so, and open one page that shows what the PR does (also prints the block for the PR description)")
    .option("--base <ref>", 'the ref to compare against (default: origin/main, else main, else master)')
    .option("--repo <id>", "in a folder of separate repos: the repo the pull request is in")
    .option("--check", "let Claude check the PR now, without asking (runs your Claude Code, allowed only save_pr_review)")
    .option("--recheck", "check again even though Claude already saved a review of this head, replacing it (runs without asking, like --check)")
    .option("--no-open", "print the page's URL but do not open a browser")
    .option("--port <port>", "port for the local page (default: a free one)")
    .option("--out <dir>", "folder to write the page into (default: .codeloom/pr/<short head>/ in the workspace folder, or in a group's data folder ~/.codeloom/groups/<group>-<hash>/: never inside your repo)")
    .action(async (opts: { base?: string; repo?: string; check?: boolean; recheck?: boolean; open: boolean; port?: string; out?: string }) => {
      const port = parsePort(opts.port);
      const result = await runPrCommand(
        process.cwd(),
        { base: opts.base, repo: opts.repo, check: opts.check, recheck: opts.recheck, open: opts.open, port, out: opts.out },
        {
          claude: findClaude(),
          run: runClaudeHeadless,
          interactive: isInteractive(),
          confirm: terminalConfirm,
          print: (t) => console.log(t),
          warn: (l) => console.error(l),
          index: (start) => runIndex(start),
          open: openBrowser,
          serve: (dir, p) => serveStaticSite(dir, { port: p }),
        },
      );
      if (result.url === undefined) return;
      // Stay up until Ctrl+C (the open server keeps the process alive), then close and exit 0.
      const signals = ["SIGINT", "SIGTERM"] as const;
      const onSignal = () => {
        for (const sig of signals) process.off(sig, onSignal);
        result.close().finally(() => process.exit(0));
      };
      for (const sig of signals) process.on(sig, onSignal);
    });

  program
    .command("snapshot")
    .description("Write a hosted PR snapshot's data/*.json for merge-base(<ref>, HEAD)..HEAD, and, unless --data-only, the dashboard site + review.md next to it")
    .requiredOption("--base <ref>", 'the ref to compare against, e.g. "origin/main"')
    .requiredOption("--out <dir>", "folder to write the snapshot into")
    .option("--repo <id>", "in a folder of separate repos: the repo the pull request is in (only its history is diffed)")
    .option("--max-size <size>", 'size cap for the snapshot, e.g. "25MB" (default 25MB)')
    .option("--data-only", "write only data/*.json: no dashboard assets, no review.md (the untrusted build step)")
    .action(async (opts: { base: string; out: string; repo?: string; maxSize?: string; dataOnly?: boolean }) => {
      const result = await runSnapshot(process.cwd(), { base: opts.base, out: opts.out, repo: opts.repo, maxBytes: parseMaxSize(opts.maxSize), dataOnly: opts.dataOnly });
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
    .option("--pages-disabled", 'GitHub Pages is not enabled for this repo: the block gets a one-line note instead of any "Open the full review map" link (valid with --data or --failed)')
    .action((opts: { out: string; data?: string; head?: string; failed?: string; previous?: string; pr?: string; repo?: string; link?: string; body?: string; maxSize?: string; pagesDisabled?: boolean }) => {
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
        pagesDisabled: opts.pagesDisabled,
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
