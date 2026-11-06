import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { loadMapState, type MapState } from "../src/mcp/state.js";
import { buildTourContext } from "../src/mcp/tools/tours.js";
import { journeyStopKeys, progressPath, progressView, readProgress, recordCheck } from "../src/store/progress.js";
import { keyIdentity, parseStopKey, stopIdentity, stopKey, stopMatcher } from "../src/store/stop-key.js";
import { type TourDraft, writeTour } from "../src/store/tours.js";
import { writeJsonAtomic } from "../src/store/json.js";
import { tourFor } from "../src/web/api.js";
import { materializeFixture } from "./helpers.js";

// Tours and progress match saved stops to the journey by a line-free identity (lane, repo, file, symbol),
// so a line added above a stop marks it "may be out of date", never "Removed" (v0.2b final review).

const SIGNUP = "j_00000000c0de";
const at = (chainId: string, stopIndex: number, line: number, symbol = "S.run", file = "a.ts") => ({
  chainId, stopIndex, key: stopKey({ lane: "code", repo: "api", file, line, symbol }),
});

describe("stopIdentity and stopMatcher", () => {
  it("the identity leaves the line out; the key keeps it", () => {
    const a = { lane: "db", repo: "api", file: "s.ts", line: 6, symbol: "S.create" };
    expect(stopIdentity(a)).toBe(stopIdentity({ ...a, line: 7 }));
    expect(stopKey(a)).not.toBe(stopKey({ ...a, line: 7 }));
    expect(stopIdentity(a)).not.toBe(stopIdentity({ ...a, lane: "code" }));
    expect(keyIdentity(stopKey(a))).toBe(stopIdentity(a));
    expect(keyIdentity("nope")).toBeNull();
  });

  it("matches exact keys, then a unique identity, then (chainId, stopIndex) when the identity is shared", () => {
    const now = [at("ch_a", 0, 11), at("ch_a", 1, 21, "S.save"), at("ch_a", 2, 31, "S.save")];
    const match = stopMatcher(now);
    expect(match(now[0]!.key)).toBe(now[0]!.key);
    // moved down one line, the only S.run in a.ts
    expect(match(at("ch_a", 0, 10).key, { chainId: "ch_a", stopIndex: 0 })).toBe(now[0]!.key);
    // two S.save stops in a.ts: the saved place decides
    expect(match(at("ch_a", 2, 30, "S.save").key, { chainId: "ch_a", stopIndex: 2 })).toBe(now[2]!.key);
    expect(match(at("ch_a", 1, 20, "S.save").key, { chainId: "ch_a", stopIndex: 1 })).toBe(now[1]!.key);
    expect(match(at("ch_a", 1, 20, "S.save").key)).toBeUndefined();
    // the place holds a different stop now
    expect(match(at("ch_a", 0, 20, "S.save").key, { chainId: "ch_a", stopIndex: 0 })).toBeUndefined();
    // gone
    expect(match(at("ch_a", 0, 10, "S.gone").key)).toBeUndefined();
  });
});

describe("a line added at the top of a stop's file (demo-shop)", () => {
  let demo: string;
  let state: MapState;
  let beforeKeys: string[];
  const SERVICE = "app/services/customer_service.ts";

  beforeAll(async () => {
    process.env.CODELOOM_HOME = mkdtempSync(join(tmpdir(), "codeloom-home-"));
    demo = materializeFixture("demo-shop");
    writeFileSync(
      join(demo, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
    );
    await runIndex(demo);
    const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string }>;
    const createId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
    writeFileSync(
      join(demo, ".codeloom", "journeys.json"),
      JSON.stringify({ version: 1, journeys: [{ id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" }] }),
    );
    state = loadMapState(demo);
    const chain = state.chains.find((c) => c.id === createId)!;
    const draft: TourDraft = {
      stops: chain.stops.map((s, i) => ({ chainId: chain.id, stopIndex: i, key: stopKey(s), explanation: s.symbol })),
      dataJourney: { input: "", steps: chain.stops.map((s) => ({ stopKey: stopKey(s), note: s.symbol })), output: "" },
      fileNotes: [],
      check: [1, 2, 3].map((n) => ({ question: `q${n}`, expected: ["p"] })),
    };
    writeTour(demo, SIGNUP, draft, { ws: state.ws });
    recordCheck(state, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "" });
    beforeKeys = journeyStopKeys(state, SIGNUP);

    const file = join(demo, "api", SERVICE);
    writeFileSync(file, `// a new first line\n${readFileSync(file, "utf8")}`);
    await runIndex(demo);
    state = loadMapState(demo);
  }, 180_000);

  const inService = (keys: string[]) => keys.filter((k) => parseStopKey(k)!.file === SERVICE);

  it("the fixture has two stops sharing one identity in that file (the fallback is exercised)", () => {
    const ids = inService(beforeKeys).map((k) => keyIdentity(k));
    expect(new Set(ids).size).toBeLessThan(ids.length);
    const now = inService(journeyStopKeys(state, SIGNUP));
    expect(now.map((k) => parseStopKey(k)!.line)).toEqual(inService(beforeKeys).map((k) => parseStopKey(k)!.line + 1));
  });

  it("the tour stop is stale, not removed (dashboard API and build_tour_context)", () => {
    const r = tourFor(demo, SIGNUP);
    expect(r.removedStops).toEqual([]);
    expect(r.staleStops).toEqual(inService(beforeKeys));
    const ctx = buildTourContext(demo, SIGNUP) as { tour: { removedStops: string[]; staleStops: string[] } };
    expect(ctx.tour.removedStops).toEqual([]);
    expect(ctx.tour.staleStops).toEqual(inService(beforeKeys));
  });

  it("needs re-walk lists that file's stops by their current keys, and nothing else", () => {
    const v = progressView(state).journeys.find((j) => j.journeyId === SIGNUP)!;
    expect(v.needsReWalk).toEqual(inService(journeyStopKeys(state, SIGNUP)));
  });

  it("a stop whose line moved but whose file hash is the same does not need a re-walk", () => {
    // a pass now (current hashes), then pretend it was recorded with every stop three lines lower
    recordCheck(state, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "" });
    const now = readProgress(state.ws);
    const p = now.journeys[SIGNUP]!;
    const shifted = Object.fromEntries(Object.entries(p.stopHashes!).map(([k, h]) => {
      const f = parseStopKey(k)!;
      return [stopKey({ ...f, line: f.line + 3 }), h];
    }));
    writeJsonAtomic(progressPath(state.ws), { ...now, journeys: { ...now.journeys, [SIGNUP]: { ...p, stopHashes: shifted } } });
    const v = progressView(state).journeys.find((j) => j.journeyId === SIGNUP)!;
    expect(v.needsReWalk).toEqual([]);
  });
});
