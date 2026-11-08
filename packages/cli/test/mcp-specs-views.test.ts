// v0.3 Task 2: the spec-link and view MCP tools (match_specs, save_spec_links, list_specs, save_view,
// list_views, delete_view) and the match-specs / make-view prompts, on demo-shop (Customer / Invoice).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { createServer } from "../src/mcp/server.js";
import type { SpecCandidatesFile } from "../src/store/spec-candidates.js";
import { readSpecs } from "../src/store/specs.js";
import { readView, viewPath } from "../src/store/views.js";
import { materializeFixture } from "./helpers.js";

const SIGNUP = "j_00000000c0de";
const PAY = "j_0000000000aa";
const GONE = "j_00000000dead";

let demo: string;
let client: Client;

const DOC = [
  "# Customers",
  "",
  "Signing up a customer:",
  "",
  "1. The form posts to POST /api/customers.",
  "2. The handler writes a row to the customers table.",
  "3. The new customer gets a welcome email.",
  "",
  "That is all.",
  "",
].join("\n");

const CANDIDATES: SpecCandidatesFile = {
  version: 1,
  journeys: {
    [SIGNUP]: {
      docs: [
        {
          ref: "api:docs/signup.md",
          score: 5,
          count: 2,
          evidence: [
            { kind: "route", term: "POST /api/customers", file: "docs/signup.md", line: 5 },
            { kind: "table", term: "customers", file: "docs/signup.md", line: 6 },
          ],
        },
        { ref: "api:docs/gone.md", score: 1, count: 1, evidence: [{ kind: "symbol", term: "CustomersController.store", file: "docs/gone.md", line: 1 }] },
      ],
      tickets: [{ ref: "SHOP-12", score: 2, count: 2, evidence: [{ repo: "api", commit: "abc1234", file: "app/controllers/customers_controller.ts", subject: "SHOP-12 sign up customers" }] }],
    },
    [PAY]: { docs: [], tickets: [] },
  },
};

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  mkdirSync(join(demo, "api", "docs"), { recursive: true });
  writeFileSync(join(demo, "api", "docs", "signup.md"), DOC);
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
  const server = createServer({ start: demo });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  client = new Client({ name: "specs", version: "0.0.0" });
  await client.connect(c);
}, 120_000);

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function ok<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent as T;
}

async function err(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await call(name, args);
  expect(r.isError, `${name} ${JSON.stringify(args)} should fail`).toBe(true);
  return (r.content[0] as { text: string }).text;
}

const candidatesPath = () => join(demo, ".codeloom", "spec-candidates.json");

