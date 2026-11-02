import { dataError } from "../../errors.js";
import type { TracesConfig } from "../../store/schemas.js";
import { spansFromOtlp, type TraceSpan } from "./otlp.js";

export interface TempoOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number; // 10000, per request
  totalTimeoutMs?: number; // 60000, for the whole fetch (search + every trace)
  limit?: number; // 100 traces
}

/** The Tempo endpoint was unreachable, denied the request, or sent something unusable: network error,
 * timeout (per request or overall), non-2xx status, invalid JSON, a trace document of an unexpected
 * shape, or a header env var that cannot be decoded. Never includes header values. */
export class TraceSourceError extends Error {}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 100;
const SPANS_PER_SPAN_SET = 50;
const MAX_CONCURRENT_TRACE_FETCHES = 4;
/** TraceQL: server spans that carry a route — the spans `compareTraces` cares about. */
const SEARCH_QUERY = "{ span.http.route != nil && kind = server }";

const LOOKBACK_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "15m" | "1h" | "24h" | "7d" → milliseconds. Absent → 1h. Anything else → dataError (exit 2). */
export function parseLookback(s: string | undefined): number {
  const raw = s ?? "1h";
  const match = /^(\d+)(m|h|d)$/.exec(raw);
  if (!match) {
    throw dataError(`invalid traces.lookback "${raw}": expected a number followed by m, h or d, e.g. "15m", "1h", "24h", "7d".`);
  }
  return Number(match[1]) * LOOKBACK_UNITS[match[2]];
}

/** `headersEnv`'s value, OTEL style: "k1=v1,k2=v2", values URL-decoded. Missing env var / no headersEnv → {}.
 * A value that is not valid URL encoding → TraceSourceError naming the env var (never the value). */
function parseHeaders(env: NodeJS.ProcessEnv, headersEnv: string | undefined): Record<string, string> {
  if (!headersEnv) return {};
  const raw = env[headersEnv];
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    if (!key) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      headers[key] = decodeURIComponent(value);
    } catch (err) {
      if (err instanceof URIError) throw new TraceSourceError(`could not decode the header in ${headersEnv}`);
      throw err;
    }
  }
  return headers;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** GETs `path` as JSON. Any failure (network, timeout, non-2xx, unparsable body) → TraceSourceError
 * naming the status (when there is one) and the path — never the headers. */
async function getJson(
  fetchImpl: typeof fetch,
  root: string,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number,
  overall: AbortSignal,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${root}${path}`, {
      headers: { ...headers, accept: "application/json" },
      signal: anySignal([AbortSignal.timeout(timeoutMs), overall]),
    });
  } catch (err) {
    if (overall.aborted) throw overall.reason;
    if (isTimeout(err)) throw new TraceSourceError(`Tempo request to ${path} timed out after ${timeoutMs}ms`);
    const message = err instanceof Error ? err.message : String(err);
    throw new TraceSourceError(`Tempo request to ${path} failed: ${message}`);
  }
  if (!res.ok) {
    throw new TraceSourceError(`Tempo request to ${path} failed: ${res.status} ${res.statusText}`.trimEnd());
  }
  try {
    return await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TraceSourceError(`Tempo request to ${path} returned invalid JSON: ${message}`);
  }
}

/** An AbortSignal that aborts when any of `signals` does (AbortSignal.any needs Node 20.3). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}

function traceIdsOf(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return [];
  const traces = (doc as Record<string, unknown>).traces;
  if (!Array.isArray(traces)) return [];
  const ids: string[] = [];
  for (const entry of traces) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).traceID;
    if (typeof id === "string" && id !== "") ids.push(id);
  }
  return ids;
}

/** Searches Tempo for server spans with an http.route in the lookback window, then fetches each trace
 * and parses it with `spansFromOtlp` (old or new semconv, OTLP or Tempo's legacy `batches` shape). At
 * most 4 trace fetches run at once; the returned spans keep the search result's trace order regardless
 * of which fetch finishes first. The whole fetch has one overall deadline (`totalTimeoutMs`, 60 s) on
 * top of the per-request timeout. Network/HTTP errors, timeouts, an undecodable header env var and a
 * trace document of an unexpected shape throw TraceSourceError; a bad `cfg.lookback` throws dataError
 * (exit 2, via parseLookback). */
export async function fetchTempoSpans(cfg: Extract<TracesConfig, { kind: "tempo" }>, opts: TempoOptions = {}): Promise<TraceSpan[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const headers = parseHeaders(env, cfg.headersEnv);
  const root = trimTrailingSlash(cfg.url);

  const end = Math.floor(now().getTime() / 1000);
  const start = end - Math.floor(parseLookback(cfg.lookback) / 1000);
  const searchPath = `/api/search?q=${encodeURIComponent(SEARCH_QUERY)}&start=${start}&end=${end}&limit=${limit}&spss=${SPANS_PER_SPAN_SET}`;

  const overall = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new TraceSourceError(`Tempo did not finish within ${totalTimeoutMs}ms overall`);
      overall.abort(err); // cancel in-flight requests and stop workers from starting new ones
      reject(err);
    }, totalTimeoutMs);
  });

  async function fetchAll(): Promise<TraceSpan[]> {
    const searchDoc = await getJson(fetchImpl, root, searchPath, headers, timeoutMs, overall.signal);
    const traceIds = traceIdsOf(searchDoc);

    const spansByTrace: TraceSpan[][] = new Array(traceIds.length);
    let next = 0;
    async function worker(): Promise<void> {
      for (;;) {
        if (overall.signal.aborted) return;
        const i = next++;
        if (i >= traceIds.length) return;
        const tracePath = `/api/traces/${encodeURIComponent(traceIds[i])}`;
        const doc = await getJson(fetchImpl, root, tracePath, headers, timeoutMs, overall.signal);
        try {
          spansByTrace[i] = spansFromOtlp(doc);
        } catch {
          throw new TraceSourceError(`unexpected trace response from ${tracePath}`);
        }
      }
    }
    const workerCount = Math.min(MAX_CONCURRENT_TRACE_FETCHES, traceIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return spansByTrace.flat();
  }

  try {
    return await Promise.race([fetchAll(), deadline]);
  } finally {
    clearTimeout(timer);
    // Whatever ended the race (success, a failed trace, the deadline), stop the remaining workers and
    // cancel their in-flight requests, so the command can exit right away.
    if (!overall.signal.aborted) overall.abort(new TraceSourceError("Tempo fetch finished"));
    deadline.catch(() => {}); // never settles once cleared; this only silences a reject that raced the result
  }
}
