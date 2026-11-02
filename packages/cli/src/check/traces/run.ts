import { resolve } from "node:path";
import type { BuildReportOptions } from "../../commands/check.js";
import type { WorkspaceData } from "../../store/read.js";
import type { Chain, TracesReport, TracesSkipped } from "../../store/schemas.js";
import { compareTraces } from "./compare.js";
import { readOtlpFile } from "./otlp.js";

/** Load spans from the workspace's trace source and compare them with the map. No source configured →
 * a `skipped` reason. A missing or unreadable otlp file is a dataError (exit 2). Traces never change
 * `codeloom check`'s exit code. */
export async function runTraces(ws: WorkspaceData, chains: Chain[], _opts: BuildReportOptions): Promise<TracesReport | TracesSkipped> {
  const cfg = ws.traces;
  if (!cfg) return { skipped: "no trace source in codeloom.workspace.json" };
  if (cfg.kind === "otlp-file") {
    // Relative to the workspace root, wherever codeloom was started from.
    const spans = readOtlpFile(resolve(ws.root, cfg.path));
    return compareTraces(chains, ws, spans, "otlp-file");
  }
  // Tempo is Plan 2b Task 10: it replaces this with fetchTempoSpans (opts.fetchImpl / opts.now), turning a
  // TraceSourceError into { skipped: "tempo unreachable: <message>" }.
  return { skipped: "tempo source not implemented yet" };
}
