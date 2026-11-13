import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { formatInit, runInit } from "../src/commands/init.js";
import { makeRepo } from "./helpers.js";

const BUILD_PATH = ".github/workflows/codeloom-review-build.yml";
const PUBLISH_PATH = ".github/workflows/codeloom-review-publish.yml";

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), "../templates/github");
const buildTemplate = readFileSync(join(templatesDir, "codeloom-review-build.yml"), "utf8");
const publishTemplate = readFileSync(join(templatesDir, "codeloom-review-publish.yml"), "utf8");

describe("codeloom init --github", () => {
  it("writes both workflow files with the running codeloom version", () => {
    const repo = makeRepo({ "a.ts": "" });
    const res = runInit(repo, { github: true });

    expect(res.created).toEqual(expect.arrayContaining([BUILD_PATH, PUBLISH_PATH]));
    for (const path of [BUILD_PATH, PUBLISH_PATH]) {
      const text = readFileSync(join(repo, path), "utf8");
      expect(text).not.toContain("{{version}}");
      expect(text).toContain(`codeloom@${VERSION}`);
    }
  });

  it("is a no-op the second time (no duplicate reporting, file unchanged)", () => {
    const repo = makeRepo({ "a.ts": "" });
    runInit(repo, { github: true });
    const before = readFileSync(join(repo, BUILD_PATH), "utf8");
    const res = runInit(repo, { github: true });
    expect(res.created).not.toContain(BUILD_PATH);
    expect(res.created).not.toContain(PUBLISH_PATH);
    expect(readFileSync(join(repo, BUILD_PATH), "utf8")).toBe(before);
    expect(res.github).toEqual([
      { path: BUILD_PATH, status: "present" },
      { path: PUBLISH_PATH, status: "present" },
    ]);
  });

  it("keeps an existing customised workflow file, reporting that it differs and should be deleted to update", () => {
    const repo = makeRepo({ "a.ts": "" });
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, BUILD_PATH), "name: my own build\n# customised by hand\n");
    const res = runInit(repo, { github: true });

    expect(res.created).not.toContain(BUILD_PATH);
    expect(readFileSync(join(repo, BUILD_PATH), "utf8")).toBe("name: my own build\n# customised by hand\n");
    expect(res.github).toEqual(
      expect.arrayContaining([{ path: BUILD_PATH, status: "kept-custom" }, { path: PUBLISH_PATH, status: "created" }]),
    );
    const formatted = formatInit(res);
    expect(formatted).toContain(`${BUILD_PATH}: differs from this version's template; delete it to update`);
  });

  it("does not write the workflows without --github", () => {
    const repo = makeRepo({ "a.ts": "" });
    const res = runInit(repo);
    expect(res.github).toBeUndefined();
    expect(existsSync(join(repo, BUILD_PATH))).toBe(false);
  });

  describe("the installed YAML", () => {
    const repo = makeRepo({ "a.ts": "" });
    runInit(repo, { github: true });
    const buildText = readFileSync(join(repo, BUILD_PATH), "utf8");
    const publishText = readFileSync(join(repo, PUBLISH_PATH), "utf8");
    const build = parse(buildText);
    const publish = parse(publishText);

    function allSteps(workflow: unknown): Array<Record<string, unknown>> {
      const jobs = (workflow as { jobs: Record<string, { steps?: Array<Record<string, unknown>> }> }).jobs;
      return Object.values(jobs).flatMap((j) => j.steps ?? []);
    }

    it("parses as YAML", () => {
      expect(build.name).toBe("codeloom review build");
      expect(publish.name).toBe("codeloom review publish");
    });

    it("the build workflow has read-only permissions and never a write token", () => {
      expect(build.permissions).toEqual({ contents: "read" });
      expect(JSON.stringify(build)).not.toMatch(/contents['"]?\s*:\s*['"]?write/);
    });

    // Important #4, #17: permissions live per job, not at workflow level — the cleanup job needs
    // only contents: write, never the publish job's pull-requests/actions/pages scopes.
    it("the publish workflow's permissions are per job, each with exactly what it needs", () => {
      expect(publish.permissions).toBeUndefined();
      expect(publish.jobs.publish.permissions).toEqual({
        contents: "write",
        "pull-requests": "write",
        actions: "read",
        pages: "read",
      });
      expect(publish.jobs.cleanup.permissions).toEqual({ contents: "write" });
    });

    it("the build workflow checks out the PR head (it runs the PR's own code, trusted only with contents: read)", () => {
      const checkout = allSteps(build).find((s) => s.uses === "actions/checkout@v4");
      expect((checkout?.with as Record<string, unknown> | undefined)?.ref).toBe("${{ github.event.pull_request.head.sha }}");
    });

    it("the publish workflow never checks out the PR's own ref — only gh-pages, or no ref (the base branch)", () => {
      const checkouts = allSteps(publish).filter((s) => s.uses === "actions/checkout@v4");
      expect(checkouts.length).toBeGreaterThan(0);
      for (const step of checkouts) {
        const ref = (step.with as Record<string, unknown> | undefined)?.ref;
        if (ref !== undefined) expect(ref).toBe("gh-pages");
      }
    });

    it("only pins GitHub-owned actions, by major version", () => {
      const uses = [...allSteps(build), ...allSteps(publish)].map((s) => s.uses).filter((u): u is string => typeof u === "string");
      expect(uses.length).toBeGreaterThan(0);
      for (const u of uses) expect(u).toMatch(/^actions\/[a-z-]+@v\d+$/);
    });

    // Minor: no "${{ ... }}" may appear inside any run: script in either template — every value a
    // script needs must come in through env:, never interpolated straight into the shell.
    it("no run: script in either template interpolates \"${{ ... }}\" directly", () => {
      const runs = [...allSteps(build), ...allSteps(publish)].map((s) => s.run).filter((r): r is string => typeof r === "string");
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) expect(run).not.toContain("${{");
    });

    // Important #3: a run GitHub itself cancelled (e.g. a superseded push) must not be treated as a
    // failed build and posted as one.
    it("the publish job is skipped for a cancelled build run", () => {
      expect(publish.jobs.publish.if).toContain("conclusion != 'cancelled'");
    });

    // Important #7: a single global concurrency group would let GitHub cancel one PR's pending
    // publish because another PR's publish queued after it (GitHub keeps only one pending run per
    // group). The group must be scoped per PR (or, for a fork PR, per source branch).
    it("the publish/cleanup concurrency group is scoped per PR, not one global group", () => {
      const group = publish.concurrency.group as string;
      expect(group).not.toBe("codeloom-pages");
      expect(group).toContain("github.event.pull_request.number");
      expect(group).toContain("github.event.workflow_run.pull_requests[0].number");
      expect(group).toContain("github.event.workflow_run.head_branch");
    });

    // Important #2: gh-pages must only ever be written for a real, successfully-validated snapshot —
    // never for a failed build's block, and never for a refused artifact.
    it("the gh-pages publish and commit steps only run for a successful, validated snapshot", () => {
      for (const name of ["Publish the site to gh-pages", "Commit and push gh-pages"]) {
        const step = allSteps(publish).find((s) => s.name === name);
        expect(step, name).toBeTruthy();
        const condition = step!.if as string;
        expect(condition, name).toContain("mode.outputs.mode == 'data'");
        expect(condition, name).toContain("build_site.outputs.exit_code == '0'");
      }
    });

    // Minor: $PR must be validated as a plain integer, in both the job that resolves it from the
    // workflow_run event and the cleanup job that takes it straight from pull_request_target.
    it("validates the PR number is a plain integer before using it in a shell command", () => {
      const integerGuard = /\*\[!0-9\]\*/g;
      expect(publishText.match(integerGuard)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    // Important #5: a fork PR's lookup-by-commit must be filtered to exactly one open PR whose head
    // matches this commit and this head repo — never an unrelated or already-merged PR that happens
    // to share the commit.
    it("the fork-PR lookup by commit is filtered to an open PR with a matching head", () => {
      expect(publishText).toContain('.state == "open"');
      expect(publishText).toContain(".head.sha == $sha");
      expect(publishText).toContain(".head.repo.full_name == $repo");
    });

    it("requires the workflow_run to be for a pull_request build", () => {
      expect(publish.jobs.publish.if).toContain("github.event.workflow_run.event == 'pull_request'");
    });

    // Important #1: only -F/--field reads "@file" as a file; -f/--raw-field would send the literal
    // string "@site/comment.md", so the comment would show that text instead of the PR block and a
    // new comment would be posted on every run (the START-marker lookup would never match).
    it("uploads the oversized-block comment with -F (which reads @file), never -f", () => {
      expect(publishText).toContain("-F body=@site/comment.md");
      expect(publishText).not.toMatch(/(?<!-)-f body=@/);
    });

    // Minor: the comment lookup must resolve to a single id even when GitHub paginates the issue's
    // comments across pages (a per-page --jq filter without --slurp can otherwise yield one line per
    // page, some empty).
    it("the comment lookup slurps every page before filtering to a single id", () => {
      expect(publishText).toContain("--slurp");
      expect(publishText).toMatch(/jq\s+'add \| map\(select\(/);
    });

    // Minor: filter the comment lookup to codeloom's own comments, not any comment that happens to
    // start with the marker.
    it("the comment lookup is filtered to codeloom's own bot comments", () => {
      expect(publishText).toContain('.user.login == "github-actions[bot]"');
    });

    // Important #4: the "Pages not enabled" note is now rendered by snapshot-site itself (--pages-disabled),
    // never appended to a file after the block markers (which would accumulate outside them forever).
    it("passes --pages-disabled to snapshot-site instead of appending a note after the block", () => {
      expect(publishText).toContain("--pages-disabled");
      expect(publishText).not.toMatch(/>>\s*"?\$?FILE"?/);
    });

    it("the publish job has pages: read, to check whether GitHub Pages is enabled", () => {
      expect(publish.jobs.publish.permissions.pages).toBe("read");
    });

    // Minor: gh-pages is pushed before the PR is edited, so the PR's link is already live by the
    // time a reviewer can click it.
    it("pushes gh-pages before updating the pull request", () => {
      const names = allSteps(publish).map((s) => s.name).filter((n): n is string => typeof n === "string");
      expect(names.indexOf("Commit and push gh-pages")).toBeLessThan(names.indexOf("Update the pull request"));
      expect(names.indexOf("Commit and push gh-pages")).toBeGreaterThan(-1);
    });

    // Minor: a brand-new gh-pages branch, and an already-existing one that predates this fix, both
    // need a .nojekyll file so GitHub Pages serves folders/files Jekyll would otherwise treat
    // specially.
    it("writes a .nojekyll file at the gh-pages root", () => {
      expect(publishText).toContain(".nojekyll");
    });

    // Minor: a transient push race (another PR's publish pushed first) must be retried, not fail the
    // whole run on the first conflict.
    it("retries the gh-pages push up to 3 times", () => {
      const pushRetries = publishText.match(/for attempt in 1 2 3/g) ?? [];
      expect(pushRetries.length).toBeGreaterThanOrEqual(2); // publish job's push + cleanup job's push
    });
  });

  describe("docs/pr-review-maps.md", () => {
    const docsPath = join(dirname(fileURLToPath(import.meta.url)), "../../../docs/pr-review-maps.md");
    const docs = readFileSync(docsPath, "utf8");

    /** The fenced ```yaml block that immediately follows a "### `.github/workflows/<name>`" heading. */
    function embeddedBlock(name: string): string {
      const heading = `.github/workflows/${name}`;
      const re = new RegExp("### `" + heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "`\\n\\n```yaml\\n([\\s\\S]*?)\\n```");
      const m = re.exec(docs);
      if (!m) throw new Error(`docs/pr-review-maps.md has no embedded ${name} block`);
      return m[1]! + "\n";
    }

    it("embeds codeloom-review-build.yml verbatim, with {{version}} shown as <version>", () => {
      expect(embeddedBlock("codeloom-review-build.yml")).toBe(buildTemplate.split("{{version}}").join("<version>"));
    });

    it("embeds codeloom-review-publish.yml verbatim, with {{version}} shown as <version>", () => {
      expect(embeddedBlock("codeloom-review-publish.yml")).toBe(publishTemplate.split("{{version}}").join("<version>"));
    });
  });
});
