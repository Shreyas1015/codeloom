export const CODELOOM_DIR = ".codeloom";
export const WORKSPACE_FILE = "codeloom.workspace.json";
export const MCP_FILE = ".mcp.json";
export const FILES = {
  config: "config.json",
  graph: "graph.json",
  endpoints: "endpoints.json",
  fingerprints: "fingerprints.json",
  chains: "chains.json",
  journeys: "journeys.json",
  summaries: "summaries.json",
  specCandidates: "spec-candidates.json",
  /** 0.6 §5: the user's answers about the map (map-interview), applied on every link. */
  answers: "answers.json",
} as const;
