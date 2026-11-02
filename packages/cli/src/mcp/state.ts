import { join } from "node:path";
import type { GraphNode } from "@codeloom/core";
import { dataError } from "../errors.js";
import { readJson } from "../store/json.js";
import { CODELOOM_DIR, FILES } from "../store/paths.js";
import { loadWorkspaceData, type RepoData, type WorkspaceData } from "../store/read.js";
import {
  type Chain,
  ChainsFileSchema,
  type Journey,
  JourneysFileSchema,
  type ManualLinkStatus,
  type UiReachFact,
} from "../store/schemas.js";
import { compare } from "../util.js";

/** Everything a tool needs, read fresh from disk on every call (no cache across calls). */
export interface MapState {
  ws: WorkspaceData;
  chains: Chain[];
  uiReach: UiReachFact[];
  manualLinks: ManualLinkStatus[];
  journeys: Journey[];
  chainsPath: string;
  journeysPath: string;
}

/** loadWorkspaceData throws dataError (exit 2) when a repo is not indexed. Missing chains.json /
 * journeys.json → empty lists; a bad one → CodeloomError from readJson. */
export function loadMapState(start: string): MapState {
  const ws = loadWorkspaceData(start);
  const chainsPath = join(ws.root, CODELOOM_DIR, FILES.chains);
  const journeysPath = join(ws.root, CODELOOM_DIR, FILES.journeys);
  const chainsFile = readJson(chainsPath, ChainsFileSchema);
  const journeysFile = readJson(journeysPath, JourneysFileSchema);
  return {
    ws,
    chains: chainsFile?.chains ?? [],
    uiReach: chainsFile?.uiReach ?? [],
    manualLinks: chainsFile?.manualLinks ?? [],
    journeys: journeysFile?.journeys ?? [],
    chainsPath,
    journeysPath,
  };
}

export interface NodeRef {
  repo: string;
  nodeId: string;
}

/** "api::function:src/a.ts:f" → { repo: "api", nodeId: "function:src/a.ts:f" }. Splits on the first "::". */
export function parseNodeRef(s: string): NodeRef {
  const at = s.indexOf("::");
  const repo = at < 0 ? "" : s.slice(0, at);
  const nodeId = at < 0 ? "" : s.slice(at + 2);
  if (!repo || !nodeId) {
    throw dataError(`Bad node reference "${s}". Use the form "<repo>::<nodeId>", e.g. "api::file:src/app.ts".`);
  }
  return { repo, nodeId };
}

export function formatNodeRef(r: NodeRef): string {
  return `${r.repo}::${r.nodeId}`;
}

export function findNode(state: MapState, ref: NodeRef): { repo: RepoData; node: GraphNode } {
  const repo = state.ws.repos.find((r) => r.ref.id === ref.repo);
  if (!repo) {
    const ids = state.ws.repos.map((r) => r.ref.id).join(", ");
    throw dataError(`Unknown repo "${ref.repo}". Repos in this workspace: ${ids}.`);
  }
  const node = repo.graph.nodes.find((n) => n.id === ref.nodeId);
  if (!node) throw dataError(`Unknown node "${ref.nodeId}" in repo "${ref.repo}".`);
  return { repo, node };
}

/** The file a file node stands for: its filePath, else the id after "file:". Undefined for other nodes. */
function fileOfFileNode(state: MapState, ref: NodeRef): string | undefined {
  const repo = state.ws.repos.find((r) => r.ref.id === ref.repo);
  const node = repo?.graph.nodes.find((n) => n.id === ref.nodeId);
  if (node) return node.type === "file" ? (node.filePath ?? ref.nodeId.replace(/^file:/, "")) : undefined;
  return ref.nodeId.startsWith("file:") ? ref.nodeId.slice("file:".length) : undefined;
}

/** Chains with a stop at that repo+nodeId, or (for a file node) at that repo+file. Sorted by id. */
export function chainsTouchingNode(state: MapState, ref: NodeRef): Chain[] {
  const file = fileOfFileNode(state, ref);
  return state.chains
    .filter((c) =>
      c.stops.some((s) => s.repo === ref.repo && (s.nodeId === ref.nodeId || (file !== undefined && s.file === file))),
    )
    .sort((a, b) => compare(a.id, b.id));
}

/** Journeys holding at least one of the chain ids. Sorted by id. */
export function journeysForChains(state: MapState, chainIds: Set<string>): Journey[] {
  return state.journeys.filter((j) => j.chainIds.some((id) => chainIds.has(id))).sort((a, b) => compare(a.id, b.id));
}
