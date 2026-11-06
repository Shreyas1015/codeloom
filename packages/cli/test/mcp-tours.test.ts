// v0.2b Task 2: the tour and progress MCP tools (build_tour_context, save_tour, get_progress,
// record_check) and the write-tour / check-me prompts, on demo-shop (Customer / Invoice).
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { createServer } from "../src/mcp/server.js";
import { loadMapState } from "../src/mcp/state.js";
import { progressPath, readProgress } from "../src/store/progress.js";
import { stopKey } from "../src/store/stop-key.js";
import { readTour, tourPath } from "../src/store/tours.js";
import { materializeFixture } from "./helpers.js";

const SIGNUP = "j_00000000c0de";
const PAY = "j_0000000000aa";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

let demo: string;
let client: Client;
let signupChainId: string;
let payChainId: string;

beforeEach(() => {
  process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));
});

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string }>;
  signupChainId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  payChainId = chains.find((c) => c.routeKey === "billing:POST /billing/invoices/:id/pay")!.id;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({
      version: 1,
      journeys: [
        { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [signupChainId], status: "ok" },
        { id: PAY, name: "Pay an invoice", area: "billing", note: "", chainIds: [payChainId], status: "ok" },
      ],
    }),
  );
  const server = createServer({ start: demo });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: "tours", version: "0.0.0" });
  await client.connect(c);
}, 120_000);

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent;
}
async function err(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  expect(r.isError, `${name} should fail`).toBe(true);
  const item = r.content[0];
  return item?.type === "text" ? item.text : "";
}

function signupStops() {
  const state = loadMapState(demo);
  return state.chains.find((c) => c.id === signupChainId)!.stops;
}

function draft(): Record<string, unknown> {
  const stops = signupStops();
  return {
    stops: stops.map((s, i) => ({ chainId: signupChainId, stopIndex: i, key: stopKey(s), explanation: `Stop ${i}: ${s.symbol}` })),
    dataJourney: {
      input: '{ "name": "Ada", "email": "ada@example.com", "city": "Pune" }',
      steps: stops.map((s) => ({ stopKey: stopKey(s), note: `goes through ${s.symbol}` })),
      output: '{ "id": 1, "name": "Ada" }',
    },
    fileNotes: [{ repo: "api", file: "app/services/customer_service.ts", notes: [{ kind: "trap", text: "Also writes an audit log row." }] }],
    check: [
      { question: "Where is the customer saved?", expected: ["Customer.create in CustomerService"] },
      { question: "What else is written?", expected: ["an audit_logs row"] },
      { question: "What does the API return?", expected: ["201 with the customer"] },
    ],
  };
}

const answers3 = { questions: ["q1", "q2", "q3"], answers: ["a1", "a2", "a3"], notes: "judged against the code" };

// ---- build_tour_context ----------------------------------------------------------------------------

