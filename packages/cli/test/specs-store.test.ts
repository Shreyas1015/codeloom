import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodeloomError } from "../src/errors.js";
import {
  DEFAULT_IGNORE_PREFIXES,
  DEFAULT_TICKET_PATTERN,
  readSpecCandidates,
  readSpecsConfig,
  type SpecCandidatesFile,
} from "../src/store/spec-candidates.js";
import { readSpecs, saveSpecLinks, specState, specsPath, ticketKeyProblem } from "../src/store/specs.js";

const J1 = "j_0000000000a1";
const J2 = "j_0000000000a2";

/** A workspace root with one repo folder "shop-api" holding docs/customers.md. */
function ws(): { root: string; repos: Array<{ ref: { id: string }; abs: string }> } {
  const root = mkdtempSync(join(tmpdir(), "codeloom-specs-"));
  const api = join(root, "api");
  mkdirSync(join(api, "docs"), { recursive: true });
  writeFileSync(join(api, "docs", "customers.md"), "# Customers\n\nPOST /api/customers creates a customer.\n");
  mkdirSync(join(api, ".codeloom"), { recursive: true });
  writeFileSync(join(api, ".codeloom", "graph.json"), "{}");
  return { root, repos: [{ ref: { id: "shop-api" }, abs: api }] };
}

const NOW = new Date("2026-11-08T10:00:00.000Z");
const LATER = new Date("2026-11-09T10:00:00.000Z");

describe("specs.json store", () => {
  it("missing file reads as no entries", () => {
    expect(readSpecs(ws().root)).toEqual({ version: 1, journeys: {} });
  });

  it("saves doc and ticket links sorted, sets checkedAt, keeps other journeys", () => {
    const w = ws();
    saveSpecLinks(w, J2, [], { now: NOW });
    const entry = saveSpecLinks(
      w,
      J1,
      [
        { kind: "ticket", ref: "SHOP-12", reason: "Adds the customer form." },
        { kind: "doc", ref: "shop-api:docs/customers.md", reason: "Describes POST /api/customers." },
      ],
      { now: NOW },
    );
    expect(entry.checkedAt).toBe(NOW.toISOString());
    expect(entry.links.map((l) => l.ref)).toEqual(["shop-api:docs/customers.md", "SHOP-12"]);
    const file = readSpecs(w.root);
    expect(Object.keys(file.journeys)).toEqual([J1, J2]);
    expect(file.journeys[J2]).toEqual({ links: [], checkedAt: NOW.toISOString() });
    // deterministic: sorted keys, trailing newline
    const text = readFileSync(specsPath(w.root), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.indexOf('"journeys"')).toBeLessThan(text.indexOf('"version"'));
  });

  it("re-saving keeps savedAt of an unchanged link and stamps a changed one", () => {
    const w = ws();
    saveSpecLinks(w, J1, [{ kind: "ticket", ref: "SHOP-12", reason: "a" }, { kind: "ticket", ref: "SHOP-13", reason: "b" }], { now: NOW });
    const e = saveSpecLinks(w, J1, [{ kind: "ticket", ref: "SHOP-12", reason: "a" }, { kind: "ticket", ref: "SHOP-13", reason: "changed" }], { now: LATER });
    expect(e.links.map((l) => l.savedAt)).toEqual([NOW.toISOString(), LATER.toISOString()]);
    expect(e.checkedAt).toBe(LATER.toISOString());
  });

  it("rejects bad doc refs, bad ticket keys, duplicates and bad journey ids, writing nothing", () => {
    const w = ws();
    const bad: Array<[string, unknown[]]> = [
      ["unknown repo", [{ kind: "doc", ref: "nope:docs/customers.md", reason: "x" }]],
      ["missing file", [{ kind: "doc", ref: "shop-api:docs/ghost.md", reason: "x" }]],
      ["outside repo", [{ kind: "doc", ref: "shop-api:../secret.md", reason: "x" }]],
      ["no repo part", [{ kind: "doc", ref: "docs/customers.md", reason: "x" }]],
      [".codeloom file", [{ kind: "doc", ref: "shop-api:.codeloom/graph.json", reason: "x" }]],
      ["a folder", [{ kind: "doc", ref: "shop-api:docs", reason: "x" }]],
      ["lowercase key", [{ kind: "ticket", ref: "shop-12", reason: "x" }]],
      ["ignored prefix", [{ kind: "ticket", ref: "CVE-2024", reason: "x" }]],
      ["empty reason", [{ kind: "ticket", ref: "SHOP-12", reason: "" }]],
      ["long reason", [{ kind: "ticket", ref: "SHOP-12", reason: "x".repeat(501) }]],
      ["unknown kind", [{ kind: "wiki", ref: "SHOP-12", reason: "x" }]],
      ["duplicate", [{ kind: "ticket", ref: "SHOP-12", reason: "x" }, { kind: "ticket", ref: "SHOP-12", reason: "y" }]],
    ];
    for (const [what, links] of bad) {
      expect(() => saveSpecLinks(w, J1, links as never, { now: NOW }), what).toThrow(CodeloomError);
    }
    expect(() => saveSpecLinks(w, "j_bad", [], { now: NOW })).toThrow(/journey id/);
    expect(readSpecs(w.root).journeys).toEqual({});
  });

  it("uses the workspace ticket pattern and ignore list", () => {
    const w = ws();
    const cfg = { ticketPattern: "#\\d+", ignorePrefixes: [] };
    expect(ticketKeyProblem("#42", cfg)).toBeUndefined();
    expect(ticketKeyProblem("SHOP-12", cfg)).toMatch(/pattern/);
    expect(ticketKeyProblem("SHOP-12", {})).toBeUndefined();
    expect(ticketKeyProblem("RFC-7231", {})).toMatch(/ignored/);
    expect(ticketKeyProblem("RFC-7231", { ignorePrefixes: [] })).toBeUndefined();
    expect(ticketKeyProblem("xSHOP-12", {})).toMatch(/pattern/);
    expect(saveSpecLinks(w, J1, [{ kind: "ticket", ref: "#42", reason: "x" }], { now: NOW, config: cfg }).links).toHaveLength(1);
  });

  it("a broken specs.json is an error, never overwritten", () => {
    const w = ws();
    mkdirSync(join(w.root, ".codeloom"), { recursive: true });
    writeFileSync(specsPath(w.root), "{ nope");
    expect(() => readSpecs(w.root)).toThrow(/not valid JSON[\s\S]*by hand/);
    expect(() => saveSpecLinks(w, J1, [], { now: NOW })).toThrow(CodeloomError);
    expect(readFileSync(specsPath(w.root), "utf8")).toBe("{ nope");
  });

  it("specState: linked, candidates, none, and whether it was checked", () => {
    const link = { kind: "ticket" as const, ref: "SHOP-12", reason: "x", savedAt: NOW.toISOString() };
    const cands = { docs: [{ ref: "a:b.md", score: 3, count: 1, evidence: [] }], tickets: [] };
    expect(specState({ links: [link], checkedAt: NOW.toISOString() }, cands)).toEqual({ state: "linked", checked: true });
    expect(specState(undefined, cands)).toEqual({ state: "candidates", checked: false });
    expect(specState({ links: [], checkedAt: NOW.toISOString() }, cands)).toEqual({ state: "none", checked: true });
    expect(specState(undefined, undefined)).toEqual({ state: "none", checked: false });
    expect(specState(undefined, { docs: [], tickets: [] })).toEqual({ state: "none", checked: false });
  });
});

