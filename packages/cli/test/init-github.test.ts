import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { formatInit, runInit } from "../src/commands/init.js";
import { makeRepo } from "./helpers.js";

const BUILD_PATH = ".github/workflows/codeloom-review-build.yml";
const PUBLISH_PATH = ".github/workflows/codeloom-review-publish.yml";

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

  it("keeps an existing customised workflow file, reporting it as kept", () => {
    const repo = makeRepo({ "a.ts": "" });
    mkdirSync(join(repo, ".github/workflows"), { recursive: true });
    writeFileSync(join(repo, BUILD_PATH), "name: my own build\n# customised by hand\n");
    const res = runInit(repo, { github: true });

    expect(res.created).not.toContain(BUILD_PATH);
    expect(readFileSync(join(repo, BUILD_PATH), "utf8")).toBe("name: my own build\n# customised by hand\n");
    expect(res.github).toEqual(
      expect.arrayContaining([{ path: BUILD_PATH, status: "kept-custom" }, { path: PUBLISH_PATH, status: "created" }]),
    );
    expect(formatInit(res).toLowerCase()).toContain("kept");
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
    const build = parse(readFileSync(join(repo, BUILD_PATH), "utf8"));
    const publish = parse(readFileSync(join(repo, PUBLISH_PATH), "utf8"));

    it("parses as YAML", () => {
      expect(build.name).toBe("codeloom review build");
      expect(publish.name).toBe("codeloom review publish");
    });

    it("the build workflow has read-only permissions and never a write token", () => {
      expect(build.permissions).toEqual({ contents: "read" });
      expect(JSON.stringify(build)).not.toMatch(/contents['"]?\s*:\s*['"]?write/);
    });

    it("the publish workflow has exactly the permissions it needs", () => {
      expect(publish.permissions).toEqual({ contents: "write", "pull-requests": "write", actions: "read" });
    });

    function allSteps(workflow: unknown): Array<Record<string, unknown>> {
      const jobs = (workflow as { jobs: Record<string, { steps?: Array<Record<string, unknown>> }> }).jobs;
      return Object.values(jobs).flatMap((j) => j.steps ?? []);
    }

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
  });
});
