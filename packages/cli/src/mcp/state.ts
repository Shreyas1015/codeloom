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
  const journeysFile = readJson(journeysPath, JourneysFileSchema, { handWritten: true });
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

/** Chains with a stop at that repo+nodeId, or (for a file node) at that repo+file, or (for a class node) at
 * one of its method nodes (`function:<file>:<Class>.<method>`, v0.2a §1 — before method nodes existed those
 * stops pointed at the class node itself). Sorted by id. */
export function chainsTouchingNode(state: MapState, ref: NodeRef): Chain[] {
  const file = fileOfFileNode(state, ref);
  const methodPrefix = ref.nodeId.startsWith("class:") ? `function:${ref.nodeId.slice("class:".length)}.` : undefined;
  return state.chains
    .filter((c) =>
      c.stops.some((s) => s.repo === ref.repo && (
        s.nodeId === ref.nodeId
        || (file !== undefined && s.file === file)
        || (methodPrefix !== undefined && s.nodeId?.startsWith(methodPrefix) === true)
      )),
    )
    .sort((a, b) => compare(a.id, b.id));
}

/** What a journey's stored chain ids point at now (H11). */
export interface ChainResolution<C> {
  /** The chains found, by id or through an alias: deduped, sorted by id. */
  chains: C[];
  /** Stored ids that resolve neither as an id nor as an alias (sorted). */
  missing: string[];
  /** Stored ids found only as another chain's alias, with the current ids they point to (sorted by `from`). */
  moved: Array<{ from: string; to: string[] }>;
}

export interface ChainLookup<C> {
  resolve(ids: readonly string[]): ChainResolution<C>;
}

/** The one way readers turn a journey's chain ids into chains: ids first, then aliases (H11). A saved
 * journey thereby keeps finding its flow after the chain gains a UI step (route-only → call-entry →
 * page chain) without journeys.json being rewritten. */
export function chainLookup<C extends Pick<Chain, "id" | "aliases">>(chains: readonly C[]): ChainLookup<C> {
  const byId = new Map<string, C>();
  for (const c of chains) if (!byId.has(c.id)) byId.set(c.id, c);
  const byAlias = new Map<string, C[]>();
  for (const c of [...byId.values()].sort((a, b) => compare(a.id, b.id))) {
    for (const a of c.aliases ?? []) byAlias.set(a, [...(byAlias.get(a) ?? []), c]);
  }
  return {
    resolve(ids) {
      const found = new Map<string, C>();
      const missing: string[] = [];
      const moved: Array<{ from: string; to: string[] }> = [];
      for (const id of [...new Set(ids)].sort(compare)) {
        const direct = byId.get(id);
        if (direct) {
          found.set(direct.id, direct);
          continue;
        }
        const via = byAlias.get(id);
        if (!via) {
          missing.push(id);
          continue;
        }
        for (const c of via) found.set(c.id, c);
        moved.push({ from: id, to: via.map((c) => c.id) });
      }
      return { chains: [...found.values()].sort((a, b) => compare(a.id, b.id)), missing, moved };
    },
  };
}

/** Current chain id → ids of the journeys naming it, directly or through an alias (sorted). */
export function journeysByChain(state: Pick<MapState, "chains" | "journeys">): Map<string, string[]> {
  const lookup = chainLookup(state.chains);
  const out = new Map<string, string[]>();
  for (const j of [...state.journeys].sort((a, b) => compare(a.id, b.id))) {
    for (const c of lookup.resolve(j.chainIds).chains) {
      const list = out.get(c.id) ?? [];
      if (!list.includes(j.id)) list.push(j.id);
      out.set(c.id, list);
    }
  }
  return out;
}

/** Journeys holding at least one of the chain ids (directly or through an alias). Sorted by id. */
export function journeysForChains(state: MapState, chainIds: Set<string>): Journey[] {
  const lookup = chainLookup(state.chains);
  return state.journeys
    .filter((j) => j.chainIds.some((id) => chainIds.has(id)) || lookup.resolve(j.chainIds).chains.some((c) => chainIds.has(c.id)))
    .sort((a, b) => compare(a.id, b.id));
}
