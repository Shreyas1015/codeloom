import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { fetchTempoSpans, parseLookback, TraceSourceError } from "../src/check/traces/tempo.js";
import type { TracesConfig } from "../src/store/schemas.js";

type TempoCfg = Extract<TracesConfig, { kind: "tempo" }>;

const SEARCH_QUERY = "{ span.http.route != nil && kind = server }";

function searchBody(traceIds: string[]): unknown {
  return { traces: traceIds.map((traceID) => ({ traceID })) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; init?: RequestInit };

function recordingFetch(byUrl: (url: string) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return byUrl(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("parseLookback", () => {
  it("parses minutes, hours and days", () => {
    expect(parseLookback("15m")).toBe(15 * 60_000);
    expect(parseLookback("1h")).toBe(60 * 60_000);
    expect(parseLookback("24h")).toBe(24 * 60 * 60_000);
    expect(parseLookback("7d")).toBe(7 * 24 * 60 * 60_000);
  });

  it("defaults to 1h when absent", () => {
    expect(parseLookback(undefined)).toBe(60 * 60_000);
  });

  it("throws a dataError (exit 2) for a bad value", () => {
    expect(() => parseLookback("soon")).toThrow(CodeloomError);
    try {
      parseLookback("soon");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });
});

describe("fetchTempoSpans", () => {
  const now = () => new Date("2024-01-01T01:00:00.000Z");
  const end = Math.floor(now().getTime() / 1000);
  const start = end - 3600;

  it("builds the search URL and the per-trace URL, and asks for one hour by default", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse(searchBody(["abc123"]));
      if (url.includes("/api/traces/abc123")) return jsonResponse({ resourceSpans: [] });
      throw new Error(`unexpected url: ${url}`);
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200" };
    await fetchTempoSpans(cfg, { fetchImpl, now, env: {} });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      `http://tempo.local:3200/api/search?q=${encodeURIComponent(SEARCH_QUERY)}&start=${start}&end=${end}&limit=100&spss=50`,
    );
    expect(calls[1].url).toBe("http://tempo.local:3200/api/traces/abc123");
    expect((calls[1].init?.headers as Record<string, string> | undefined)?.accept).toBe("application/json");
  });

  it("handles a trailing slash in the configured url", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse(searchBody([]));
      throw new Error(`unexpected url: ${url}`);
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200/" };
    await fetchTempoSpans(cfg, { fetchImpl, now, env: {} });
    expect(calls[0].url.startsWith("http://tempo.local:3200/api/search")).toBe(true);
    expect(calls[0].url.includes("//api/search")).toBe(false);
  });

  it("respects a configured lookback window", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse(searchBody([]));
      throw new Error(`unexpected url: ${url}`);
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200", lookback: "15m" };
    await fetchTempoSpans(cfg, { fetchImpl, now, env: {} });
    expect(calls[0].url).toContain(`&start=${end - 15 * 60}&end=${end}&`);
  });

  it("parses headers from the named env var, OTEL style (k=v,k=v, URL-decoded)", async () => {
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse(searchBody([]));
      throw new Error(`unexpected url: ${url}`);
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200", headersEnv: "TEMPO_HEADERS" };
    const env = { TEMPO_HEADERS: "Authorization=Bearer%20abc123,X-Scope-OrgID=1" };
    await fetchTempoSpans(cfg, { fetchImpl, now, env });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc123");
    expect(headers["X-Scope-OrgID"]).toBe("1");
  });

  it("accepts Tempo's legacy batches shape from /api/traces/<id>", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse(searchBody(["legacy1"]));
      if (url.includes("/api/traces/legacy1")) {
        return jsonResponse({
          batches: [
            {
              resource: { attributes: [{ key: "service.name", value: { stringValue: "billing" } }] },
              instrumentationLibrarySpans: [
                {
                  spans: [
                    {
                      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                      spanId: "00f067aa0ba902b7",
                      kind: 2,
                      attributes: [
                        { key: "http.method", value: { stringValue: "GET" } },
                        { key: "http.route", value: { stringValue: "/health" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200" };
    const spans = await fetchTempoSpans(cfg, { fetchImpl, now, env: {} });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ service: "billing", kind: "server", http: { method: "GET", route: "/health" } });
  });

  it("fetches at most 4 traces concurrently and returns spans in traceID order", async () => {
    const n = 6;
    const traceIds = Array.from({ length: n }, (_, i) => `trace${i}`);
    const hex = (i: number, len: number) => String(i).padStart(len, "0");
    let inFlight = 0;
    let maxInFlight = 0;
    const { fetchImpl } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse(searchBody(traceIds));
      const id = decodeURIComponent(url.split("/").pop()!);
      const i = traceIds.indexOf(id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const delayMs = i === 0 ? 30 : 1; // the first requested trace resolves last
      return new Promise<Response>((resolvePromise) => {
        setTimeout(() => {
          inFlight -= 1;
          resolvePromise(
            jsonResponse({
              resourceSpans: [
                {
                  resource: { attributes: [] },
                  scopeSpans: [{ spans: [{ traceId: hex(i, 32), spanId: hex(i, 16), kind: 1 }] }],
                },
              ],
            }),
          );
        }, delayMs);
      });
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200" };
    const spans = await fetchTempoSpans(cfg, { fetchImpl, now, env: {} });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    // order follows traceIds, not resolution order, even though trace0 is the slowest
    expect(spans.map((s) => s.spanId)).toEqual(Array.from({ length: n }, (_, i) => hex(i, 16)));
  });

  it("throws a TraceSourceError naming the status and path (no headers) on a non-2xx response", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (url.includes("/api/search")) return jsonResponse({ message: "unauthorized" }, 401);
      throw new Error(`unexpected url: ${url}`);
    });
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200", headersEnv: "TEMPO_HEADERS" };
    const err = await fetchTempoSpans(cfg, { fetchImpl, now, env: { TEMPO_HEADERS: "Authorization=secret-token" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TraceSourceError);
    const message = (err as Error).message;
    expect(message).toContain("401");
    expect(message).toContain("/api/search");
    expect(message).not.toContain("secret-token");
  });

  it("throws a TraceSourceError on a network error", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200" };
    const err = await fetchTempoSpans(cfg, { fetchImpl, now, env: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TraceSourceError);
  });

  it("throws a TraceSourceError when a request times out", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
      });
    }) as typeof fetch;
    const cfg: TempoCfg = { kind: "tempo", url: "http://tempo.local:3200" };
    const err = await fetchTempoSpans(cfg, { fetchImpl, now, env: {}, timeoutMs: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TraceSourceError);
    expect((err as Error).message.toLowerCase()).toContain("timed out");
  });
});
