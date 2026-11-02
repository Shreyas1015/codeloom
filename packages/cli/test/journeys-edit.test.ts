import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import { journeyId } from "../src/linker/chains.js";
import { applyJourneyOps, type JourneyOp } from "../src/store/journeys-edit.js";
import type { Journey } from "../src/store/schemas.js";
import { compare } from "../src/util.js";

const A = "ch_aaaaaaaaaaaa";
const B = "ch_bbbbbbbbbbbb";
const C = "ch_cccccccccccc";
const D = "ch_dddddddddddd";
const known = new Set([A, B, C, D]);

function j(chainIds: string[], name: string, extra: Partial<Journey> = {}): Journey {
  return { id: journeyId(chainIds), name, area: "", note: "", chainIds: [...chainIds].sort(), status: "ok", ...extra };
}

const base = (): Journey[] => [j([A, B], "Buy", { area: "shop", note: "n" }), j([C], "Pay")].sort((x, y) => (x.id < y.id ? -1 : 1));

function expectOpError(ops: JourneyOp[], pattern: RegExp, journeys = base()): void {
  const before = JSON.stringify(journeys);
  let err: unknown;
  try {
    applyJourneyOps(journeys, ops, known);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CodeloomError);
  expect((err as Error).message).toMatch(pattern);
  expect(JSON.stringify(journeys)).toBe(before);
}

