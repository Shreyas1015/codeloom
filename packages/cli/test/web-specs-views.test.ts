// v0.3 Task 3: the dashboard's read-only spec, view and doc endpoints, on demo-shop (Customer / Invoice).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runIndex } from "../src/commands/index-cmd.js";
import { type DashboardServer, startDashboardServer } from "../src/web/server.js";
import { commitTicketHistory, makeRepo, materializeFixture } from "./helpers.js";

const TOKEN = "c".repeat(64);
const SIGNUP = "j_00000000c0de";
const PAY = "j_0000000000aa";
const GONE = "j_00000000dead";

// ---- zod schemas mirroring src/web/api-types.ts (strict: an extra or missing key fails) ---------

const specState = z.enum(["linked", "candidates", "none"]);
const SpecLink = z.strictObject({ kind: z.enum(["doc", "ticket"]), ref: z.string(), reason: z.string(), savedAt: z.string() });
const Coverage = z.strictObject({ total: z.number(), linked: z.number(), candidates: z.number(), none: z.number(), checked: z.number() });
const SpecsResponse = z.strictObject({
  journeys: z.array(z.strictObject({
    journeyId: z.string(), name: z.string(), area: z.string(), repos: z.array(z.string()), state: specState, checked: z.boolean(),
    checkedAt: z.string().optional(), links: z.array(SpecLink),
    candidates: z.strictObject({ docs: z.number(), tickets: z.number() }),
  })),
  totals: z.strictObject({ all: Coverage, byRepo: z.record(z.string(), Coverage), byArea: z.record(z.string(), Coverage) }),
  olderJourneys: z.array(z.strictObject({ journeyId: z.string(), checkedAt: z.string(), links: z.array(SpecLink) })),
  candidatesIndexed: z.boolean(),
});
const DocCandidate = z.strictObject({
  ref: z.string(), repo: z.string(), file: z.string(), score: z.number(), count: z.number(),
  evidence: z.array(z.strictObject({ kind: z.enum(["route", "page", "table", "queue", "symbol"]), term: z.string(), file: z.string(), line: z.number() })),
});
const TicketCandidate = z.strictObject({
  ref: z.string(), score: z.number(), count: z.number(),
  evidence: z.array(z.strictObject({ repo: z.string(), commit: z.string(), file: z.string(), subject: z.string() })),
});
const JourneySpecsResponse = z.strictObject({
  journeyId: z.string(),
  journeyExists: z.boolean(),
  journey: z.strictObject({ id: z.string(), name: z.string(), area: z.string() }).nullable(),
  state: specState,
  checked: z.boolean(),
  checkedAt: z.string().nullable(),
  links: z.array(SpecLink),
  candidates: z.strictObject({ docs: z.array(DocCandidate), tickets: z.array(TicketCandidate) }),
  candidatesIndexed: z.boolean(),
});
const ViewsResponse = z.strictObject({
  views: z.array(z.union([
    z.strictObject({ id: z.string(), url: z.string(), title: z.string(), description: z.string().optional(), widgets: z.number() }),
    z.strictObject({ id: z.string(), url: z.string(), error: z.string() }),
  ])),
});
const ViewResponse = z.strictObject({
  id: z.string(),
  url: z.string(),
  view: z.strictObject({
    version: z.literal(1), id: z.string(), title: z.string(), description: z.string().optional(),
    widgets: z.array(z.looseObject({ type: z.string() })),
  }).nullable(),
  error: z.string().optional(),
});
const DocResponse = z.strictObject({ repo: z.string(), file: z.string(), text: z.string(), lines: z.number(), bytes: z.number() });
const ErrorBody = z.strictObject({ error: z.string(), code: z.enum(["not-indexed", "no-workspace", "bad-data"]).optional() });

// ---- server -------------------------------------------------------------------------------------

function makeAssetsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "codeloom-dash-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  return dir;
}

function request(s: DashboardServer, path: string, method = "GET"): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: s.port, path, method, agent: false, headers: { host: `127.0.0.1:${s.port}`, cookie: `codeloom_session_${s.port}=${TOKEN}` } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let demo: string;
let server: DashboardServer;
const ok = async <T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> => {
  const res = await request(server, path);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return schema.parse(res.body);
};
const fail = async (path: string, status: number) => {
  const res = await request(server, path);
  expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(status);
  return ErrorBody.parse(res.body);
};