describe("spec-candidates.json and the workspace specs config", () => {
  it("reads a valid candidates file; missing is null; a bad one is an error", () => {
    const w = ws();
    expect(readSpecCandidates(w.root)).toBeNull();
    const file: SpecCandidatesFile = {
      version: 1,
      journeys: {
        [J1]: {
          docs: [{ ref: "shop-api:docs/customers.md", score: 3, count: 1, evidence: [{ kind: "route", term: "POST /api/customers", file: "docs/customers.md", line: 3 }] }],
          tickets: [{ ref: "SHOP-12", score: 1, count: 1, evidence: [{ commit: "abc1234", file: "app/customers.ts", subject: "SHOP-12 add customers" }] }],
        },
      },
    };
    mkdirSync(join(w.root, ".codeloom"), { recursive: true });
    writeFileSync(join(w.root, ".codeloom", "spec-candidates.json"), JSON.stringify(file));
    expect(readSpecCandidates(w.root)).toEqual(file);
    writeFileSync(join(w.root, ".codeloom", "spec-candidates.json"), JSON.stringify({ version: 1, journeys: { [J1]: { docs: "x" } } }));
    expect(() => readSpecCandidates(w.root)).toThrow(CodeloomError);
  });

  it("reads specs config from the workspace file, with defaults; a bad regex is a data error", () => {
    const w = ws();
    expect(readSpecsConfig(w.root)).toEqual({ ticketPattern: DEFAULT_TICKET_PATTERN, ignorePrefixes: DEFAULT_IGNORE_PREFIXES });
    const wsFile = { version: 1, name: "shop", repos: [{ id: "shop-api", path: "api" }], links: [], specs: { ticketPattern: "SHOP-\\d+" } };
    writeFileSync(join(w.root, "codeloom.workspace.json"), JSON.stringify(wsFile));
    expect(readSpecsConfig(w.root).ticketPattern).toBe("SHOP-\\d+");
    writeFileSync(join(w.root, "codeloom.workspace.json"), JSON.stringify({ ...wsFile, specs: { ticketPattern: "([" } }));
    expect(() => readSpecsConfig(w.root)).toThrow(/ticketPattern/);
  });
});