describe("build_tour_context", { timeout: 60_000 }, () => {
  it("gives every journey stop its code (± 30 lines), current file hash, and neighbors", async () => {
    const r = await ok("build_tour_context", { journey: SIGNUP });
    expect(r.journey).toMatchObject({ id: SIGNUP, name: "Sign up a customer", area: "customers" });
    expect(r.chains.map((c: { id: string }) => c.id)).toEqual([signupChainId]);
    const stops = signupStops();
    expect(r.stops).toHaveLength(stops.length);
    for (const [i, s] of stops.entries()) {
      const v = r.stops[i];
      expect(v).toMatchObject({ chainId: signupChainId, stopIndex: i, key: stopKey(s), lane: s.lane, repo: s.repo, file: s.file, line: s.line });
      const bytes = readFileSync(join(demo, s.repo, s.file));
      expect(v.fileHash).toBe(sha256(bytes));
      const lines = bytes.toString("utf8").split("\n");
      expect(v.code.startLine).toBe(Math.max(1, s.line - 30));
      expect(v.code.endLine).toBeLessThanOrEqual(s.line + 30);
      expect(v.code.text.split("\n")[s.line - v.code.startLine]).toBe(lines[s.line - 1]);
    }
    // the controller method stop has resolved method-call neighbors (v0.2a)
    const store = r.stops.find((v: { symbol: string; lane: string }) => v.symbol === "CustomersController.store" && v.lane === "code");
    expect(store.neighbors.some((n: { ref: string }) => n.ref.includes("CustomerService.create"))).toBe(true);
    expect(r.files.every((f: { fileHash: string | null }) => typeof f.fileHash === "string")).toBe(true);
    expect(r.tour).toBeNull();
  });

  it("db stops carry the table, op and how it is accessed; types and request shapes come from the code", async () => {
    const r = await ok("build_tour_context", { journey: SIGNUP });
    const db = r.stops.filter((v: { lane: string }) => v.lane === "db");
    expect(db.length).toBeGreaterThan(0);
    const customers = db.find((v: { db?: { table?: string } }) => v.db?.table === "customers");
    expect(customers.db).toMatchObject({ op: "insert", via: "lucid" });
    expect(customers.db.statement).toMatch(/Customer\.create/);
    expect(customers.db.tableDef).toMatchObject({ file: expect.stringContaining("create_customers_table") });
    expect(customers.db.tableDef.text).toMatch(/createTable|email/);
    // the Customer model class the service uses is found in the repo
    const service = r.stops.find((v: { symbol: string; lane: string }) => v.symbol === "CustomerService.create" && v.lane === "code");
    const customerType = service.types.find((t: { name: string }) => t.name === "Customer");
    expect(customerType).toMatchObject({ file: "app/models/customer.ts" });
    expect(customerType.text).toMatch(/class Customer/);
    // the controller's body cast is a request shape; response.created is a response shape
    const store = r.stops.find((v: { symbol: string; lane: string }) => v.symbol === "CustomersController.store" && v.lane === "code");
    expect(store.shapes.some((s: { kind: string; text: string }) => s.kind === "request" && /request\.body\(\) as \{ name: string/.test(s.text))).toBe(true);
    expect(store.shapes.some((s: { kind: string; text: string }) => s.kind === "response" && /response\.created/.test(s.text))).toBe(true);
    // an imported framework type is named with where it comes from
    expect(store.types).toContainEqual({ name: "HttpContext", from: "@adonisjs/core/http" });
    // the class the stop sits in is not listed as a type it uses
    expect(store.types.map((t: { name: string }) => t.name)).not.toContain("CustomersController");
  });

  it("a stop shared by several chains gets its context once", async () => {
    const r = await ok("build_tour_context", { journey: SIGNUP });
    const keys = r.stops.filter((v: { sameAs?: unknown }) => v.sameAs === undefined).map((v: { key: string }) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("errors on a bad or unknown journey id and on a chain outside the journey", async () => {
    expect(await err("build_tour_context", { journey: "j_000000000000" })).toMatch(/Unknown journey/);
    expect(await err("build_tour_context", { journey: "nope" })).toMatch(/journey id/);
    expect(await err("build_tour_context", { journey: SIGNUP, chain: payChainId })).toMatch(/not one of/);
  });
});

// ---- save_tour -------------------------------------------------------------------------------------

describe("save_tour", { timeout: 60_000 }, () => {
  it("writes the tour with hashes codeloom computed, ignoring any the agent sends", async () => {
    const d = draft();
    (d.stops as Array<Record<string, unknown>>)[0]!.fileHash = "0".repeat(64);
    const r = await ok("save_tour", { journey: SIGNUP, tour: { ...d, writtenAtCommit: { api: "deadbeef" } } });
    expect(r).toMatchObject({ journeyId: SIGNUP, path: ".codeloom/tours/j_00000000c0de.json", stops: signupStops().length, uncoveredStops: [] });
    const tour = readTour(demo, SIGNUP)!;
    const s0 = signupStops()[0]!;
    expect(tour.stops[0]!.fileHash).toBe(sha256(readFileSync(join(demo, s0.repo, s0.file))));
    expect(tour.writtenAtCommit.api).not.toBe("deadbeef");
    // the tour then shows up in build_tour_context
    const ctx = await ok("build_tour_context", { journey: SIGNUP });
    expect(ctx.tour).toMatchObject({ staleStops: [], removedStops: [] });
    // check-me reads the questions with their expected points from here (the dashboard never gets them).
    expect(ctx.tour.check).toEqual((d.check as unknown[]));
  });

  it("lists the journey stops the tour leaves out", async () => {
    const d = draft();
    d.stops = (d.stops as unknown[]).slice(0, 1);
    const r = await ok("save_tour", { journey: SIGNUP, tour: d });
    expect(r.uncoveredStops).toHaveLength(signupStops().length - 1);
  });

  it("rejects stops, steps and files that are not in the journey, and writes nothing", async () => {
    const path = tourPath(demo, PAY);
    const payStops = loadMapState(demo).chains.find((c) => c.id === payChainId)!.stops;
    const before = existsSync(path);
    const bad = async (tour: Record<string, unknown>, msg: RegExp) => {
      expect(await err("save_tour", { journey: PAY, tour })).toMatch(msg);
      expect(existsSync(path)).toBe(before);
    };
    // signup's stops sent for the pay journey
    await bad(draft(), /not one of the journey's chains/);
    const payDraft = () => {
      const d = draft();
      d.stops = payStops.map((s, i) => ({ chainId: payChainId, stopIndex: i, key: stopKey(s), explanation: "x" }));
      d.dataJourney = { input: "{}", steps: [{ stopKey: stopKey(payStops[0]!), note: "n" }], output: "{}" };
      d.fileNotes = [{ repo: "billing", file: "src/invoices.ts", notes: [{ kind: "note", text: "n" }] }];
      return d;
    };
    expect((await ok("save_tour", { journey: PAY, tour: payDraft() })).journeyId).toBe(PAY);
    const tourBefore = readFileSync(path, "utf8");
    const again = async (tour: Record<string, unknown>, msg: RegExp) => {
      expect(await err("save_tour", { journey: PAY, tour })).toMatch(msg);
      expect(readFileSync(path, "utf8")).toBe(tourBefore);
    };
    let d = payDraft();
    (d.stops as Array<{ stopIndex: number }>)[0]!.stopIndex = 999;
    await again(d, /stop 999/);
    d = payDraft();
    (d.stops as Array<{ key: string }>)[0]!.key = stopKey({ ...payStops[0]!, line: payStops[0]!.line + 1 });
    await again(d, /does not match/);
    d = payDraft();
    d.stops = [...(d.stops as unknown[]), (d.stops as unknown[])[0]];
    await again(d, /twice/);
    d = payDraft();
    d.stops = [];
    await again(d, /at least one stop/);
    d = payDraft();
    (d.dataJourney as { steps: Array<{ stopKey: string }> }).steps[0]!.stopKey = stopKey(signupStops()[0]!);
    await again(d, /dataJourney\.steps\.0/);
    d = payDraft();
    d.fileNotes = [{ repo: "nope", file: "x.ts", notes: [] }];
    await again(d, /Unknown repo "nope"/);
    d = payDraft();
    d.fileNotes = [{ repo: "billing", file: "src/ghost.ts", notes: [] }];
    await again(d, /src\/ghost\.ts/);
    d = payDraft();
    d.fileNotes = [{ repo: "billing", file: "../api/app/models/customer.ts", notes: [] }];
    await again(d, /outside/);
    d = payDraft();
    d.check = (d.check as unknown[]).slice(0, 2);
    await again(d, /check/);
    expect(await err("save_tour", { journey: "j_000000000000", tour: payDraft() })).toMatch(/Unknown journey/);
  });

  it("never sets progress", async () => {
    await ok("save_tour", { journey: SIGNUP, tour: draft() });
    expect(existsSync(progressPath(loadMapState(demo).ws))).toBe(false);
  });
});

// ---- record_check and get_progress ------------------------------------------------------------------

describe("record_check and get_progress", { timeout: 60_000 }, () => {
  it("starts with every journey at none", async () => {
    const r = await ok("get_progress", {});
    expect(r.journeys.map((j: { journeyId: string; level: string }) => [j.journeyId, j.level])).toEqual([[PAY, "none"], [SIGNUP, "none"]]);
    expect(r.totals.all).toMatchObject({ total: 2, none: 2, understood: 0 });
    expect(r.left.map((j: { journeyId: string }) => j.journeyId)).toEqual([PAY, SIGNUP]);
  });

  it("a fail is recorded but never sets understood; a pass does", async () => {
    const f = await ok("record_check", { journey: SIGNUP, ...answers3, verdict: "fail" });
    expect(f).toMatchObject({ journeyId: SIGNUP, verdict: "fail", understood: false, checks: 1 });
    let p = await ok("get_progress", {});
    expect(p.journeys.find((j: { journeyId: string }) => j.journeyId === SIGNUP)).toMatchObject({ level: "none", lastCheck: { verdict: "fail" } });

    const pass = await ok("record_check", { journey: SIGNUP, ...answers3, verdict: "pass" });
    expect(pass).toMatchObject({ verdict: "pass", understood: true, checks: 2 });
    p = await ok("get_progress", {});
    const j = p.journeys.find((x: { journeyId: string }) => x.journeyId === SIGNUP);
    expect(j).toMatchObject({ level: "understood", needsReWalk: [] });
    expect(p.totals.all).toMatchObject({ understood: 1, none: 1 });
    expect(p.totals.byArea.customers).toMatchObject({ total: 1, understood: 1 });
    expect(p.left.map((x: { journeyId: string }) => x.journeyId)).toEqual([PAY]);
    // codeloom computed the hashes
    const saved = readProgress(loadMapState(demo).ws).journeys[SIGNUP]!;
    const s0 = signupStops()[0]!;
    expect(saved.stopHashes![stopKey(s0)]).toBe(sha256(readFileSync(join(demo, s0.repo, s0.file))));
  });

  it("refuses a pass on fewer than 3 answered questions, mismatched answers, or extra agent fields", async () => {
    expect(await err("record_check", { journey: SIGNUP, questions: ["q"], answers: ["a"], verdict: "pass", notes: "" })).toMatch(/3 questions/);
    expect(await err("record_check", { journey: SIGNUP, questions: ["q1", "q2", "q3"], answers: ["a1"], verdict: "fail", notes: "" })).toMatch(/answer for each question/);
    expect(await err("record_check", { journey: SIGNUP, questions: [], answers: [], verdict: "fail", notes: "" })).toMatch(/questions/);
    expect(await err("record_check", { journey: SIGNUP, ...answers3, verdict: "maybe" })).toMatch(/verdict/);
    expect(await err("record_check", { journey: "j_000000000000", ...answers3, verdict: "pass" })).toMatch(/Unknown journey/);
    expect(existsSync(progressPath(loadMapState(demo).ws))).toBe(false);
    // agent-sent hashes / timestamps are not part of the input and are never stored
    await ok("record_check", { journey: SIGNUP, ...answers3, verdict: "pass", stopHashes: { x: "y" }, understoodAt: "2000-01-01T00:00:00.000Z" });
    const saved = readProgress(loadMapState(demo).ws).journeys[SIGNUP]!;
    expect(saved.understoodAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(saved.stopHashes!.x).toBeUndefined();
  });

  it("filters by repo and area; an unknown repo is an error", async () => {
    await ok("record_check", { journey: PAY, ...answers3, verdict: "pass" });
    const billing = await ok("get_progress", { repo: "billing" });
    expect(billing.journeys.map((j: { journeyId: string }) => j.journeyId)).toEqual([PAY]);
    expect(Object.keys(billing.totals.byRepo)).toEqual(["billing"]);
    expect(billing.totals.all).toMatchObject({ total: 1, understood: 1 });
    const customers = await ok("get_progress", { area: "customers" });
    expect(customers.journeys.map((j: { journeyId: string }) => j.journeyId)).toEqual([SIGNUP]);
    expect(Object.keys(customers.totals.byArea)).toEqual(["customers"]);
    expect(await err("get_progress", { repo: "nope" })).toMatch(/Unknown repo/);
  });

  it("only record_check sets understood: build_tour_context, save_tour and get_progress never do", async () => {
    await ok("build_tour_context", { journey: SIGNUP });
    await ok("save_tour", { journey: SIGNUP, tour: draft() });
    const p = await ok("get_progress", {});
    expect(p.journeys.every((j: { level: string }) => j.level === "none")).toBe(true);
    expect(existsSync(progressPath(loadMapState(demo).ws))).toBe(false);
  });

  it("counts a journey that needs a re-walk as not understood (like the dashboard), toured until re-checked", async () => {
    await ok("record_check", { journey: SIGNUP, ...answers3, verdict: "pass" });
    const s0 = signupStops()[0]!;
    const file = join(demo, s0.repo, s0.file);
    const before = readFileSync(file, "utf8");
    writeFileSync(file, `${before}\n// changed after the check\n`);
    try {
      const p = await ok("get_progress", {});
      const j = p.journeys.find((x: { journeyId: string }) => x.journeyId === SIGNUP);
      expect(j.needsReWalk.length).toBeGreaterThan(0);
      expect(p.totals.all).toMatchObject({ total: 2, understood: 0, toured: 1, needsReWalk: 1 });
      expect(p.totals.byArea.customers).toMatchObject({ total: 1, understood: 0, toured: 1, needsReWalk: 1 });
      expect(p.left.map((x: { journeyId: string }) => x.journeyId)).toContain(SIGNUP);
    } finally {
      writeFileSync(file, before);
    }
  });
});

// ---- prompts ---------------------------------------------------------------------------------------------

function promptText(r: GetPromptResult): string {
  const item = r.messages[0]!.content;
  if (item.type !== "text") throw new Error("expected text");
  return item.text;
}

describe("write-tour and check-me prompts", () => {
  it("write-tour builds context, writes all four parts, saves with save_tour and never invents", async () => {
    const t = promptText((await client.getPrompt({ name: "write-tour", arguments: { journey: SIGNUP } })) as GetPromptResult);
    expect(t).toContain(SIGNUP);
    expect(t).toContain("build_tour_context");
    expect(t).toContain("save_tour");
    expect(t).toMatch(/explanation/);
    expect(t).toMatch(/dataJourney/);
    expect(t).toMatch(/realistic sample/i);
    expect(t).toMatch(/trap/);
    expect(t).toMatch(/exactly 3/);
    expect(t).toMatch(/expected/);
    expect(t).toMatch(/never invent/i);
    expect(t).not.toMatch(/fileHash/);
  });

  it("check-me asks one question at a time, judges against the code, and never records an unearned pass", async () => {
    const t = promptText((await client.getPrompt({ name: "check-me", arguments: { journey: SIGNUP } })) as GetPromptResult);
    expect(t).toContain(SIGNUP);
    expect(t).toContain("build_tour_context");
    expect(t).toMatch(/one at a time/i);
    expect(t).toMatch(/write 3/i);
    expect(t).toMatch(/expected/);
    expect(t).toMatch(/code/);
    expect(t).toContain("record_check");
    expect(t).toMatch(/pass[^.]*all 3/i);
    expect(t).toMatch(/never record a pass/i);
  });

  it("both need the journey arg", async () => {
    await expect(client.getPrompt({ name: "write-tour", arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: "check-me", arguments: {} })).rejects.toThrow();
  });
});
