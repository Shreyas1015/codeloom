import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runIndex } from "../src/commands/index-cmd.js";
import { loadMapState } from "../src/mcp/state.js";
import { progressPath, readProgress, recordCheck } from "../src/store/progress.js";
import { stopKey } from "../src/store/stop-key.js";
import { tourPath, writeTour } from "../src/store/tours.js";
import { API_ROUTES } from "../src/web/api.js";
import { type DashboardServer, startDashboardServer } from "../src/web/server.js";
import { materializeFixture } from "./helpers.js";

// ---- zod schemas mirroring src/web/api-types.ts (strict) -----------------------------------------

const iso = z.string().datetime();
const Commits = z.record(z.string(), z.string());
const CheckRecord = z.strictObject({
  at: iso, questions: z.array(z.string()), answers: z.array(z.string()), verdict: z.enum(["pass", "fail"]), notes: z.string(), commit: Commits,
});
const JourneyProgressView = z.strictObject({
  journeyId: z.string(), name: z.string(), area: z.string(), repos: z.array(z.string()),
  level: z.enum(["none", "seen", "toured", "understood"]), needsReWalk: z.array(z.string()), lastCheck: CheckRecord.nullable(),
  seenAt: iso.optional(), touredAt: iso.optional(), understoodAt: iso.optional(),
});
const LevelCounts = z.strictObject({ total: z.number(), none: z.number(), seen: z.number(), toured: z.number(), understood: z.number(), needsReWalk: z.number() });
const ProgressResponse = z.strictObject({
  workspaceId: z.string().regex(/^[0-9a-f]{16}$/),
  path: z.string(),
  journeys: z.array(JourneyProgressView),
  totals: z.strictObject({ all: LevelCounts, byRepo: z.record(z.string(), LevelCounts), byArea: z.record(z.string(), LevelCounts) }),
  olderJourneys: z.array(z.string()),
});
const TourStop = z.strictObject({ chainId: z.string(), stopIndex: z.number(), key: z.string(), fileHash: z.string(), explanation: z.string() });
const TourFile = z.strictObject({
  version: z.literal(1), journeyId: z.string(), writtenAt: iso, writtenAtCommit: Commits, stops: z.array(TourStop),
  dataJourney: z.strictObject({
    input: z.string(), output: z.string(),
    steps: z.array(z.strictObject({ stopKey: z.string(), sql: z.string().optional(), note: z.string() })),
  }),
  fileNotes: z.array(z.strictObject({ repo: z.string(), file: z.string(), notes: z.array(z.strictObject({ kind: z.enum(["trap", "note"]), text: z.string() })) })),
  check: z.array(z.strictObject({ question: z.string(), expected: z.array(z.string()) })),
});
const TourResponse = z.strictObject({
  journeyId: z.string(), journeyExists: z.boolean(), tour: TourFile.nullable(), staleStops: z.array(z.string()), removedStops: z.array(z.string()),
});
const WriteResponse = z.strictObject({ journey: JourneyProgressView });
const ErrorBody = z.strictObject({ error: z.string(), code: z.enum(["not-indexed", "no-workspace", "bad-data"]).optional() });

// ---- server ---------------------------------------------------------------------------------------

const TOKEN = "c".repeat(64);
const J1 = "j_000000000001"; // has a tour
const J2 = "j_000000000002"; // no tour
const OLD = "j_0000000000ff"; // not in journeys.json

interface Res { status: number; headers: IncomingHttpHeaders; body: unknown }

