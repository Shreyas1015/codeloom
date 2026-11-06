import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import { loadMapState, type MapState } from "../src/mcp/state.js";
import {
  codeloomHome,
  journeyStopKeys,
  markSeen,
  markToured,
  progressPath,
  progressView,
  readProgress,
  recordCheck,
  TOUR_PHASES,
  workspaceId,
} from "../src/store/progress.js";
import { parseStopKey, stopKey } from "../src/store/stop-key.js";
import { hashFile, listTours, readTour, type TourDraft, TourFileSchema, tourPath, tourStaleStops, writeTour } from "../src/store/tours.js";
import { materializeFixture } from "./helpers.js";

const SIGNUP = "j_00000000c0de";
const PAY = "j_0000000000aa";
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

let demo: string;
let state: MapState;
const fresh = () => loadMapState(demo);

/** A fresh CODELOOM_HOME per test, so progress never leaks between tests. */
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
  const chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains as Array<{ id: string; routeKey: string; entry: string }>;
  const createId = chains.find((c) => c.routeKey === "api:POST /api/customers")!.id;
  const payId = chains.find((c) => c.routeKey === "billing:POST /billing/invoices/:id/pay")!.id;
  writeFileSync(
    join(demo, ".codeloom", "journeys.json"),
    JSON.stringify({
      version: 1,
      journeys: [
        { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" },
        { id: PAY, name: "Pay an invoice", area: "billing", note: "", chainIds: [payId], status: "ok" },
      ],
    }),
  );
  state = fresh();
}, 120_000);

/** The SIGNUP journey's chain and its stops, straight from chains.json. */
function signupChain() {
  const j = state.journeys.find((x) => x.id === SIGNUP)!;
  return state.chains.find((c) => c.id === j.chainIds[0])!;
}

/** Git HEAD of each repo the SIGNUP chain's stops touch. */
function signupCommits(): Record<string, string> {
  const repos = [...new Set(signupChain().stops.map((s) => s.repo))].sort();
  return Object.fromEntries(repos.map((r) => [r, head(join(demo, r))]));
}

function draft(): TourDraft {
  const chain = signupChain();
  return {
    stops: chain.stops.map((s, i) => ({ chainId: chain.id, stopIndex: i, key: stopKey(s), explanation: `Stop ${i}: **${s.symbol}**` })),
    dataJourney: {
      input: '{ "name": "Ada", "email": "ada@example.com" }',
      steps: chain.stops.map((s) => ({ stopKey: stopKey(s), note: `passes through ${s.symbol}` })),
      output: '{ "id": 1, "name": "Ada" }',
    },
    fileNotes: [
      { repo: "web", file: "zzz.ts", notes: [{ kind: "note", text: "last" }] },
      { repo: "api", file: "aaa.ts", notes: [{ kind: "trap", text: "first" }] },
    ],
    check: [
      { question: "Where is the customer saved?", expected: ["the db insert"] },
      { question: "What validates the body?", expected: ["the validator"] },
      { question: "What does the page show after?", expected: ["the new customer"] },
    ],
  };
}

const NOW = new Date("2026-11-05T10:00:00.000Z");

