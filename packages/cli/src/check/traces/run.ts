import { resolve } from "node:path";
import type { BuildReportOptions } from "../../commands/check.js";
import type { WorkspaceData } from "../../store/read.js";
import type { Chain, TracesReport, TracesSkipped } from "../../store/schemas.js";
import { compareTraces } from "./compare.js";
import { readOtlpFile } from "./otlp.js";
import { fetchTempoSpans, TraceSourceError } from "./tempo.js";

/** Load spans from the workspace's trace source and compare them with the map. No source configured →
 * a `skipped` reason. A missing or unreadable otlp file, or a bad config value (lookback), is a
 * dataError (exit 2). A Tempo source that is unreachable (network error, timeout, non-2xx) is reported
 * as `skipped`, same as no source — traces never change `codeloom check`'s exit code. */
export async function runTraces(ws: WorkspaceData, chains: Chain[], opts: BuildReportOptions): Promise<TracesReport | TracesSkipped> {
  const cfg = ws.traces;
  if (!cfg) return { skipped: "no trace source in codeloom.workspace.json" };
  if (cfg.kind === "otlp-file") {
    // Relative to the workspace root, wherever codeloom was started from.
    const spans = readOtlpFile(resolve(ws.root, cfg.path));
    return compareTraces(chains, ws, spans, "otlp-file");
  }
  try {
    const spans = await fetchTempoSpans(cfg, { fetchImpl: opts.fetchImpl, now: opts.now });
    return compareTraces(chains, ws, spans, "tempo");
  } catch (err) {
    if (err instanceof TraceSourceError) return { skipped: `tempo unreachable: ${err.message}` };
    throw err;
  }
}
