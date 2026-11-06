import { beforeEach, describe, expect, it } from "vitest";
import type { JourneyProgressView, LevelCounts, TourFile } from "@/api/types";
import { keyIdentity } from "@/lib/journey-stops";
import { displayLevel, nextTourStop, pickContinue, stripCounts, understoodPercent } from "@/lib/progress";

const key = (file: string, line: number, symbol: string, lane = "code", repo = "api") => JSON.stringify([lane, repo, file, line, symbol]);
const K1 = key("app/invoices/new/page.tsx", 12, "NewInvoicePage", "ui", "web");
const K2 = key("app/controllers/invoices_controller.ts", 41, "InvoicesController.store");
const K3 = key("app/controllers/invoices_controller.ts", 44, "InvoicesController.store", "db");

function view(p: Partial<JourneyProgressView> & { journeyId: string }): JourneyProgressView {
  return { name: p.journeyId, area: "Invoices", repos: ["api"], level: "none", needsReWalk: [], lastCheck: null, ...p };
}

const tour: TourFile = {
  version: 1,
  journeyId: "j_invoice",
  writtenAt: "2026-11-01T10:00:00.000Z",
  writtenAtCommit: { api: "abc1234" },
  stops: [K1, K2, K3].map((k, i) => ({ chainId: "ch_aaaa", stopIndex: i, key: k, fileHash: "h", explanation: "x" })),
  dataJourney: { input: "{}", steps: [], output: "{}" },
  fileNotes: [],
  check: [
    { question: "a" },
    { question: "b" },
    { question: "c" },
  ],
};

const counts = (p: Partial<LevelCounts>): LevelCounts => ({ total: 0, none: 0, seen: 0, toured: 0, understood: 0, needsReWalk: 0, ...p });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
});

describe("displayLevel", () => {
  it("is the stored level, except an understood journey with changed stops needs a re-walk", () => {
    expect(displayLevel(view({ journeyId: "j_a" }))).toBe("none");
    expect(displayLevel(view({ journeyId: "j_a", level: "seen" }))).toBe("seen");
    expect(displayLevel(view({ journeyId: "j_a", level: "toured" }))).toBe("toured");
    expect(displayLevel(view({ journeyId: "j_a", level: "understood" }))).toBe("understood");
    expect(displayLevel(view({ journeyId: "j_a", level: "understood", needsReWalk: [K2] }))).toBe("re-walk");
  });
});

describe("stripCounts and understoodPercent", () => {
  it("counts a journey that needs a re-walk as toured, not understood", () => {
    expect(stripCounts(counts({ total: 10, none: 3, seen: 2, toured: 1, understood: 4, needsReWalk: 1 }))).toEqual({
      total: 10,
      understood: 3,
      toured: 2,
      seen: 2,
    });
  });

  it("rounds down (100% only when every journey is understood) and is undefined with no journeys", () => {
    expect(understoodPercent(counts({ total: 3, understood: 2 }))).toBe(66);
    expect(understoodPercent(counts({ total: 3, understood: 3, needsReWalk: 1 }))).toBe(66);
    expect(understoodPercent(counts({ total: 3, understood: 3 }))).toBe(100);
    expect(understoodPercent(counts({ total: 0 }))).toBeUndefined();
  });
});

