import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { WORKSPACE_FILE } from "../src/store/paths.js";
import { loadWorkspaceData, readEndpoints, readGraph } from "../src/store/read.js";
import { makeRepo } from "./helpers.js";

const GRAPH = {
  version: "1.0.0",
  project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
  nodes: [{ id: "file:a.ts", type: "file", name: "a.ts", summary: "", tags: [], complexity: "simple" }],
  edges: [],
  layers: [],
  tour: [],
};

const endpointsV2 = (repo: string) => ({
  version: 2, repo,
  pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [],
  dbAccess: [], tables: [], models: [], queues: [],
});

function writeCodeloomFiles(repoAbs: string, files: Record<string, unknown>): void {
  const dir = join(repoAbs, ".codeloom");
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(data));
}

function asCodeloomError(fn: () => unknown): CodeloomError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CodeloomError) return err;
    throw err;
  }
  throw new Error("expected a CodeloomError to be thrown");
}

describe("readGraph", () => {
  it("returns null when graph.json is missing", () => {
    expect(readGraph(makeRepo({}))).toBeNull();
  });

  it("reads a valid graph.json", () => {
    const repo = makeRepo({});
    writeCodeloomFiles(repo, { "graph.json": GRAPH });
    expect(readGraph(repo)?.project.name).toBe("x");
  });
});

describe("readEndpoints", () => {
  it("returns null when endpoints.json is missing", () => {
    expect(readEndpoints(makeRepo({}))).toBeNull();
  });

  it("reads a valid v2 endpoints.json", () => {
    const repo = makeRepo({});
    writeCodeloomFiles(repo, { "endpoints.json": endpointsV2("api") });
    expect(readEndpoints(repo)?.repo).toBe("api");
  });

  it("rejects a v1 endpoints.json with a re-index message, at exit code 2", () => {
    const repo = makeRepo({});
    writeCodeloomFiles(repo, {
      "endpoints.json": {
        version: 1, repo: "api", pages: [], httpCalls: [], routes: [], dbAccess: [], tables: [], models: [], queues: [],
      },
    });
    const err = asCodeloomError(() => readEndpoints(repo));
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/endpoints version 1\)\. Run "codeloom index" to rebuild it\.$/);
  });
});

function makeWorkspace(repos: Array<{ id: string; path: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "codeloom-ws-"));
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify({ version: 1, name: "ws", repos, links: [] }));
  return root;
}

describe("loadWorkspaceData", () => {
  it("loads every repo's graph + endpoints, sorted by repo id", () => {
    const root = makeWorkspace([
      { id: "web", path: "web" },
      { id: "api", path: "api" },
    ]);
    for (const id of ["web", "api"]) {
      mkdirSync(join(root, id), { recursive: true });
      writeCodeloomFiles(join(root, id), { "graph.json": GRAPH, "endpoints.json": endpointsV2(id) });
    }
    const data = loadWorkspaceData(root);
    expect(data.repos.map((r) => r.ref.id)).toEqual(["api", "web"]);
    expect(data.repos[0]!.endpoints.repo).toBe("api");
    expect(data.links).toEqual([]);
  });

  it("gives an exit-2 error naming the un-indexed repo", () => {
    const root = makeWorkspace([{ id: "web", path: "web" }]);
    mkdirSync(join(root, "web"), { recursive: true });
    const err = asCodeloomError(() => loadWorkspaceData(root));
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/"web".*Run "codeloom index" first\./);
  });
});
