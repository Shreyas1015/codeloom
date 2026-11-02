import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { journeyId } from "../src/linker/chains.js";
import { createServer } from "../src/mcp/server.js";
import { JourneysFileSchema } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

let demo: string;
let client: Client;
let journeysPath: string;
let chains: Array<{ id: string; routeKey: string; entry: string }>;
const SIGNUP = "j_00000000c0de";
const PAY = "j_0000000000aa";

const chainBy = (pred: (c: { routeKey: string; entry: string }) => boolean): string => chains.find(pred)!.id;
let createId: string;
let showId: string;
let payId: string;
let emailId: string;

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sc(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r.structuredContent;
}
function text(r: CallToolResult): string {
  const item = r.content[0];
  if (item?.type !== "text") throw new Error("expected a text item");
  return item.text;
}
const ids = (xs: Array<{ id?: string; chainId?: string }>): string[] => xs.map((x) => x.id ?? x.chainId!);

beforeAll(async () => {
  demo = materializeFixture("demo-shop");
  writeFileSync(
    join(demo, "codeloom.workspace.json"),
    JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
  );
  await runIndex(demo);
  chains = JSON.parse(readFileSync(join(demo, ".codeloom", "chains.json"), "utf8")).chains;
  createId = chainBy((c) => c.routeKey === "api:POST /api/customers");
  showId = chainBy((c) => c.routeKey === "api:GET /api/customers/:id");
  payId = chainBy((c) => c.routeKey === "billing:POST /billing/invoices/:id/pay");
  emailId = chainBy((c) => c.entry.startsWith("consumer:billing:emails#"));
  journeysPath = join(demo, ".codeloom", "journeys.json");
  writeFileSync(
    journeysPath,
    JSON.stringify({
      version: 1,
      journeys: [
        { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" },
        { id: PAY, name: "Pay an invoice", area: "billing", note: "", chainIds: [emailId, payId].sort(), status: "ok" },
      ],
    }),
  );
  const server = createServer({ start: demo });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
}, 60_000);

describe("list_chains", () => {
  it("lists every chain sorted by id with flattened stops and journeys", async () => {
    const r = await sc("list_chains");
    expect(r.total).toBe(chains.length);
    expect(r.truncated).toBe(false);
    expect(ids(r.chains)).toEqual(chains.map((c) => c.id).sort());
    const create = r.chains.find((c: { id: string }) => c.id === createId);
    expect(create).toMatchObject({ routeKey: "api:POST /api/customers", confidence: "exact", complete: true, journeys: [SIGNUP] });
    expect(create.stops[3]).toEqual({
      lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 7, symbol: "CustomersController.store",
      label: "POST /api/customers", op: "POST", confidence: "exact", ref: "api::file:start/routes.ts",
    });
    const viaDi = create.stops.find((s: { reason?: string }) => s.reason === "via di");
    expect(viaDi).toBeDefined();
    expect(text(await call("list_chains"))).toBe(JSON.stringify(r, null, 2));
  });

  it("filters by repo, complete, confidence and unnamed", async () => {
    const web = await sc("list_chains", { repo: "web" });
    expect(web.total).toBe(3);
    for (const c of web.chains) expect(c.stops.some((s: { repo: string }) => s.repo === "web")).toBe(true);
    const incomplete = await sc("list_chains", { complete: false });
    for (const c of incomplete.chains) expect(c.complete).toBe(false);
    expect(incomplete.total).toBeGreaterThan(0);
    const param = await sc("list_chains", { confidence: "param" });
    expect(ids(param.chains)).toEqual([payId]);
    const unnamed = await sc("list_chains", { unnamed: true });
    expect(ids(unnamed.chains)).not.toContain(createId);
    expect(ids(unnamed.chains)).not.toContain(payId);
    expect(unnamed.total).toBe(chains.length - 3);
    const named = await sc("list_chains", { unnamed: false });
    expect(ids(named.chains)).toEqual([createId, emailId, payId].sort());
  });

  it("pages with limit and offset", async () => {
    const all = ids((await sc("list_chains")).chains);
    const page = await sc("list_chains", { limit: 2, offset: 1 });
    expect(page.total).toBe(all.length);
    expect(ids(page.chains)).toEqual(all.slice(1, 3));
    expect(page.truncated).toBe(true);
    const last = await sc("list_chains", { limit: 100, offset: all.length - 1 });
    expect(last.truncated).toBe(false);
    expect(last.chains).toHaveLength(1);
  });

  it("an unknown repo is a tool error", async () => {
    const r = await call("list_chains", { repo: "nope" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/nope/);
  });
});

describe("get_journey", () => {
  it("by journey id: chains, lanes, files, tables", async () => {
    const r = await sc("get_journey", { id: SIGNUP });
    expect(r.journey).toMatchObject({ id: SIGNUP, name: "Sign up a customer", chainIds: [createId] });
    expect(ids(r.chains)).toEqual([createId]);
    expect(r.lanes.ui).toHaveLength(3);
    expect(r.lanes.db.map((s: { label: string }) => s.label)).toEqual(["customers", "audit_logs"]);
    expect(r.files).toContain("api:start/routes.ts");
    expect(r.files).toContain("web:app/customers/new/page.tsx");
    expect(r.files).toEqual([...r.files].sort());
    expect(r.tables).toEqual(["audit_logs", "customers"]);
    expect(r.queues).toEqual([]);
    expect(r.unresolved.length).toBeGreaterThan(0);
    expect(r.unresolved[0].chainId).toBe(createId);
  });

  it("dedupes stops shared by two chains", async () => {
    const r = await sc("get_journey", { id: PAY });
    expect(ids(r.chains)).toEqual([emailId, payId].sort());
    const consume = r.lanes.queue.filter((s: { kind: string }) => s.kind === "consume");
    expect(consume).toHaveLength(1);
    const emailsDb = r.lanes.db.filter((s: { label: string }) => s.label === "email_logs");
    expect(emailsDb).toHaveLength(1);
    expect(r.tables).toEqual(["email_logs", "invoices"]);
    expect(r.queues).toEqual(["billing:invoice.paid", "emails"]);
  });

  it("by chain id: journey null, that chain only", async () => {
    const r = await sc("get_journey", { id: showId });
    expect(r.journey).toBeNull();
    expect(ids(r.chains)).toEqual([showId]);
    expect(r.tables).toEqual(["customers"]);
  });

  it("an unknown id is a tool error", async () => {
    for (const id of ["j_000000000000", "ch_000000000000", "nope"]) {
      const r = await call("get_journey", { id });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(id);
    }
  });
});

describe("trace_route", () => {
  it('"METHOD /path" matches route stops with that method', async () => {
    const r = await sc("trace_route", { from: "POST /api/customers" });
    expect(ids(r.matches)).toEqual([createId]);
    expect(r.matches[0].name).toBeTruthy();
    expect(r.matches[0].stops.length).toBeGreaterThan(0);
    expect(r.truncated).toBe(false);
    expect((await sc("trace_route", { from: "DELETE /api/customers" })).matches).toEqual([]);
  });

  it("normalises {param}, [param] and :param, and accepts concrete values", async () => {
    for (const from of ["/api/customers/{id}", "/api/customers/[id]", "GET /api/customers/:customerId", "/api/customers/42"]) {
      const r = await sc("trace_route", { from });
      expect(ids(r.matches), from).toEqual([showId]);
    }
  });

  it('"/path" also matches page routes', async () => {
    const r = await sc("trace_route", { from: "/customers/[id]" });
    expect(ids(r.matches)).toEqual([showId]);
  });

  // The web page's own route is stored as "/customers/[id]" (Next.js bracket form, straight from the
  // fixture's folder name) — unlike the api route, which is already ":id". Querying it with a concrete
  // value or a colon param only matches because normalisePath also runs on the *stored* stop path inside
  // pathMatches, not just on the query. If normalisePath were the identity function, "[id]" would stay a
  // literal segment and neither query would match: this is the test that would catch that regression.
  it("normalises the stored page route ([id]) against a concrete value or a colon param", async () => {
    for (const from of ["/customers/42", "/customers/:id"]) {
      const r = await sc("trace_route", { from });
      expect(ids(r.matches), from).toEqual([showId]);
    }
  });

  it('"METHOD /path" never matches page stops, only route stops', async () => {
    // The web page lives at "/customers/[id]"; prefixing a method must not fall through to it.
    const withMethod = await sc("trace_route", { from: "GET /customers/[id]" });
    expect(withMethod.matches).toEqual([]);
    // Sanity: the bare path (no method) does match it.
    const bare = await sc("trace_route", { from: "/customers/[id]" });
    expect(ids(bare.matches)).toEqual([showId]);
  });

  it('"table:<name>" and "queue:<name>" match in any repo', async () => {
    expect(ids((await sc("trace_route", { from: "table:customers" })).matches)).toEqual([createId, showId].sort());
    expect(ids((await sc("trace_route", { from: "queue:emails" })).matches)).toEqual([emailId, payId].sort());
    expect(ids((await sc("trace_route", { from: "queue:invoice.paid" })).matches)).toEqual([payId]);
  });

  it('"table:<repo>:<name>" and "queue:<repo>:<name>" restrict matching to that repo', async () => {
    // "customers" only exists as a db stop in the api repo: the repo-qualified form matches the same
    // chains as the bare form, but a different repo qualifier matches nothing.
    expect(ids((await sc("trace_route", { from: "table:api:customers" })).matches)).toEqual([createId, showId].sort());
    expect((await sc("trace_route", { from: "table:billing:customers" })).matches).toEqual([]);
    expect((await sc("trace_route", { from: "table:web:customers" })).matches).toEqual([]);
    // "emails" queue stops are in the billing repo.
    expect(ids((await sc("trace_route", { from: "queue:billing:emails" })).matches)).toEqual([emailId, payId].sort());
    expect((await sc("trace_route", { from: "queue:web:emails" })).matches).toEqual([]);
    // The queue label "billing:invoice.paid" itself contains ":" and happens to start with a real repo id
    // ("billing"): it still matches, because disambiguation only strips a recognised repo id, and the
    // remaining name ("invoice.paid") is a suffix of the label either way.
    expect(ids((await sc("trace_route", { from: "queue:billing:invoice.paid" })).matches)).toEqual([payId]);
  });

  it('accepts the refs `search` returns: "route:<repo>:<METHOD /path>" (that repo only) and "page:<repo>:<route>"', async () => {
    const found = await sc("search", { query: "customers", kinds: ["route", "page"], limit: 100 });
    const refs = (found.results ?? found.matches ?? found.items) as Array<{ ref: string }>;
    expect(refs.map((x) => x.ref)).toEqual(expect.arrayContaining(["route:api:POST /api/customers", "page:web:/customers/:id"]));
    expect(ids((await sc("trace_route", { from: "route:api:POST /api/customers" })).matches)).toEqual([createId]);
    expect((await sc("trace_route", { from: "route:web:POST /api/customers" })).matches).toEqual([]);
    expect(ids((await sc("trace_route", { from: "page:web:/customers/:id" })).matches)).toEqual([showId]);
    // A page ref is limited to its repo, like a route ref.
    expect(ids((await sc("trace_route", { from: "page:api:/customers/:id" })).matches)).toEqual([]);
    expect((await call("trace_route", { from: "route:nope:GET /x" })).isError).toBe(true);
  });

  it('"table:" or "queue:" with a blank name is a tool error', async () => {
    for (const from of ["table:", "queue:", "table: ", "table:api:", "queue:billing:"]) {
      const r = await call("trace_route", { from });
      expect(r.isError, from).toBe(true);
    }
  });

  it("more than 50 matches is capped at 50 with truncated: true", async () => {
    const raw = readFileSync(join(demo, ".codeloom", "chains.json"), "utf8");
    try {
      const file = JSON.parse(raw);
      const extra = Array.from({ length: 60 }, (_, i) => ({
        id: `ch_fff${i.toString(16).padStart(9, "0")}`,
        entry: `queue:api:synthetic#${i}`,
        routeKey: `api:synthetic-${i}`,
        name: `synthetic ${i}`,
        stops: [
          {
            lane: "db",
            kind: "db",
            repo: "api",
            file: "synthetic.ts",
            line: 1,
            symbol: "synthetic",
            label: "customers",
            hop: { confidence: "exact" },
          },
        ],
        unresolved: [],
        confidence: "exact",
        complete: true,
      }));
      file.chains = [...file.chains, ...extra];
      writeFileSync(join(demo, ".codeloom", "chains.json"), JSON.stringify(file, null, 2) + "\n");

      const r = await sc("trace_route", { from: "table:customers" });
      expect(r.matches).toHaveLength(50);
      expect(r.truncated).toBe(true);
      const expectedFirst50 = [...[createId, showId], ...extra.map((c) => c.id)].sort().slice(0, 50);
      expect(ids(r.matches)).toEqual(expectedFirst50);
    } finally {
      writeFileSync(join(demo, ".codeloom", "chains.json"), raw);
    }
  });

  it("a node ref", async () => {
    const r = await sc("trace_route", { from: "api::class:app/services/customer_service.ts:CustomerService" });
    expect(ids(r.matches)).toEqual([createId, showId].sort());
    const file = await sc("trace_route", { from: "api::file:app/services/customer_service.ts" });
    expect(ids(file.matches)).toEqual([createId, showId].sort());
  });

  it("an unparseable `from` is a tool error", async () => {
    for (const from of ["customers", "table:", "nope::file:x.ts"]) {
      const r = await call("trace_route", { from });
      expect(r.isError, from).toBe(true);
    }
  });
});

describe("save_journeys", () => {
  it("bad ops change nothing and return a tool error", async () => {
    const before = readFileSync(journeysPath, "utf8");
    const r = await call("save_journeys", { ops: [{ op: "create", name: "A", chainIds: [showId] }, { op: "delete", id: "j_000000000000" }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/ops\[1\]/);
    expect(readFileSync(journeysPath, "utf8")).toBe(before);
    const empty = await call("save_journeys", { ops: [] });
    expect(empty.isError).toBe(true);
    const badShape = await call("save_journeys", { ops: [{ op: "rename", id: SIGNUP }] });
    expect(badShape.isError).toBe(true);
    expect(readFileSync(journeysPath, "utf8")).toBe(before);
  });

  it("a journeys.json with a duplicate journey id is a clear dataError, nothing written", async () => {
    const before = readFileSync(journeysPath, "utf8");
    try {
      writeFileSync(
        journeysPath,
        JSON.stringify({
          version: 1,
          journeys: [
            { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" },
            { id: SIGNUP, name: "Duplicate", area: "", note: "", chainIds: [showId], status: "ok" },
          ],
        }) + "\n",
      );
      const r = await call("save_journeys", { ops: [{ op: "update", id: SIGNUP, name: "x" }] });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(new RegExp(`duplicate journey id ${SIGNUP} in journeys\\.json.*fix it by hand`));
      expect(readFileSync(journeysPath, "utf8")).toBe(
        JSON.stringify({
          version: 1,
          journeys: [
            { id: SIGNUP, name: "Sign up a customer", area: "customers", note: "", chainIds: [createId], status: "ok" },
            { id: SIGNUP, name: "Duplicate", area: "", note: "", chainIds: [showId], status: "ok" },
          ],
        }) + "\n",
      );
    } finally {
      writeFileSync(journeysPath, before);
    }
  });

  it("writes a valid journeys.json that a following index keeps", async () => {
    const r = await sc("save_journeys", {
      ops: [
        { op: "create", name: "View a customer", area: "customers", chainIds: [showId] },
        { op: "update", id: SIGNUP, note: "from the new-customer form" },
        { op: "split", id: PAY, parts: [{ name: "Pay", chainIds: [payId] }, { name: "Email", chainIds: [emailId] }] },
      ],
    });
    expect(r.created).toEqual([journeyId([showId]), journeyId([payId]), journeyId([emailId])].sort());
    expect(r.updated).toEqual([SIGNUP]);
    expect(r.deleted).toEqual([PAY]);
    const raw = readFileSync(journeysPath, "utf8");
    const file = JourneysFileSchema.parse(JSON.parse(raw));
    expect(file.journeys.map((j) => j.id)).toEqual(r.journeys.map((j: { id: string }) => j.id));
    expect(raw.endsWith("\n")).toBe(true);

    // Fresh read: the next tool call sees the write.
    expect((await sc("get_journey", { id: journeyId([showId]) })).journey.name).toBe("View a customer");

    await runIndex(demo);
    expect(readFileSync(journeysPath, "utf8")).toBe(raw);
  }, 60_000);

  it("a following index only flips status", async () => {
    const parsed = JSON.parse(readFileSync(journeysPath, "utf8"));
    parsed.journeys[0].chainIds = ["ch_000000000000"];
    const withGone = JSON.stringify(parsed, null, 2) + "\n";
    writeFileSync(journeysPath, withGone);
    await runIndex(demo);
    parsed.journeys[0].status = "orphaned";
    expect(readFileSync(journeysPath, "utf8")).toBe(JSON.stringify(parsed, null, 2) + "\n");
  }, 60_000);
});