describe("applyJourneyOps", () => {
  it("create: id from sorted chain ids, defaults, sorted output, input untouched", () => {
    const input = base();
    const before = JSON.stringify(input);
    const r = applyJourneyOps(input, [{ op: "create", name: "Ship", chainIds: [D, B] }], known);
    const id = journeyId([B, D]);
    expect(r.created).toEqual([id]);
    expect(r.updated).toEqual([]);
    expect(r.deleted).toEqual([]);
    expect(r.journeys.find((x) => x.id === id)).toEqual({ id, name: "Ship", area: "", note: "", chainIds: [B, D], status: "ok" });
    expect(r.journeys.map((x) => x.id)).toEqual([...r.journeys.map((x) => x.id)].sort());
    expect(JSON.stringify(input)).toBe(before);
  });

  it("update: renames, re-areas and notes without changing the id", () => {
    const input = base();
    const id = journeyId([A, B]);
    const r = applyJourneyOps(input, [{ op: "update", id, name: "Checkout", area: "cart", note: "hi" }], known);
    expect(r.updated).toEqual([id]);
    expect(r.journeys.find((x) => x.id === id)).toMatchObject({ id, name: "Checkout", area: "cart", note: "hi", chainIds: [A, B] });
    const keep = applyJourneyOps(input, [{ op: "update", id, note: "only note" }], known);
    expect(keep.journeys.find((x) => x.id === id)).toMatchObject({ name: "Buy", area: "shop", note: "only note" });
  });

  it("update with no actual change reports nothing updated", () => {
    const id = journeyId([A, B]);
    const r = applyJourneyOps(base(), [{ op: "update", id, name: "Buy" }], known);
    expect(r.updated).toEqual([]);
  });

  it("merge: new id from the sorted union, old journeys deleted", () => {
    const ab = journeyId([A, B]);
    const c = journeyId([C]);
    const r = applyJourneyOps(base(), [{ op: "merge", ids: [c, ab], name: "All", area: "x" }], known);
    const id = journeyId([A, B, C]);
    expect(r.created).toEqual([id]);
    expect(r.deleted).toEqual([ab, c].sort());
    expect(r.journeys).toEqual([{ id, name: "All", area: "x", note: "", chainIds: [A, B, C], status: "ok" }]);
  });

  it("split: parts become new journeys, the old one is deleted", () => {
    const ab = journeyId([A, B]);
    const r = applyJourneyOps(base(), [{ op: "split", id: ab, parts: [{ name: "A part", chainIds: [A] }, { name: "B part", area: "b", chainIds: [B] }] }], known);
    expect(r.deleted).toEqual([ab]);
    expect(r.created).toEqual([journeyId([A]), journeyId([B])].sort());
    expect(r.journeys.find((x) => x.id === journeyId([B]))).toMatchObject({ name: "B part", area: "b", chainIds: [B] });
  });

  it("delete removes the journey", () => {
    const c = journeyId([C]);
    const r = applyJourneyOps(base(), [{ op: "delete", id: c }], known);
    expect(r.deleted).toEqual([c]);
    expect(r.journeys.map((x) => x.id)).toEqual([journeyId([A, B])]);
  });

  it("returns output sorted by id even when the input is unsorted", () => {
    const ab = j([A, B], "Buy");
    const c = j([C], "Pay");
    // Deliberately given with C before AB, whichever order that actually sorts to.
    const input = [c, ab];
    const r = applyJourneyOps(input, [], known);
    const expected = [ab.id, c.id].sort(compare);
    expect(r.journeys.map((x) => x.id)).toEqual(expected);
  });

  it("applies ops in order (create then update the new id)", () => {
    const id = journeyId([D]);
    const r = applyJourneyOps(base(), [{ op: "create", name: "D", chainIds: [D] }, { op: "update", id, name: "Dee" }], known);
    expect(r.created).toEqual([id]);
    expect(r.updated).toEqual([]);
    expect(r.journeys.find((x) => x.id === id)!.name).toBe("Dee");
  });

  it("merge and split keep chain ids that are no longer known (orphaned)", () => {
    const gone = "ch_000000000000";
    const input = [j([gone, A], "Old", { status: "orphaned" }), j([C], "Pay")];
    const r = applyJourneyOps(input, [{ op: "merge", ids: input.map((x) => x.id), name: "M" }], known);
    expect(r.journeys[0]!.chainIds).toEqual([gone, A, C].sort());
  });

  describe("errors name the op index and change nothing", () => {
    it("unknown chain id", () => expectOpError([{ op: "create", name: "X", chainIds: ["ch_999999999999"] }], /ops\[0\]: .*ch_999999999999/));
    it("empty chain list", () => expectOpError([{ op: "create", name: "X", chainIds: [] }], /ops\[0\]: /));
    it("duplicate id on create", () => expectOpError([{ op: "create", name: "X", chainIds: [B, A] }], /ops\[0\]: .*already exists/));
    it("empty name on create", () => expectOpError([{ op: "create", name: "  ", chainIds: [D] }], /ops\[0\]: .*name/));
    it("empty name on update", () => expectOpError([{ op: "update", id: journeyId([C]), name: "" }], /ops\[0\]: .*name/));
    it("unknown journey id on update", () => expectOpError([{ op: "update", id: "j_000000000000", name: "x" }], /ops\[0\]: .*j_000000000000/));
    it("unknown journey id on delete", () => expectOpError([{ op: "delete", id: "j_000000000000" }], /ops\[0\]: .*j_000000000000/));
    it("merge of fewer than 2", () => expectOpError([{ op: "merge", ids: [journeyId([C])], name: "M" }], /ops\[0\]: .*2/));
    it("merge with a repeated id", () => expectOpError([{ op: "merge", ids: [journeyId([C]), journeyId([C])], name: "M" }], /ops\[0\]: /));
    it("merge into an id that exists outside the merge", () => {
      const journeys = [...base(), j([A, B, C], "Existing")];
      expectOpError([{ op: "merge", ids: [journeyId([A, B]), journeyId([C])], name: "M" }], /ops\[0\]: .*already exists/, journeys);
    });
    it("split with fewer than 2 parts", () =>
      expectOpError([{ op: "split", id: journeyId([A, B]), parts: [{ name: "x", chainIds: [A, B] }] }], /ops\[0\]: .*2/));
    it("split with overlapping parts", () =>
      expectOpError([{ op: "split", id: journeyId([A, B]), parts: [{ name: "x", chainIds: [A, B] }, { name: "y", chainIds: [B] }] }], /ops\[0\]: .*more than one part/));
    it("split with the same chain listed twice in one part", () =>
      expectOpError(
        [{ op: "split", id: journeyId([A, B]), parts: [{ name: "x", chainIds: [A, A] }, { name: "y", chainIds: [B] }] }],
        /ops\[0\]: .*chain ch_aaaaaaaaaaaa is listed twice in part 0/,
      ));
    it("split that does not cover every chain", () =>
      expectOpError([{ op: "split", id: journeyId([A, B]), parts: [{ name: "x", chainIds: [A] }, { name: "y", chainIds: [] }] }], /ops\[0\]: /));
    it("split that leaves a chain out", () => {
      const journeys = [j([A, B, C], "Three")];
      expectOpError([{ op: "split", id: journeys[0]!.id, parts: [{ name: "x", chainIds: [A] }, { name: "y", chainIds: [B] }] }], /ops\[0\]: .*not in any part/, journeys);
    });
    it("split part naming a chain outside the journey", () =>
      expectOpError([{ op: "split", id: journeyId([A, B]), parts: [{ name: "x", chainIds: [A] }, { name: "y", chainIds: [B, D] }] }], /ops\[0\]: .*ch_dddddddddddd/));
    it("a later bad op rolls back earlier good ones", () =>
      expectOpError([{ op: "create", name: "D", chainIds: [D] }, { op: "delete", id: "j_000000000000" }], /ops\[1\]: /));
  });
});