function request(
  path: string,
  opts: { method?: string; body?: string | Buffer; headers?: Record<string, string>; cookie?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = { host: `127.0.0.1:${server.port}` };
  if (opts.cookie !== null) headers.cookie = `codeloom_session_${server.port}=${opts.cookie ?? TOKEN}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headers);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port, path, method: opts.method ?? "GET", agent: false, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const post = (path: string, body: unknown, opts: Parameters<typeof request>[1] = {}) =>
  request(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), ...opts });

let demo: string;
let server: DashboardServer;
let j1Keys: string[];

/** Every file under `dir` with its content, for "nothing else was written" checks. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string; stops: Parameters<typeof stopKey>[0][] }>;
  const create = chains.find((c) => c.routeKey === "api:POST /api/customers")!;
  const list = chains.find((c) => c.routeKey !== create.routeKey)!;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({
      version: 1,
      journeys: [
        { id: J1, name: "Sign up a customer", area: "customers", note: "", chainIds: [create.id], status: "ok" },
        { id: J2, name: "Another journey", area: "billing", note: "", chainIds: [list.id], status: "ok" },
      ],
    }),
  );
  j1Keys = create.stops.map(stopKey);
  const ws = loadMapState(demo).ws;
  const first = create.stops[0]!;
  const check = [1, 2, 3].map((n) => ({ question: `Question ${n}?`, expected: [`point ${n}`] }));
  writeTour(demo, J1, {
    stops: [
      { chainId: create.id, stopIndex: 0, key: j1Keys[0]!, explanation: "Where the customer starts." },
      // A stop that is not in the journey (same file, a line no stop has): shown as removed.
      { chainId: create.id, stopIndex: 99, key: stopKey({ ...first, line: 99_999 }), explanation: "Gone." },
    ],
    dataJourney: { input: '{"name":"Ada"}', steps: [], output: '{"id":1}' },
    fileNotes: [],
    check,
  }, { ws });
  // A tour for a journey that no longer exists (renamed/merged/split).
  writeTour(demo, OLD, { stops: [], dataJourney: { input: "", steps: [], output: "" }, fileNotes: [], check }, { ws });
  server = await startDashboardServer({ start: demo, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, watch: false });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

function makeAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-dash-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  return dir;
}

describe("GET /api/progress", () => {
  it("lists every journey with its level and totals; the file lives under CODELOOM_HOME, not the workspace", async () => {
    const res = await request("/api/progress");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = ProgressResponse.parse(res.body);
    expect(p.journeys.map((j) => j.journeyId)).toEqual([J1, J2]);
    expect(p.journeys.every((j) => j.level === "none")).toBe(true);
    expect(p.totals.all.total).toBe(2);
    expect(Object.keys(p.totals.byRepo).sort()).toEqual(["api", "billing", "web"]);
    expect(p.path.startsWith(process.env.CODELOOM_HOME!)).toBe(true);
    expect(p.path.startsWith(demo)).toBe(false);
  });
});

describe("GET /api/tours/:journeyId", () => {
  it("a journey with a tour: the tour, no stale stops, and the stops no longer in the journey as removed", async () => {
    const res = await request(`/api/tours/${J1}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const t = TourResponse.parse(res.body);
    expect(t.journeyId).toBe(J1);
    expect(t.journeyExists).toBe(true);
    expect(t.tour!.stops).toHaveLength(2);
    expect(t.staleStops).toEqual([]);
    expect(t.removedStops).toEqual([t.tour!.stops.find((s) => s.stopIndex === 99)!.key]);
  });

  it("a journey with no tour yet → 200 with tour null", async () => {
    const res = await request(`/api/tours/${J2}`);
    expect(res.status).toBe(200);
    expect(TourResponse.parse(res.body)).toEqual({ journeyId: J2, journeyExists: true, tour: null, staleStops: [], removedStops: [] });
  });

  it("a tour for an older journey (no longer in journeys.json) is still served, all its stops removed", async () => {
    const t = TourResponse.parse((await request(`/api/tours/${OLD}`)).body);
    expect(t.journeyExists).toBe(false);
    expect(t.tour?.journeyId).toBe(OLD);
  });

  it("an unknown journey with no tour → 404; a bad id → 400 (never a path outside tours/)", async () => {
    const unknown = await request("/api/tours/j_00000000abcd");
    expect(unknown.status).toBe(404);
    ErrorBody.parse(unknown.body);
    for (const bad of ["nope", "j_1", encodeURIComponent("../journeys"), encodeURIComponent("j_000000000001/../../x")]) {
      const res = await request(`/api/tours/${bad}`);
      expect([400, 404], bad).toContain(res.status);
      ErrorBody.parse(res.body);
    }
    expect((await request("/api/tours/nope")).status).toBe(400);
  });

  it("a corrupt tour file → 409 bad-data", async () => {
    const id = "j_0000000000ee";
    writeFileSync(tourPath(demo, id), "{ not json");
    const res = await request(`/api/tours/${id}`);
    expect(res.status).toBe(409);
    expect(ErrorBody.parse(res.body).code).toBe("bad-data");
  });
});

