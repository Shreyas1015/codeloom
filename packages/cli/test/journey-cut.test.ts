import { describe, expect, it } from "vitest";
import { fitResponse, responseBytes } from "../src/mcp/result.js";
import { fitJourney } from "../src/mcp/tools/journeys.js";

// A synthetic demo-shop journey: one page chain (Customer invoices page → API → DB) that is big, plus many
// small route-only and consumer chains whose ids sort before it.
type Stop = { lane: string; kind: string; repo: string; file: string; line: number; symbol: string; label?: string; confidence: string };
const stop = (lane: string, kind: string, file: string, line: number, label?: string): Stop => ({
  lane, kind, repo: lane === "ui" ? "web" : "api", file, line, symbol: `${kind}${line}`, ...(label ? { label } : {}), confidence: "high",
});
const view = (id: string, stops: Stop[]) => ({ id, name: id, entry: stops[0]!.kind, stops, unresolved: [], journeys: ["j_invoices"] });

function syntheticJourney() {
  const pageStops = [
    stop("ui", "page", "src/pages/invoices.tsx", 1, "/customers/[id]/invoices"),
    stop("ui", "call", "src/pages/invoices.tsx", 12, "GET /api/invoices"),
    ...Array.from({ length: 120 }, (_, i) => stop("code", "function", `src/invoices/step${i}.ts`, i + 1)),
    stop("db", "db", "src/invoices/repo.ts", 9, "invoices"),
  ];
  const routeChains = Array.from({ length: 60 }, (_, i) =>
    view(`ch_0${String(i).padStart(11, "0")}`, [
      stop("api", "route", `src/routes/r${i}.ts`, 1, `GET /api/customers/${i}`),
      ...Array.from({ length: 10 }, (_, k) => stop("code", "function", `src/customers/c${i}_${k}.ts`, k + 1)),
      stop("db", "db", "src/customers/repo.ts", 3, "customers"),
    ]));
  const consumer = view("ch_00000000000a", [stop("queue", "consume", "src/jobs/invoice-mail.ts", 4, "invoice-mail")]);
  const page = view("ch_ffffffffffff", pageStops);
  const chains = [consumer, ...routeChains, page]; // sorted by id: the page chain is last
  const lanes: Record<string, Stop[]> = { ui: [], api: [], code: [], db: [], queue: [] };
  for (const c of chains) for (const s of c.stops) lanes[s.lane]!.push(s);
  return { journey: { id: "j_invoices", name: "Customer invoices" }, chains, lanes, files: [], tables: ["customers", "invoices"], queues: [], unresolved: [], missingChainIds: [], movedChainIds: [] };
}

const MAX = 100_000;

describe("hG: get_journey keeps the page chain when the response must be cut", () => {
  it("today's generic cut drops the page chain (the bug this guards)", () => {
    const r = syntheticJourney();
    expect(responseBytes(r)).toBeGreaterThan(MAX);
    const generic = fitResponse(r, "narrow", MAX);
    expect((generic.chains as Array<{ id: string }>).some((c) => c.id === "ch_ffffffffffff")).toBe(false);
  });

  it("keeps page chains first, then route-only, then consumer; smaller first; lanes for all; names the left-out ids", () => {
    const r = syntheticJourney();
    const out = fitJourney(r, MAX);
    expect(responseBytes(out)).toBeLessThanOrEqual(MAX);
    const kept = (out.chains as Array<{ id: string }>).map((c) => c.id);
    expect(kept[0]).toBe("ch_ffffffffffff");
    expect(kept.length).toBeGreaterThan(1);
    expect(kept.length).toBeLessThan(r.chains.length);
    expect(kept).not.toContain("ch_00000000000a"); // the consumer chain comes last
    const omitted = out.omittedChainIds as string[];
    expect([...kept, ...omitted].sort()).toEqual(r.chains.map((c) => c.id).sort());
    expect(out.truncated).toBe(true);
    expect(out.truncatedNote).toContain("get_journey");
    expect(out.truncatedNote).toContain(omitted[0]);
    // The compact lanes cover every chain: the queue stop of the omitted consumer chain is still there.
    const lanes = out.lanes as Record<string, Array<{ label: string; repo: string; at: string }>>;
    expect(lanes.queue).toEqual([{ label: "invoice-mail", repo: "api", at: "src/jobs/invoice-mail.ts:4" }]);
    expect(lanes.api).toHaveLength(50); // capped at 50 per lane
    expect((out.laneTotals as Record<string, number>).api).toBe(60);
    expect(lanes.ui.map((s) => s.label)).toEqual(["/customers/[id]/invoices", "GET /api/invoices"]);
    expect(r.chains).toHaveLength(62); // input not mutated
  });

  it("when not even the page chain fits whole, keeps its first stops and still fits", () => {
    const r = syntheticJourney();
    const out = fitJourney(r, 60_000);
    expect(responseBytes(out)).toBeLessThanOrEqual(60_000);
    const kept = out.chains as Array<{ id: string; stops: unknown[] }>;
    expect(kept.map((c) => c.id)).toEqual(["ch_ffffffffffff"]);
    expect(kept[0]!.stops.length).toBeGreaterThan(0);
    expect(kept[0]!.stops.length).toBeLessThan(123);
    expect(out.truncatedNote).toContain("shows its first");
    expect(out.omittedChainIds as string[]).toHaveLength(61);
  });

  it("returns a result that fits as is", () => {
    const r = syntheticJourney();
    expect(fitJourney(r, 10_000_000)).toBe(r);
  });
});