describe("specs", () => {
  it("match_specs without a candidates file says to run codeloom index", async () => {
    rmSync(candidatesPath(), { force: true }); // codeloom index writes it; this case is a workspace without one
    const r = await ok<{ docs: unknown[]; tickets: unknown[]; notes: string[]; state: string; checked: boolean }>("match_specs", { journey: SIGNUP });
    expect(r.docs).toEqual([]);
    expect(r.tickets).toEqual([]);
    expect(r.state).toBe("none");
    expect(r.checked).toBe(false);
    expect(r.notes.join(" ")).toMatch(/codeloom index/);
  });

  it("match_specs returns candidates with evidence and ±3-line snippets", async () => {
    writeFileSync(candidatesPath(), JSON.stringify(CANDIDATES));
    const r = await ok<{
      journey: { id: string; name: string };
      state: string;
      docs: Array<{ ref: string; repo: string; file: string; evidence: Array<{ line: number; snippet: { startLine: number; endLine: number; text: string } | null }> }>;
      tickets: Array<{ ref: string; evidence: Array<{ commit: string }> }>;
      ticketPattern: string;
    }>("match_specs", { journey: SIGNUP });
    expect(r.journey).toMatchObject({ id: SIGNUP, name: "Sign up a customer" });
    expect(r.state).toBe("candidates");
    expect(r.docs.map((d) => d.ref)).toEqual(["api:docs/signup.md", "api:docs/gone.md"]);
    expect(r.docs[0]).toMatchObject({ repo: "api", file: "docs/signup.md" });
    const snip = r.docs[0]!.evidence[0]!.snippet!;
    expect(snip).toMatchObject({ startLine: 2, endLine: 8 });
    expect(snip.text).toContain("POST /api/customers");
    expect(snip.text.split("\n")).toHaveLength(7);
    // a doc that is gone has no snippet, never an error
    expect(r.docs[1]!.evidence[0]!.snippet).toBeNull();
    expect(r.tickets[0]).toMatchObject({ ref: "SHOP-12", evidence: [{ commit: "abc1234" }] });
    expect(r.ticketPattern).toBeTruthy();
    await err("match_specs", { journey: "j_000000000000" });
    await err("match_specs", { journey: "nope" });
  });

  it("save_spec_links saves, list_specs reports state and coverage", async () => {
    writeFileSync(candidatesPath(), JSON.stringify(CANDIDATES));
    const saved = await ok<{ journeyId: string; links: Array<{ ref: string; savedAt: string }>; checkedAt: string; replaced: boolean; path: string }>(
      "save_spec_links",
      { journey: SIGNUP, links: [{ kind: "doc", ref: "api:docs/signup.md", reason: "Describes signing up a customer." }, { kind: "ticket", ref: "SHOP-12", reason: "Built the sign-up flow." }] },
    );
    expect(saved).toMatchObject({ journeyId: SIGNUP, replaced: false, path: ".codeloom/specs.json" });
    expect(saved.links.map((l) => l.ref)).toEqual(["api:docs/signup.md", "SHOP-12"]);
    expect(readSpecs(demo).journeys[SIGNUP]!.links).toHaveLength(2);

    type Row = { journeyId: string; state: string; checked: boolean; repos: string[]; links: unknown[]; candidates: { docs: number; tickets: number } };
    type Cov = { total: number; linked: number; candidates: number; none: number; checked: number };
    const all = await ok<{ journeys: Row[]; totals: { all: Cov; byRepo: Record<string, Cov>; byArea: Record<string, Cov> }; candidatesIndexed: boolean }>("list_specs");
    expect(all.candidatesIndexed).toBe(true);
    const byId = Object.fromEntries(all.journeys.map((j) => [j.journeyId, j]));
    expect(byId[SIGNUP]).toMatchObject({ state: "linked", checked: true, candidates: { docs: 2, tickets: 1 } });
    expect(byId[PAY]).toMatchObject({ state: "none", checked: false });
    expect(all.totals.all).toEqual({ total: 2, linked: 1, candidates: 0, none: 1, checked: 1 });
    expect(all.totals.byArea.customers).toEqual({ total: 1, linked: 1, candidates: 0, none: 0, checked: 1 });
    expect(Object.keys(all.totals.byRepo).sort()).toEqual(["api", "billing", "web"]);

    // confirmed none
    expect((await ok<{ replaced: boolean }>("save_spec_links", { journey: PAY, links: [] })).replaced).toBe(false);
    const billing = await ok<{ journeys: Row[] }>("list_specs", { area: "billing" });
    expect(billing.journeys.map((j) => [j.journeyId, j.state, j.checked])).toEqual([[PAY, "none", true]]);
    const api = await ok<{ journeys: Row[] }>("list_specs", { repo: "api" });
    expect(api.journeys.map((j) => j.journeyId)).toContain(SIGNUP);
    await err("list_specs", { repo: "nope" });
  });

  it("save_spec_links rejects bad links and unknown journeys, writing nothing", async () => {
    const before = readFileSync(join(demo, ".codeloom", "specs.json"), "utf8");
    await err("save_spec_links", { journey: SIGNUP, links: [{ kind: "doc", ref: "api:docs/ghost.md", reason: "x" }] });
    await err("save_spec_links", { journey: SIGNUP, links: [{ kind: "ticket", ref: "not a key", reason: "x" }] });
    await err("save_spec_links", { journey: SIGNUP, links: [{ kind: "ticket", ref: "SHOP-12", reason: "" }] });
    await err("save_spec_links", { journey: "j_000000000000", links: [] });
    await err("save_spec_links", { journey: SIGNUP });
    expect(readFileSync(join(demo, ".codeloom", "specs.json"), "utf8")).toBe(before);
  });

  it("an entry for a journey that no longer exists is listed under olderJourneys", async () => {
    const specs = JSON.parse(readFileSync(join(demo, ".codeloom", "specs.json"), "utf8"));
    specs.journeys[GONE] = { links: [{ kind: "ticket", ref: "SHOP-9", reason: "old", savedAt: "2026-11-01T00:00:00.000Z" }], checkedAt: "2026-11-01T00:00:00.000Z" };
    writeFileSync(join(demo, ".codeloom", "specs.json"), JSON.stringify(specs));
    const r = await ok<{ olderJourneys: Array<{ journeyId: string; links: unknown[] }>; journeys: Array<{ journeyId: string }> }>("list_specs");
    expect(r.olderJourneys.map((o) => o.journeyId)).toEqual([GONE]);
    expect(r.journeys.map((j) => j.journeyId)).not.toContain(GONE);
  });
});