describe("POST /api/progress/seen", () => {
  it("marks a journey seen and keeps the first time", async () => {
    const a = await post("/api/progress/seen", { journey: J2 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const first = WriteResponse.parse(a.body).journey;
    expect(first.journeyId).toBe(J2);
    expect(first.level).toBe("seen");
    const b = WriteResponse.parse((await post("/api/progress/seen", { journey: J2 })).body).journey;
    expect(b.seenAt).toBe(first.seenAt);
  });

  it("an unknown journey → 404; a bad id → 400; nothing written", async () => {
    const before = existsSync(progressPath(loadMapState(demo).ws)) ? readFileSync(progressPath(loadMapState(demo).ws), "utf8") : null;
    expect((await post("/api/progress/seen", { journey: "j_00000000abcd" })).status).toBe(404);
    expect((await post("/api/progress/seen", { journey: "../../etc" })).status).toBe(400);
    const after = existsSync(progressPath(loadMapState(demo).ws)) ? readFileSync(progressPath(loadMapState(demo).ws), "utf8") : null;
    expect(after).toBe(before);
  });
});

describe("POST /api/progress/toured", () => {
  const ALL = ["flow", "data-journey", "file-notes", "check"];

  it("needs every phase (400), known phases (400) and a tour (404)", async () => {
    expect((await post("/api/progress/toured", { journey: J1, phases: ["flow", "check"] })).status).toBe(400);
    expect((await post("/api/progress/toured", { journey: J1, phases: [...ALL, "understood"] })).status).toBe(400);
    const noTour = await post("/api/progress/toured", { journey: J2, phases: ALL });
    expect(noTour.status).toBe(404);
    expect(ErrorBody.parse(noTour.body).error).toMatch(/no tour/);
  });

  it("all four phases of a journey with a tour → toured", async () => {
    const res = await post("/api/progress/toured", { journey: J1, phases: ALL });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const j = WriteResponse.parse(res.body).journey;
    expect(j.level).toBe("toured");
    expect(j.touredAt).toBeDefined();
    expect(j.understoodAt).toBeUndefined();
  });
});

describe("request bodies", () => {
  it("must be a JSON object with exactly the expected keys (400)", async () => {
    for (const body of ["", "{", "[]", "null", '"j_000000000001"', "{}", JSON.stringify({ journey: 1 }), JSON.stringify({ journey: J1, extra: true })]) {
      const res = await post("/api/progress/seen", body);
      expect(res.status, body).toBe(400);
      ErrorBody.parse(res.body);
    }
    expect((await post("/api/progress/toured", { journey: J1, phases: "flow" })).status).toBe(400);
  });

  it("must be sent as application/json (415)", async () => {
    const res = await post("/api/progress/seen", { journey: J2 }, { headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
    const form = await post("/api/progress/seen", "journey=j_000000000002", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(415);
  });

  it("over 16 KB → 413", async () => {
    const big = JSON.stringify({ journey: J2, pad: "x".repeat(17 * 1024) });
    expect((await post("/api/progress/seen", big)).status).toBe(413);
    // Chunked, with no Content-Length: still cut off at the limit.
    const chunked = await post("/api/progress/seen", big, { headers: { "transfer-encoding": "chunked" } });
    expect(chunked.status).toBe(413);
  });
});

describe("write endpoints: security", () => {
  it("need the session cookie (401), even with a valid body", async () => {
    expect((await post("/api/progress/seen", { journey: J2 }, { cookie: null })).status).toBe(401);
    expect((await post("/api/progress/toured", { journey: J1, phases: ["flow"] }, { cookie: "x".repeat(64) })).status).toBe(401);
  });

  it("refuse another Host (403) and a cross-site Origin (403)", async () => {
    expect((await post("/api/progress/seen", { journey: J2 }, { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await post("/api/progress/seen", { journey: J2 }, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await post("/api/progress/seen", { journey: J2 }, { headers: { origin: `http://127.0.0.1:${server.port + 1}` } })).status).toBe(403);
    expect((await post("/api/progress/seen", { journey: J2 }, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const same = await post("/api/progress/seen", { journey: J2 }, { headers: { origin: `http://localhost:${server.port}`, "sec-fetch-site": "same-origin" } });
    expect(same.status).toBe(200);
  });

  it("answer with the security headers", async () => {
    const res = await post("/api/progress/seen", { journey: J2 });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("are the only POST routes; GET on them → 405 (Allow: POST); every other method → 405", async () => {
    const posts = API_ROUTES.filter((r) => r.method === "POST").map((r) => r.path).sort();
    expect(posts).toEqual(["/api/progress/seen", "/api/progress/toured"]);
    for (const p of posts) {
      const res = await request(p);
      expect(res.status, p).toBe(405);
      expect(res.headers.allow).toBe("POST");
    }
    for (const p of ["/api/progress", `/api/tours/${J1}`]) {
      const res = await post(p, { journey: J1 });
      expect(res.status, p).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    }
    for (const m of ["PUT", "DELETE", "PATCH"]) {
      for (const p of ["/api/progress/seen", "/api/progress/toured", "/api/progress", `/api/tours/${J1}`]) {
        expect((await request(p, { method: m, body: JSON.stringify({ journey: J1 }) })).status, `${m} ${p}`).toBe(405);
      }
    }
    // POST outside /api (static files, the SPA) is refused too.
    expect((await post("/", { journey: J1 })).status).toBe(405);
    expect((await post("/api/progress/check", { journey: J1, verdict: "pass" })).status).toBe(404);
  });

  it("can never set understood, and never write journeys, chains or tours", async () => {
    const before = snapshot(join(demo, ".codeloom"));
    const tries: Array<[string, unknown]> = [
      ["/api/progress/seen", { journey: J1, understood: true }],
      ["/api/progress/seen", { journey: J1, understoodAt: "2026-01-01T00:00:00.000Z" }],
      ["/api/progress/seen", { journey: J1, verdict: "pass" }],
      ["/api/progress/toured", { journey: J1, phases: ["flow", "data-journey", "file-notes", "check"], level: "understood" }],
      ["/api/progress/toured", { journey: J1, phases: ["flow", "data-journey", "file-notes", "check", "understood"] }],
      ["/api/progress/toured", { journey: J1, phases: ["flow", "data-journey", "file-notes", "check"], stopHashes: {} }],
    ];
    for (const [p, body] of tries) expect((await post(p, body)).status, JSON.stringify(body)).toBe(400);
    // The valid writes, too, leave understood alone.
    await post("/api/progress/seen", { journey: J1 });
    await post("/api/progress/toured", { journey: J1, phases: ["flow", "data-journey", "file-notes", "check"] });
    const file = readProgress(loadMapState(demo).ws);
    for (const j of Object.values(file.journeys)) {
      expect(j.understoodAt).toBeUndefined();
      expect(j.stopHashes).toBeUndefined();
      expect(j.checks).toEqual([]);
    }
    expect(snapshot(join(demo, ".codeloom"))).toEqual(before);
  });
});

describe("after a passed check (record_check)", () => {
  it("progress shows understood; editing a stop's file → needs re-walk and the tour stop goes stale", async () => {
    const state = loadMapState(demo);
    recordCheck(state, J1, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "" });
    let p = ProgressResponse.parse((await request("/api/progress")).body);
    expect(p.journeys.find((j) => j.journeyId === J1)!.level).toBe("understood");
    expect(p.journeys.find((j) => j.journeyId === J1)!.lastCheck?.verdict).toBe("pass");

    const [, repo, file] = JSON.parse(j1Keys[0]!) as [string, string, string];
    appendFileSync(join(demo, repo, file), "\n// changed\n");
    p = ProgressResponse.parse((await request("/api/progress")).body);
    const j1 = p.journeys.find((j) => j.journeyId === J1)!;
    expect(j1.level).toBe("understood");
    expect(j1.needsReWalk).toContain(j1Keys[0]);
    const t = TourResponse.parse((await request(`/api/tours/${J1}`)).body);
    expect(t.staleStops).toContain(j1Keys[0]);
  });
});
