import { beforeEach, describe, expect, it } from "vitest";
import type { JourneyProgressView, LevelCounts, TourFile } from "@/api/types";
import {
  displayLevel,
  nextTourStop,
  pickContinue,
  stopKeyFields,
  stripCounts,
  tourHref,
  understoodPercent,
} from "@/lib/progress";
import { readTourStop, rememberTourStop, tourStopKey } from "@/lib/tourPosition";

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
    { question: "a", expected: ["x"] },
    { question: "b", expected: ["x"] },
    { question: "c", expected: ["x"] },
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

describe("stopKeyFields", () => {
  it("parses a stopKey and rejects anything else", () => {
    expect(stopKeyFields(K2)).toEqual({ lane: "code", repo: "api", file: "app/controllers/invoices_controller.ts", line: 41, symbol: "InvoicesController.store" });
    expect(stopKeyFields("nope")).toBeNull();
    expect(stopKeyFields(JSON.stringify(["a", "b"]))).toBeNull();
  });
});

describe("tourHref", () => {
  it("builds the Tour mode URL with phase and a 1-based stop", () => {
    expect(tourHref("j_invoice", "flow", 2)).toBe("/journeys/j_invoice/tour?phase=flow&stop=2");
    expect(tourHref("j/x y", "check")).toBe("/journeys/j%2Fx%20y/tour?phase=check");
  });
});

describe("tour position", () => {
  it("remembers the last tour stop per workspace and journey, and ignores bad values", () => {
    expect(readTourStop("demo-shop", "j_invoice")).toBeUndefined();
    rememberTourStop("demo-shop", "j_invoice", { phase: "data-journey", stop: 2 });
    expect(readTourStop("demo-shop", "j_invoice")).toEqual({ phase: "data-journey", stop: 2 });
    expect(readTourStop("other", "j_invoice")).toBeUndefined();
    localStorage.setItem(tourStopKey("demo-shop", "j_bad"), JSON.stringify({ phase: "nope", stop: 0 }));
    expect(readTourStop("demo-shop", "j_bad")).toBeUndefined();
    localStorage.setItem(tourStopKey("demo-shop", "j_bad"), "{");
    expect(readTourStop("demo-shop", "j_bad")).toBeUndefined();
  });
});

describe("nextTourStop", () => {
  it("is the first changed stop for a re-walk", () => {
    expect(nextTourStop(tour, view({ journeyId: "j_invoice", level: "understood", needsReWalk: [K3, K2] }), undefined)).toEqual({
      phase: "flow",
      stop: 2,
      resumed: false,
    });
  });

  it("resumes the remembered stop, else starts at stop 1", () => {
    const v = view({ journeyId: "j_invoice", level: "seen" });
    expect(nextTourStop(tour, v, { phase: "file-notes", stop: 3 })).toEqual({ phase: "file-notes", stop: 3, resumed: true });
    expect(nextTourStop(tour, v, undefined)).toEqual({ phase: "flow", stop: 1, resumed: false });
  });

  it("starts over when the remembered stop is past the end of the tour", () => {
    expect(nextTourStop(tour, view({ journeyId: "j_invoice" }), { phase: "flow", stop: 9 })).toEqual({ phase: "flow", stop: 1, resumed: false });
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