describe("views", () => {
  const audit = {
    id: "no-spec-audit",
    title: "No-spec audit",
    widgets: [
      { type: "specCoverage", by: "area" },
      { type: "journeys", filter: { spec: "none" }, sort: "area" },
      { type: "map", repo: "api", overlay: `journey:${SIGNUP}` },
    ],
  };

  it("save_view writes the view and returns its dashboard link", async () => {
    const r = await ok<{ id: string; url: string; path: string; replaced: boolean; widgets: number }>("save_view", { view: audit });
    expect(r).toEqual({ id: "no-spec-audit", url: "/views/no-spec-audit", path: ".codeloom/views/no-spec-audit.json", replaced: false, widgets: 3 });
    expect(readView(demo, "no-spec-audit")?.title).toBe("No-spec audit");
    expect((await ok<{ replaced: boolean }>("save_view", { view: audit })).replaced).toBe(true);
    const home = await ok<{ url: string }>("save_view", { view: { id: "home", title: "Home", widgets: [{ type: "counts" }] } });
    expect(home.url).toBe("/");
  });

  it("save_view rejects unknown widgets, repos and journeys, writing nothing", async () => {
    expect(await err("save_view", { view: { ...audit, id: "bad-1", widgets: [{ type: "chart" }] } })).toMatch(/widgets/);
    expect(await err("save_view", { view: { ...audit, id: "bad-2", widgets: [{ type: "map", repo: "nope" }] } })).toMatch(/Unknown repo "nope"/);
    expect(await err("save_view", { view: { ...audit, id: "bad-3", widgets: [{ type: "map", repo: "api", overlay: "journey:j_000000000000" }] } })).toMatch(/Unknown journey/);
    expect(await err("save_view", { view: { ...audit, id: "bad-4", widgets: [{ type: "journeys", filter: { repo: "nope" } }] } })).toMatch(/Unknown repo/);
    await err("save_view", { view: { ...audit, id: "Bad Id" } });
    for (const id of ["bad-1", "bad-2", "bad-3", "bad-4"]) expect(existsSync(viewPath(demo, id))).toBe(false);
  });

  it("list_views lists every view, broken ones with their error", async () => {
    writeFileSync(viewPath(demo, "broken"), "{}");
    const r = await ok<{ views: Array<{ id: string; url: string; title?: string; widgets?: number; error?: string }> }>("list_views");
    expect(r.views.map((v) => v.id)).toEqual(["broken", "home", "no-spec-audit"]);
    expect(r.views[0]).toMatchObject({ id: "broken", url: "/views/broken", error: expect.stringMatching(/unexpected shape/) });
    expect(r.views[1]).toMatchObject({ id: "home", url: "/", title: "Home", widgets: 1 });
  });

  it("delete_view removes a view; never home; unknown is an error", async () => {
    expect(await ok("delete_view", { id: "broken" })).toEqual({ id: "broken", deleted: true });
    expect(existsSync(viewPath(demo, "broken"))).toBe(false);
    expect(await err("delete_view", { id: "home" })).toMatch(/codeloom views reset home/);
    expect(existsSync(viewPath(demo, "home"))).toBe(true);
    await err("delete_view", { id: "broken" });
    await err("delete_view", { id: "../x" });
  });
});

describe("prompts", () => {
  const text = (r: GetPromptResult) => (r.messages[0]!.content as { text: string }).text;

  it("match-specs: one journey, or every unchecked one", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.find((p) => p.name === "match-specs")!.arguments).toEqual([{ name: "journey", description: expect.any(String), required: false }]);
    const one = text(await client.getPrompt({ name: "match-specs", arguments: { journey: SIGNUP } }));
    expect(one).toContain(SIGNUP);
    expect(one).toMatch(/match_specs[\s\S]*explain_context[\s\S]*save_spec_links/);
    expect(one).toMatch(/Never invent/);
    expect(one).toMatch(/links: \[\]/);
    const all = text(await client.getPrompt({ name: "match-specs", arguments: {} }));
    expect(all).toMatch(/list_specs/);
    expect(all).toMatch(/checked: false/);
    const none = text(await client.getPrompt({ name: "match-specs" }));
    expect(none).toBe(all);
  });

  it("make-view: request in, widget set, save_view, the /views link out", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.find((p) => p.name === "make-view")!.arguments).toEqual([{ name: "request", description: expect.any(String), required: true }]);
    const t = text(await client.getPrompt({ name: "make-view", arguments: { request: "customer journeys with no spec" } }));
    expect(t).toContain("customer journeys with no spec");
    for (const w of ["counts", "journeys", "map", "progress", "checks", "specCoverage", "note"]) expect(t).toContain(`\`${w}\``);
    expect(t).toMatch(/save_view/);
    expect(t).toContain("/views/<id>");
    await expect(client.getPrompt({ name: "make-view", arguments: {} })).rejects.toThrow();
  });
});