describe("tours store", () => {
  it("TourFileSchema needs exactly 3 check questions and caps explanation size", () => {
    const tour = writeTour(demo, SIGNUP, draft(), { ws: state.ws, now: NOW });
    expect(TourFileSchema.safeParse(tour).success).toBe(true);
    expect(TourFileSchema.safeParse({ ...tour, check: tour.check.slice(0, 2) }).success).toBe(false);
    expect(TourFileSchema.safeParse({ ...tour, check: [...tour.check, tour.check[0]] }).success).toBe(false);
    const long = { ...tour, stops: [{ ...tour.stops[0]!, explanation: "x".repeat(1501) }] };
    expect(TourFileSchema.safeParse(long).success).toBe(false);
    expect(TourFileSchema.safeParse({ ...tour, version: 2 }).success).toBe(false);
  });

  it("writeTour computes fileHash and writtenAtCommit itself (agent hashes are ignored) and writes sorted JSON", () => {
    const d = draft();
    const withFake = { ...d, stops: d.stops.map((s) => ({ ...s, fileHash: "0".repeat(64) })) } as unknown as TourDraft;
    const reversed = { ...withFake, stops: [...withFake.stops].reverse() };
    const tour = writeTour(demo, SIGNUP, reversed, { ws: state.ws, now: NOW });
    const chain = signupChain();
    expect(tour.stops.map((s) => s.stopIndex)).toEqual(chain.stops.map((_, i) => i));
    for (const s of tour.stops) {
      const k = parseStopKey(s.key)!;
      expect(s.fileHash).toBe(sha256(readFileSync(join(demo, k.repo, k.file))));
    }
    expect(tour.writtenAtCommit).toEqual(signupCommits());
    expect(Object.keys(tour.writtenAtCommit)).toEqual(["api", "web"]);
    expect(tour.writtenAt).toBe(NOW.toISOString());
    expect(tour.fileNotes.map((f) => f.file)).toEqual(["aaa.ts", "zzz.ts"]);
    const path = tourPath(demo, SIGNUP);
    expect(path).toBe(join(demo, ".codeloom", "tours", `${SIGNUP}.json`));
    const text = readFileSync(path, "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(JSON.parse(text)).sort());
    expect(readTour(demo, SIGNUP)).toEqual(tour);
    // deterministic: the same draft at the same time writes the same bytes
    writeTour(demo, SIGNUP, d, { ws: state.ws, now: NOW });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("writeTour rejects bad journey ids, a wrong number of questions, bad stop keys and missing files", () => {
    expect(() => writeTour(demo, "../evil", draft(), { ws: state.ws })).toThrow(CodeloomError);
    expect(() => writeTour(demo, SIGNUP, { ...draft(), check: draft().check.slice(1) }, { ws: state.ws })).toThrow(/check/);
    const badKey = { ...draft(), stops: [{ chainId: "ch_x", stopIndex: 0, key: "nope", explanation: "" }] };
    expect(() => writeTour(demo, SIGNUP, badKey, { ws: state.ws })).toThrow(/stop key/);
    const gone = { ...draft(), stops: [{ chainId: "ch_x", stopIndex: 0, key: stopKey({ lane: "code", repo: "api", file: "no/such.ts", line: 1, symbol: "x" }), explanation: "" }] };
    expect(() => writeTour(demo, SIGNUP, gone, { ws: state.ws })).toThrow(/no\/such\.ts/);
  });

  it("tourStaleStops lists exactly the stops whose file changed", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-tour-stale-"));
    cpSync(demo, root, { recursive: true });
    const ws = loadMapState(root).ws;
    const tour = writeTour(root, SIGNUP, draft(), { ws, now: NOW });
    expect(tourStaleStops(tour, ws)).toEqual([]);
    const target = parseStopKey(tour.stops[tour.stops.length - 1]!.key)!;
    writeFileSync(join(root, target.repo, target.file), readFileSync(join(root, target.repo, target.file), "utf8") + "\n// changed\n");
    const expected = tour.stops.filter((s) => {
      const k = parseStopKey(s.key)!;
      return k.repo === target.repo && k.file === target.file;
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(tourStaleStops(tour, ws)).toEqual(expected);
  });

  it("listTours lists journey ids with a tour file, sorted; readTour of a missing tour is null; a corrupt one exits 2", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-tours-"));
    expect(listTours(root)).toEqual([]);
    expect(readTour(root, SIGNUP)).toBeNull();
    mkdirSync(join(root, ".codeloom", "tours"), { recursive: true });
    writeFileSync(join(root, ".codeloom", "tours", `${SIGNUP}.json`), "{ nope");
    writeFileSync(join(root, ".codeloom", "tours", `${PAY}.json`), "{}");
    writeFileSync(join(root, ".codeloom", "tours", "notes.txt"), "x");
    expect(listTours(root)).toEqual([PAY, SIGNUP]);
    try {
      readTour(root, SIGNUP);
      expect.fail("expected a CodeloomError");
    } catch (err) {
      expect(err).toBeInstanceOf(CodeloomError);
      expect((err as CodeloomError).exitCode).toBe(2);
    }
  });

  it("hashFile is the sha256 of the file's bytes, null when missing", () => {
    const p = join(demo, "api", "package.json");
    expect(hashFile(p)).toBe(sha256(readFileSync(p)));
    expect(hashFile(join(demo, "missing.ts"))).toBeNull();
  });
});

describe("progress store", () => {
  it("workspaceId is 16 hex chars from the name and sorted repo ids: same for a clone at another path", () => {
    const id = workspaceId(state.ws);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toBe(sha256(JSON.stringify(["demo-shop", ["api", "billing", "web"]])).slice(0, 16));
    const clone = mkdtempSync(join(tmpdir(), "codeloom-clone-"));
    cpSync(demo, clone, { recursive: true });
    expect(workspaceId(loadMapState(clone).ws)).toBe(id);
    expect(workspaceId({ ...state.ws, repos: [...state.ws.repos].reverse() })).toBe(id);
    expect(workspaceId({ ...state.ws, name: "other" })).not.toBe(id);
  });

  it("progressPath respects CODELOOM_HOME, else ~/.codeloom; never under the workspace", () => {
    const home = process.env.CODELOOM_HOME!;
    expect(codeloomHome()).toBe(home);
    expect(progressPath(state.ws)).toBe(join(home, "progress", `${workspaceId(state.ws)}.json`));
    delete process.env.CODELOOM_HOME;
    expect(codeloomHome()).toBe(join(homedir(), ".codeloom"));
    process.env.CODELOOM_HOME = join(demo, ".codeloom-home");
    expect(() => progressPath(state.ws)).toThrow(/workspace/);
    process.env.CODELOOM_HOME = home;
  });

  it("readProgress of a missing file is empty; markSeen sets seen without writing under the workspace", () => {
    expect(readProgress(state.ws)).toEqual({ version: 1, journeys: {} });
    markSeen(state.ws, SIGNUP, { now: NOW });
    expect(existsSync(progressPath(state.ws))).toBe(true);
    expect(readProgress(state.ws).journeys[SIGNUP]).toEqual({ seenAt: NOW.toISOString(), checks: [] });
    // a later open keeps the first seenAt
    markSeen(state.ws, SIGNUP, { now: new Date("2026-12-01T00:00:00.000Z") });
    expect(readProgress(state.ws).journeys[SIGNUP]!.seenAt).toBe(NOW.toISOString());
    const view = progressView(fresh());
    expect(view.journeys.find((j) => j.journeyId === SIGNUP)!.level).toBe("seen");
    expect(view.journeys.find((j) => j.journeyId === PAY)!.level).toBe("none");
    expect(() => markSeen(state.ws, "nope")).toThrow(CodeloomError);
  });

  it("markToured needs all four phases and a tour; it never sets understood", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-toured-"));
    cpSync(demo, root, { recursive: true });
    rmSync(join(root, ".codeloom", "tours"), { recursive: true, force: true });
    const s = loadMapState(root);
    expect(TOUR_PHASES).toEqual(["flow", "data-journey", "file-notes", "check"]);
    expect(() => markToured(s.ws, SIGNUP, [...TOUR_PHASES])).toThrow(/tour/);
    writeTour(root, SIGNUP, draft(), { ws: s.ws, now: NOW });
    expect(() => markToured(s.ws, SIGNUP, ["flow", "data-journey", "file-notes"])).toThrow(/check/);
    expect(() => markToured(s.ws, SIGNUP, ["flow", "data-journey", "file-notes", "bogus"])).toThrow(CodeloomError);
    expect(readProgress(s.ws).journeys[SIGNUP]).toBeUndefined();
    markToured(s.ws, SIGNUP, ["check", "file-notes", "data-journey", "flow"], { now: NOW });
    const p = readProgress(s.ws).journeys[SIGNUP]!;
    expect(p.touredAt).toBe(NOW.toISOString());
    expect(p.understoodAt).toBeUndefined();
    expect(progressView(loadMapState(root)).journeys.find((j) => j.journeyId === SIGNUP)!.level).toBe("toured");
  });

  it("recordCheck with fail appends a check and never sets understood", () => {
    const input = { questions: ["q1", "q2", "q3"], answers: ["a1", "a2", "a3"], verdict: "fail" as const, notes: "missed the insert" };
    recordCheck(state, SIGNUP, input, { now: NOW });
    const p = readProgress(state.ws).journeys[SIGNUP]!;
    expect(p.understoodAt).toBeUndefined();
    expect(p.understoodAtCommit).toBeUndefined();
    expect(p.stopHashes).toBeUndefined();
    expect(p.checks).toEqual([{ at: NOW.toISOString(), ...input, commit: signupCommits() }]);
    const v = progressView(fresh()).journeys.find((j) => j.journeyId === SIGNUP)!;
    expect(v.level).toBe("none");
    expect(v.lastCheck).toEqual(p.checks[0]);
    expect(() => recordCheck(state, "j_ffffffffffff", input)).toThrow(/j_ffffffffffff/);
    expect(() => recordCheck(state, SIGNUP, { ...input, verdict: "maybe" } as never)).toThrow(CodeloomError);
  });

  it("recordCheck with pass sets understood with codeloom-computed commits and stop hashes", () => {
    recordCheck(state, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "fail", notes: "" }, { now: NOW });
    const later = new Date("2026-11-06T00:00:00.000Z");
    recordCheck(state, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "all good" }, { now: later });
    const p = readProgress(state.ws).journeys[SIGNUP]!;
    expect(p.checks.map((c) => c.verdict)).toEqual(["fail", "pass"]);
    expect(p.understoodAt).toBe(later.toISOString());
    expect(p.understoodAtCommit).toEqual(signupCommits());
    const keys = journeyStopKeys(state, SIGNUP);
    expect(keys).toEqual([...new Set(signupChain().stops.map((s) => stopKey(s)))]);
    expect(Object.keys(p.stopHashes!).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const f = parseStopKey(k)!;
      expect(p.stopHashes![k]).toBe(sha256(readFileSync(join(demo, f.repo, f.file))));
    }
    const v = progressView(fresh()).journeys.find((j) => j.journeyId === SIGNUP)!;
    expect(v).toMatchObject({ level: "understood", needsReWalk: [] });
  });

  it("editing a stop's file puts exactly that file's stops on needsReWalk; passing again restores", () => {
    const root = mkdtempSync(join(tmpdir(), "codeloom-rewalk-"));
    cpSync(demo, root, { recursive: true });
    const s = loadMapState(root);
    recordCheck(s, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "" }, { now: NOW });
    const keys = journeyStopKeys(s, SIGNUP);
    // the file holding the fewest of the journey's stops
    const byFile = new Map<string, string[]>();
    for (const k of keys) {
      const f = parseStopKey(k)!;
      const id = `${f.repo}/${f.file}`;
      byFile.set(id, [...(byFile.get(id) ?? []), k]);
    }
    const [file, expected] = [...byFile.entries()].sort((a, b) => a[1].length - b[1].length)[0]!;
    writeFileSync(join(root, file), readFileSync(join(root, file), "utf8") + "\n// edited\n");
    const v = progressView(loadMapState(root)).journeys.find((j) => j.journeyId === SIGNUP)!;
    expect(v.level).toBe("understood");
    expect(v.needsReWalk).toEqual(expected);
    expect(v.needsReWalk.length).toBeLessThan(keys.length);
    recordCheck(s, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "" }, { now: NOW });
    expect(progressView(loadMapState(root)).journeys.find((j) => j.journeyId === SIGNUP)!.needsReWalk).toEqual([]);
  });

  it("totals count journeys by level per repo and per area; progress for unknown journeys is reported as older", () => {
    markSeen(state.ws, PAY, { now: NOW });
    recordCheck(state, SIGNUP, { questions: ["q"], answers: ["a"], verdict: "pass", notes: "" }, { now: NOW });
    markSeen(state.ws, "j_0123456789ab", { now: NOW });
    const v = progressView(fresh());
    expect(v.workspaceId).toBe(workspaceId(state.ws));
    expect(v.journeys.map((j) => j.journeyId)).toEqual([PAY, SIGNUP]);
    expect(v.totals.all).toEqual({ total: 2, none: 0, seen: 1, toured: 0, understood: 1, needsReWalk: 0 });
    expect(v.totals.byArea).toEqual({
      billing: { total: 1, none: 0, seen: 1, toured: 0, understood: 0, needsReWalk: 0 },
      customers: { total: 1, none: 0, seen: 0, toured: 0, understood: 1, needsReWalk: 0 },
    });
    expect(v.totals.byRepo.api).toMatchObject({ total: 1, understood: 1 });
    expect(v.totals.byRepo.billing).toMatchObject({ total: 1, seen: 1 });
    expect(v.olderJourneys).toEqual(["j_0123456789ab"]);
    expect(v.olderTours).toEqual([]);
  });

  it("a tour for a journey no longer in journeys.json is older too, and listed in olderTours", () => {
    const OLD = "j_00000000dead";
    const t = writeTour(demo, SIGNUP, draft(), { ws: state.ws, now: NOW });
    writeFileSync(tourPath(demo, OLD), JSON.stringify({ ...t, journeyId: OLD }));
    markSeen(state.ws, "j_0123456789ab", { now: NOW });
    try {
      const v = progressView(fresh());
      expect(v.olderJourneys).toEqual([OLD, "j_0123456789ab"]);
      expect(v.olderTours).toEqual([OLD]);
    } finally {
      rmSync(tourPath(demo, OLD));
    }
  });

  it("a corrupt progress file is a clear exit-2 error and is never overwritten", () => {
    const path = progressPath(state.ws);
    mkdirSync(join(path, ".."), { recursive: true });
    for (const bad of ["{ nope", '{ "version": 1, "journeys": { "j_00000000c0de": { "checks": "x" } } }']) {
      writeFileSync(path, bad);
      for (const fn of [
        () => readProgress(state.ws),
        () => markSeen(state.ws, SIGNUP),
        () => recordCheck(state, SIGNUP, { questions: [], answers: [], verdict: "pass", notes: "" }),
        () => progressView(state),
      ]) {
        try {
          fn();
          expect.fail("expected a CodeloomError");
        } catch (err) {
          expect(err).toBeInstanceOf(CodeloomError);
          expect((err as CodeloomError).exitCode).toBe(2);
          expect((err as Error).message).toContain(path);
          expect((err as Error).message).toMatch(/never overwrites/);
        }
      }
      expect(readFileSync(path, "utf8")).toBe(bad);
    }
  });
});