describe("nextTourStop", () => {
  it("is the first changed stop for a re-walk", () => {
    expect(nextTourStop(tour, view({ journeyId: "j_invoice", level: "understood", needsReWalk: [K3, K2] }), undefined)).toEqual({
      phase: "flow",
      stop: 2,
      stopId: keyIdentity(K2),
      resumed: false,
    });
  });

  it("carries the changed stop's line-free identity regardless of where it happens to sit in the tour file", () => {
    // `stop` (the tour file's own, raw order) moves when the file is reordered — a journey with several
    // chains, or a tour with removed stops, can list stops in an order that is not the journey's stop-number
    // order. `stopId` does not move: it is what Tour mode (which sorts by journey number) actually uses to
    // land on the right stop, so a link stays correct no matter how the tour file orders its stops.
    const reordered: TourFile = { ...tour, stops: [tour.stops[2]!, tour.stops[0]!, tour.stops[1]!] };
    const next = nextTourStop(reordered, view({ journeyId: "j_invoice", level: "understood", needsReWalk: [K3] }), undefined);
    expect(next?.stop).toBe(1); // K3 now sits first in the (reordered) file
    expect(next?.stopId).toBe(keyIdentity(K3)); // but its identity is unchanged, same as in the original order
  });

  it("resumes the place Tour mode remembered, else starts at stop 1", () => {
    const v = view({ journeyId: "j_invoice", level: "seen" });
    expect(nextTourStop(tour, v, { phase: "file-notes", stop: 3, viewed: ["flow"] })).toEqual({ phase: "file-notes", stop: 3, resumed: true });
    expect(nextTourStop(tour, v, undefined)).toEqual({ phase: "flow", stop: 1, resumed: false });
  });

  it("goes to Check yourself once every phase was viewed", () => {
    const v = view({ journeyId: "j_invoice", level: "toured" });
    expect(nextTourStop(tour, v, { phase: "flow", stop: 2, viewed: ["flow", "data-journey", "file-notes", "check"] })).toEqual({
      phase: "check",
      stop: 1,
      resumed: true,
    });
  });

  it("starts over when the remembered Flow stop is past the end of the tour", () => {
    expect(nextTourStop(tour, view({ journeyId: "j_invoice" }), { phase: "flow", stop: 9, viewed: [] })).toEqual({ phase: "flow", stop: 1, resumed: false });
  });

  it("finds the changed stop when its line moved since the tour was written", () => {
    const K3now = key("app/controllers/invoices_controller.ts", 45, "InvoicesController.store", "db");
    expect(nextTourStop(tour, view({ journeyId: "j_invoice", level: "understood", needsReWalk: [K3now] }), undefined)).toEqual({
      phase: "flow",
      stop: 3,
      stopId: keyIdentity(K3),
      resumed: false,
    });
  });

  it("is undefined without a tour", () => {
    expect(nextTourStop(null, view({ journeyId: "j_invoice" }), undefined)).toBeUndefined();
  });
});

describe("pickContinue", () => {
  const seen = view({ journeyId: "j_seen", level: "seen", seenAt: "2026-11-02T00:00:00.000Z" });
  const toured = view({ journeyId: "j_toured", level: "toured", seenAt: "2026-11-01T00:00:00.000Z", touredAt: "2026-11-03T00:00:00.000Z" });
  const done = view({ journeyId: "j_done", level: "understood", understoodAt: "2026-11-05T00:00:00.000Z" });
  const stale = view({ journeyId: "j_stale", level: "understood", needsReWalk: [K2], understoodAt: "2026-10-01T00:00:00.000Z" });
  const none = view({ journeyId: "j_none" });

  it("keeps the last opened journey while it is unfinished", () => {
    expect(pickContinue([seen, toured, done], "j_seen")).toBe("j_seen");
  });

  it("else picks the unfinished journey touched most recently", () => {
    expect(pickContinue([seen, toured, done, none], "j_done")).toBe("j_toured");
    expect(pickContinue([seen, done, stale, none], undefined)).toBe("j_seen");
  });

  it("counts a journey that needs a re-walk as unfinished", () => {
    expect(pickContinue([done, stale, none], "j_stale")).toBe("j_stale");
    expect(pickContinue([done, stale, none], undefined)).toBe("j_stale");
  });

  it("is undefined when nothing was started or everything is understood", () => {
    expect(pickContinue([done, none], "j_done")).toBeUndefined();
    expect(pickContinue([none], "j_none")).toBeUndefined();
  });
});