const SAVED = "2026-11-08T10:00:00.000Z";
const view = (id: string, extra: Record<string, unknown> = {}) => ({
  version: 1, id, title: `View ${id}`, widgets: [{ type: "specCoverage", by: "area" }, { type: "note", markdown: "Hello" }], ...extra,
});
const writeView = (id: string, body: unknown) => {
  mkdirSync(join(demo, ".codeloom", "views"), { recursive: true });
  writeFileSync(join(demo, ".codeloom", "views", `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
};

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  commitTicketHistory(demo);
  await runIndex(demo);
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string }>;
  const signup = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  const pay = chains.find((c) => c.routeKey === "billing:POST /billing/invoices/:id/pay")!.id;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({
      version: 1,
      journeys: [
        { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [signup], status: "ok" },
        { id: PAY, name: "Pay an invoice", area: "billing", note: "", chainIds: [pay], status: "ok" },
      ],
    }),
  );
  // Re-index so spec-candidates.json covers the journeys just named.
  await runIndex(demo);
  writeFileSync(
    join(demo, ".codeloom", "specs.json"),
    JSON.stringify({
      version: 1,
      journeys: {
        [PAY]: { links: [], checkedAt: SAVED },
        [GONE]: { links: [{ kind: "ticket", ref: "SHOP-9", reason: "old sign-up", savedAt: SAVED }], checkedAt: SAVED },
      },
    }),
  );
  server = await startDashboardServer({ start: demo, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, watch: false });
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe("GET /api/specs", () => {
  it("lists every journey's spec state, links and candidate counts, totals and older journeys", async () => {
    const s = await ok("/api/specs", SpecsResponse);
    expect(s.candidatesIndexed).toBe(true);
    expect(s.journeys.map((j) => j.journeyId)).toEqual([PAY, SIGNUP]);
    const signup = s.journeys.find((j) => j.journeyId === SIGNUP)!;
    expect(signup).toMatchObject({ name: "Sign up a customer", area: "customers", state: "candidates", checked: false, links: [] });
    expect(signup.candidates.docs).toBeGreaterThan(0);
    expect(signup.candidates.tickets).toBeGreaterThan(0);
    expect(s.journeys.find((j) => j.journeyId === PAY)).toMatchObject({ state: "none", checked: true, checkedAt: SAVED });
    expect(s.totals.all).toEqual({ total: 2, linked: 0, candidates: 1, none: 1, checked: 1 });
    expect(s.olderJourneys).toEqual([{ journeyId: GONE, checkedAt: SAVED, links: [{ kind: "ticket", ref: "SHOP-9", reason: "old sign-up", savedAt: SAVED }] }]);
  });

  it("filters by repo and area; an unknown repo → 404", async () => {
    const billing = await ok("/api/specs?repo=billing", SpecsResponse);
    expect(billing.journeys.map((j) => j.journeyId)).toEqual([PAY]);
    const customers = await ok("/api/specs?area=customers", SpecsResponse);
    expect(customers.journeys.map((j) => j.journeyId)).toEqual([SIGNUP]);
    await fail("/api/specs?repo=nope", 404);
  });
});

describe("GET /api/specs/:journeyId", () => {
  it("a journey's full candidates (docs with repo and file) and links", async () => {
    const j = await ok(`/api/specs/${SIGNUP}`, JourneySpecsResponse);
    expect(j).toMatchObject({ journeyId: SIGNUP, journeyExists: true, journey: { id: SIGNUP, name: "Sign up a customer", area: "customers" }, state: "candidates", checked: false, checkedAt: null, links: [], candidatesIndexed: true });
    const doc = j.candidates.docs.find((d) => d.ref === "api:docs/customers.md")!;
    expect(doc).toMatchObject({ repo: "api", file: "docs/customers.md" });
    expect(doc.evidence.some((e) => e.kind === "route")).toBe(true);
    expect(j.candidates.tickets.map((t) => t.ref)).toEqual(expect.arrayContaining(["SHOP-12", "SHOP-13", "SHOP-14"]));
    expect(j.candidates.tickets[0]!.evidence[0]!.repo).toBe("api");
  });

  it("a checked journey with no links; an older journey (renamed or merged) still shows its links", async () => {
    expect(await ok(`/api/specs/${PAY}`, JourneySpecsResponse)).toMatchObject({ state: "none", checked: true, checkedAt: SAVED, journeyExists: true });
    const old = await ok(`/api/specs/${GONE}`, JourneySpecsResponse);
    expect(old).toMatchObject({ journeyId: GONE, journeyExists: false, journey: null, state: "linked", checked: true, candidates: { docs: [], tickets: [] } });
    expect(old.links.map((l) => l.ref)).toEqual(["SHOP-9"]);
  });

  it("an unknown journey → 404; a malformed id → 400", async () => {
    await fail("/api/specs/j_ffffffffffff", 404);
    await fail("/api/specs/nope", 400);
  });

  it("no candidates file yet → candidatesIndexed false, empty candidates", async () => {
    const file = join(demo, ".codeloom", "spec-candidates.json");
    const saved = readFileSync(file, "utf8");
    rmSync(file);
    try {
      const j = await ok(`/api/specs/${SIGNUP}`, JourneySpecsResponse);
      expect(j).toMatchObject({ candidatesIndexed: false, state: "none", candidates: { docs: [], tickets: [] } });
      expect((await ok("/api/specs", SpecsResponse)).candidatesIndexed).toBe(false);
    } finally {
      writeFileSync(file, saved);
    }
  });

  it("a broken specs.json → 409 bad-data (a local error, never a crash)", async () => {
    const file = join(demo, ".codeloom", "specs.json");
    const saved = readFileSync(file, "utf8");
    writeFileSync(file, "{ not json");
    try {
      expect((await fail("/api/specs", 409)).code).toBe("bad-data");
      expect((await fail(`/api/specs/${SIGNUP}`, 409)).code).toBe("bad-data");
    } finally {
      writeFileSync(file, saved);
    }
  });
});

describe("GET /api/views and /api/views/:id", () => {
  beforeAll(() => {
    writeView("audit", view("audit", { description: "No-spec audit" }));
    writeView("broken", "{ nope");
    writeView("bad-widget", view("bad-widget", { widgets: [{ type: "chart", query: "x" }] }));
    writeView("wrong-id", view("other"));
  });

  it("lists every view (title, widget count, url) or its error, sorted by id", async () => {
    const v = await ok("/api/views", ViewsResponse);
    expect(v.views.map((x) => x.id)).toEqual(["audit", "bad-widget", "broken", "wrong-id"]);
    expect(v.views[0]).toEqual({ id: "audit", url: "/views/audit", title: "View audit", description: "No-spec audit", widgets: 2 });
    expect(v.views[1]).toMatchObject({ id: "bad-widget", url: "/views/bad-widget", error: expect.any(String) });
    expect(v.views[2]).toMatchObject({ id: "broken", error: expect.any(String) });
    expect(v.views[3]).toMatchObject({ id: "wrong-id", error: expect.stringMatching(/"other"/) });
  });

  it("one valid view", async () => {
    const v = await ok("/api/views/audit", ViewResponse);
    expect(v).toEqual({ id: "audit", url: "/views/audit", view: view("audit", { description: "No-spec audit" }) });
  });

  it("an invalid view → 200 with { error } (the UI shows an error card), never 409/500", async () => {
    for (const id of ["broken", "bad-widget", "wrong-id"]) {
      const v = await ok(`/api/views/${id}`, ViewResponse);
      expect(v.view, id).toBeNull();
      expect(v.error, id).toMatch(/codeloom doctor/);
    }
  });

  it("home: missing → 200 view null with no error (the built-in Home); valid → the view; broken → { error }", async () => {
    expect(await ok("/api/views/home", ViewResponse)).toEqual({ id: "home", url: "/", view: null });
    writeView("home", view("home"));
    expect((await ok("/api/views/home", ViewResponse)).view?.id).toBe("home");
    writeView("home", "[]");
    const broken = await ok("/api/views/home", ViewResponse);
    expect(broken.view).toBeNull();
    expect(broken.error).toMatch(/codeloom doctor/);
    rmSync(join(demo, ".codeloom", "views", "home.json"));
  });

  it("an unknown view → 404; a malformed id → 400", async () => {
    await fail("/api/views/nope", 404);
    await fail("/api/views/Bad_Id", 400);
    await fail(`/api/views/${encodeURIComponent("../specs")}`, 400);
  });

  it("no views folder → an empty list", async () => {
    const dir = join(demo, ".codeloom", "views");
    const moved = join(demo, ".codeloom", "views-away");
    const { renameSync } = await import("node:fs");
    renameSync(dir, moved);
    try {
      expect(await ok("/api/views", ViewsResponse)).toEqual({ views: [] });
    } finally {
      renameSync(moved, dir);
    }
  });
});

describe("GET /api/docs", () => {
  it("returns a doc's whole text", async () => {
    const d = await ok("/api/docs?repo=api&file=docs/customers.md", DocResponse);
    const text = readFileSync(join(demo, "api", "docs", "customers.md"), "utf8");
    expect(d).toEqual({ repo: "api", file: "docs/customers.md", text, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes: Buffer.byteLength(text) });
  });

  it("is path-safe like /api/code: outside, absolute, symlinks out, git, .env and .codeloom refused; missing → 404", async () => {
    await fail("/api/docs?repo=api&file=../billing/package.json", 400);
    await fail(`/api/docs?repo=api&file=${encodeURIComponent("/etc/passwd")}`, 400);
    await fail("/api/docs?repo=api&file=..%2F..%2F..%2Fetc%2Fpasswd", 400);
    const outside = mkdtempSync(join(tmpdir(), "codeloom-outside-"));
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(join(outside, "secret.md"), join(demo, "api", "docs", "link.md"));
    await fail("/api/docs?repo=api&file=docs/link.md", 400);
    writeFileSync(join(demo, "api", ".env"), "SECRET=1\n");
    await fail("/api/docs?repo=api&file=.env", 400);
    await fail("/api/docs?repo=api&file=.git/config", 400);
    await fail("/api/docs?repo=api&file=.codeloom/graph.json", 400);
    await fail("/api/docs?repo=api&file=docs/nope.md", 404);
    await fail("/api/docs?repo=nope&file=docs/customers.md", 404);
    await fail("/api/docs?repo=api", 400);
    await fail("/api/docs?file=docs/customers.md", 400);
    await fail("/api/docs?repo=api&file=docs", 400);
  });

  it("refuses .env, .git and .codeloom in any letter case on /api/docs and /api/code (final review §2)", async () => {
    const api = join(demo, "api");
    writeFileSync(join(api, ".env"), "SECRET=1\n");
    writeFileSync(join(api, ".env.local"), "SECRET=2\n");
    mkdirSync(join(api, ".git"), { recursive: true });
    writeFileSync(join(api, ".git", "config"), "[core]\n");
    for (const file of [".ENV", ".Env.local", ".GIT/config", ".CODELOOM/graph.json"]) {
      for (const ep of ["/api/docs", "/api/code"]) await fail(`${ep}?repo=api&file=${encodeURIComponent(file)}`, 400);
    }
    // on a case-insensitive file system these names really open the hidden files; the check still refuses
    let insensitive = false;
    try {
      insensitive = readFileSync(join(api, ".ENV"), "utf8") === "SECRET=1\n";
    } catch {
      insensitive = false;
    }
    if (insensitive) for (const ep of ["/api/docs", "/api/code"]) expect(JSON.stringify((await request(server, `${ep}?repo=api&file=.ENV`)).body)).not.toMatch(/SECRET/);
  });

  it("refuses a doc over 512 KB and a binary file", async () => {
    writeFileSync(join(demo, "api", "docs", "big.md"), "x".repeat(512 * 1024 + 1));
    await fail("/api/docs?repo=api&file=docs/big.md", 400);
    writeFileSync(join(demo, "api", "docs", "bin.txt"), Buffer.from([0x61, 0x00, 0x62]));
    await fail("/api/docs?repo=api&file=docs/bin.txt", 400);
  });
});

describe("the new endpoints are read-only", () => {
  it("POST, PUT, DELETE → 405", async () => {
    for (const p of ["/api/specs", `/api/specs/${SIGNUP}`, "/api/views", "/api/views/audit", "/api/docs?repo=api&file=docs/customers.md"]) {
      for (const m of ["POST", "PUT", "DELETE"]) expect((await request(server, p, m)).status, `${m} ${p}`).toBe(405);
    }
  });
});

describe("/api/docs in a single-repo workspace (the repo is the workspace root)", () => {
  let single: DashboardServer;

  beforeAll(async () => {
    const root = makeRepo({ "README.md": "# app\n" });
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "single", repos: [{ id: "app", path: "." }], links: [] }));
    mkdirSync(join(root, ".codeloom", "tours"), { recursive: true });
    writeFileSync(join(root, ".codeloom", "tours", `${SIGNUP}.json`), JSON.stringify({ check: [{ question: "q", expected: ["the secret answer"] }] }));
    single = await startDashboardServer({ start: root, port: 0, assetsDir: makeAssetsDir(), token: TOKEN, watch: false });
  }, 60_000);

  afterAll(async () => {
    await single?.close();
  });

  it("never serves .codeloom files (tours hold the check's expected points)", async () => {
    for (const file of [`.codeloom/tours/${SIGNUP}.json`, `docs/../.codeloom/tours/${SIGNUP}.json`, ".codeloom/specs.json"]) {
      const res = await request(single, `/api/docs?repo=app&file=${encodeURIComponent(file)}`);
      expect(res.status, file).toBe(400);
      expect(ErrorBody.parse(res.body).error, file).toMatch(/\.codeloom/);
    }
    expect((await request(single, "/api/docs?repo=app&file=README.md")).status).toBe(200);
  });
});
