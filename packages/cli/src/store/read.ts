import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type KnowledgeGraph, KnowledgeGraphSchema } from "@codeloom/core";
import { dataError } from "../errors.js";
import { compare } from "../util.js";
import { loadWorkspace } from "../workspace/repos.js";
import { readJson } from "./json.js";
import { CODELOOM_DIR, FILES } from "./paths.js";
import { type EndpointsFile, EndpointsFileSchema, type ExternalService, type RepoRef, type TracesConfig, type WorkspaceFile } from "./schemas.js";
import { repoAbsPath } from "../workspace/registry.js";

/** Missing file -> null. Bad shape -> CodeloomError (via readJson). */
export function readGraph(repoAbs: string): KnowledgeGraph | null {
  return readJson(join(repoAbs, CODELOOM_DIR, FILES.graph), KnowledgeGraphSchema);
}

/** Missing file -> null. A v1 file (written by a pre-2a codeloom) -> a clear re-index error (exit
 * code 2), checked before the zod parse so this message wins over the generic "unexpected shape" one. */
export function readEndpoints(repoAbs: string): EndpointsFile | null {
  const path = join(repoAbs, CODELOOM_DIR, FILES.endpoints);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return readJson(path, EndpointsFileSchema); // reproduces readJson's own "not valid JSON" error
  }
  if (typeof raw === "object" && raw !== null && (raw as { version?: unknown }).version === 1) {
    throw dataError(`${path} was written by an older codeloom (endpoints version 1). Run "codeloom index" to rebuild it.`, {
      code: "not-indexed",
    });
  }
  return readJson(path, EndpointsFileSchema);
}

export interface RepoData {
  ref: RepoRef;
  abs: string;
  graph: KnowledgeGraph;
  endpoints: EndpointsFile;
  /** 0.6 §2, set by the linker only: the other names the repo goes by (package name, folder, remote repo name),
   * for matching a call's base (`BILLING_API_URL`) to it. */
  names?: string[];
}

export interface WorkspaceData {
  root: string;
  name: string;
  repos: RepoData[];
  /** The workspace file's manual links, then (0.6 §5) the ones from answers.json, marked `source: "answers"`. */
  links: Array<WorkspaceFile["links"][number] & { source?: "answers" }>;
  traces?: TracesConfig;
  /** The workspace file's `external` services (other services the UI calls). */
  external?: ExternalService[];
  /** 0.6 §5 answers: messages published under `publish` arrive on the consumed queue `consume`. */
  queueAliases?: Array<{ publish: string; consume: string }>;
  /** 0.6 §5 answers: where a calling repo's call bases go (see linker/link.ts AnswerHint). */
  baseHints?: Array<{ from?: string; base: string; repo?: string; external?: string }>;
  /** 0.6 §1: the group this map is (absent for a workspace folder or a lone repo). */
  group?: string;
}

/** Every repo's graph + endpoints, sorted by repo id. Any repo missing either file -> dataError
 * (exit code 2) telling the user to run "codeloom index" first. */
export function loadWorkspaceData(start: string): WorkspaceData {
  const ws = loadWorkspace(start);
  const repos: RepoData[] = ws.repos.flatMap((ref) => {
    const abs = repoAbsPath(ws.root, ref);
    const graph = readGraph(abs);
    const endpoints = readEndpoints(abs);
    if (!graph || !endpoints) {
      // A group (0.6 §1) is every repo indexed so far: one whose map was deleted since is left out
      // (codeloom doctor reports it), not a reason to refuse the whole group.
      if (ws.group !== undefined) return [];
      throw dataError(`Repo "${ref.id}" has no .codeloom data yet. Run "codeloom index" first.`, {
        code: "not-indexed",
      });
    }
    return [{ ref, abs, graph, endpoints }];
  });
  repos.sort((a, b) => compare(a.ref.id, b.ref.id));
  return {
    root: ws.root, name: ws.name, repos, links: ws.links, traces: ws.traces, ...(ws.external ? { external: ws.external } : {}),
    ...(ws.group !== undefined ? { group: ws.group } : {}),
  };
}
