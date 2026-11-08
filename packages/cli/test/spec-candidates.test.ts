import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { CodeloomError } from "../src/errors.js";
import {
  buildSpecCandidates, buildTermIndex, journeyTerms, makeDocFilter, makeTicketMatcher, mergeBranch, normalizePath,
  parseGitLog, scanDoc, symbolTermOk, type JourneyTerms,
} from "../src/specs/candidates.js";
import { ticketKeyProblem } from "../src/store/specs.js";
import {
  DEFAULT_TICKET_PATTERN, SpecCandidatesFileSchema, SpecsConfigSchema, ticketPatternProblem, type Chain, type ChainStop, type Journey,
} from "../src/store/schemas.js";
import { gitEnv } from "../src/workspace/git.js";
import { loadWorkspace } from "../src/workspace/repos.js";
import { commitChange, commitTicketHistory, makeRepo, materializeFixture } from "./helpers.js";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const makeDefault = () => SpecsConfigSchema.parse({}).ticketPattern ?? DEFAULT_TICKET_PATTERN;
const L2 = Math.log(2);
const L3 = Math.log(3);

const terms = (t: Partial<JourneyTerms>): JourneyTerms => ({
  journey: "j_000000000001", routes: [], pages: [], tables: [], queues: [], symbols: [], ...t,
});
const hits = (text: string, ...ts: JourneyTerms[]) =>
  scanDoc(text, buildTermIndex(ts)).map((h) => `${h.line} ${h.kind} ${h.term}`);

describe("doc matching (spec §1)", () => {
  it("normalises :param, {param}, [param] and trailing slashes in paths", () => {
    expect(normalizePath("/api/customers/:id")).toBe("/api/customers/:");
    expect(normalizePath("/api/customers/{id}/")).toBe("/api/customers/:");
    expect(normalizePath("/customers/[id]")).toBe("/customers/:");
    expect(normalizePath("/customers/[...slug]")).toBe("/customers/:");
  });

  it("matches a route path as a whole token, with or without its method, params normalised", () => {
    const t = terms({ routes: [{ method: "GET", path: "/api/customers/:id" }, { method: "POST", path: "/api/customers" }] });
    expect(hits([
      "Call `POST /api/customers` to create one.", // 1: method + path
      "See /api/customers/{id} and /api/customers/[id].", // 2: two param forms
      "GET /api/customers lists them.", // 3: other method: not this route
      "/api/customersX and /api/customers/:id/notes", // 4: not whole tokens
      "src/api/customers.ts is a file", // 5: inside a file path
      "Hosted at https://shop.example.com/api/customers today.", // 6: URL path
    ].join("\n"), t)).toEqual([
      "1 route POST /api/customers",
      "2 route /api/customers/:id",
      "2 route /api/customers/:id",
      "6 route /api/customers",
    ]);
  });

  it("matches page paths, tables and queues as whole tokens", () => {
    const t = terms({ pages: ["/customers/new"], tables: ["customers", "audit_logs"], queues: ["invoice.created", "billing:invoice.paid"] });
    expect(hits([
      "Open /customers/new.", // 1
      "Rows go to customers and audit_logs.", // 2
      "Not customers_archive, db.customers or /api/customers.", // 3
      "Events: invoice.created, billing:invoice.paid and invoice.paid.", // 4
      "Customers (capitalised) is prose.", // 5
    ].join("\n"), t)).toEqual([
      "1 page /customers/new",
      "2 table customers",
      "2 table audit_logs",
      "4 queue invoice.created",
      "4 queue billing:invoice.paid",
      "4 queue invoice.paid",
    ]);
  });

  it("matches qualified symbols always and bare names only when >= 6 chars and not built-in", () => {
    const t = terms({ symbols: ["CustomerService.create", "CustomersController.store", "useCreateCustomer", "create", "store", "filter", "fetch"] });
    expect(hits([
      "Calls CustomerService.create() then CustomersController.store.", // 1
      "The hook useCreateCustomer wraps it.", // 2
      "We create, store, filter and fetch.", // 3: built-in or short bare names
    ].join("\n"), t)).toEqual([
      "1 symbol CustomerService.create",
      "1 symbol CustomersController.store",
      "2 symbol useCreateCustomer",
    ]);
  });

  it("derives a journey's terms from its chains' stops and page entry", () => {
    const stop = (s: Partial<ChainStop>): ChainStop => ({
      lane: "code", kind: "function", repo: "api", file: "a.ts", line: 1, symbol: "x", hop: { confidence: "exact" }, ...s,
    });
    const chain: Chain = {
      id: "ch_000000000001", entry: "page:web:/customers/new", routeKey: "api:POST /api/customers", name: "n",
      stops: [
        stop({ lane: "ui", kind: "page", repo: "web", symbol: "NewCustomerPage" }),
        stop({ lane: "ui", kind: "call", repo: "web", symbol: "useCreateCustomer", op: "POST", label: "/api/customers" }),
        stop({ lane: "api", kind: "route", symbol: "CustomersController.store", op: "POST", label: "POST /api/customers" }),
        stop({ kind: "function", symbol: "CustomerService.create" }),
        stop({ lane: "db", kind: "db", symbol: "CustomerService.create", op: "insert", label: "customers" }),
        stop({ lane: "queue", kind: "publish", symbol: "GET /health", op: "publish", label: "billing:invoice.paid" }),
      ],
      unresolved: [], confidence: "exact", complete: true,
    };
    const t = journeyTerms("j_000000000001", [chain]);
    expect(t.routes).toEqual([{ method: "POST", path: "/api/customers" }]);
    expect(t.pages).toEqual(["/customers/new"]);
    expect(t.tables).toEqual(["customers"]);
    expect(t.queues).toEqual(["billing:invoice.paid", "invoice.paid"]);
    expect(t.symbols).toEqual(["CustomerService.create", "CustomersController.store", "NewCustomerPage", "useCreateCustomer"]);
  });
});

describe("symbol terms (final review §7)", () => {
  it("rejects dotted names with a generic receiver or a generic method on a short receiver, and common English words", () => {
    for (const no of ["console.log", "JSON.stringify", "res.json", "router.get", "app.use", "req.body.customer", "request", "response", "service",
      "execute", "validate", "listen", "handler", "controller", "process", "Request", "Service.create"]) {
      expect(symbolTermOk(no), no).toBe(false);
    }
    for (const yes of ["CustomerService.create", "CustomersController.store", "InvoiceService.pay", "useCreateCustomer", "billing.markInvoicePaid"]) {
      expect(symbolTermOk(yes), yes).toBe(true);
    }
  });
});

describe("doc files (spec §1)", () => {
  it("takes docs/**, README*, adr/** and .md/.mdx/.txt, plus extra globs, minus ignoreDocs", () => {
    const f = makeDocFilter({ docs: ["specs/*.rst"], ignoreDocs: ["docs/generated/"] });
    for (const yes of ["docs/a.ts", "README", "pkg/README.md", "x/adr/0001-thing.adoc", "notes.mdx", "a/b.txt", "CHANGELOG.md", "specs/x.rst"]) {
      expect(f(yes), yes).toBe(true);
    }
    for (const no of ["src/a.ts", "specs/x.ts", "docs/generated/api.md", "readme-tool.ts"]) expect(f(no), no).toBe(false);
  });
});

describe("tickets (spec §1)", () => {
  it("finds keys with the default pattern minus ignored prefixes", () => {
    const m = makeTicketMatcher(undefined);
    expect(m("SHOP-12 fix; see SHOP-13, shop-14, UTF-8, CVE-2024-1234, ISO-8601, SHA-256, RFC-7231, SHOP-12")).toEqual(["SHOP-12", "SHOP-13"]);
  });

  it("ignores TC, AC, ADR, QA and ID keys, and keys inside longer tokens (final review §12)", () => {
    const m = makeTicketMatcher(undefined);
    expect(m("SHOP-12 covers TC-1, AC-2, ADR-3, QA-4 and ID-5")).toEqual(["SHOP-12"]);
    expect(m("order ORD-MH-26-001 shipped")).toEqual([]);
    expect(m("x/SHOP-1 a#SHOP-2 b_SHOP-3 c-SHOP-4 SHOP-5x SHOP-6a (SHOP-7) SHOP-8: SHOP-9-fix")).toEqual(["SHOP-7", "SHOP-8", "SHOP-9"]);
    // merge commits: the branch name is matched per / part
    expect(mergeBranch("Merge branch 'feat/SHOP-14-show'")!.split("/").flatMap(m)).toEqual(["SHOP-14"]);
    expect(ticketKeyProblem("MH-26", {})).toBeUndefined(); // a key typed alone is still fine
    expect(ticketKeyProblem("TC-1", {})).toMatch(/ignored/);
  });

  it("refuses slow ticket patterns, long keys and scans only the first 4 KB of a commit (final review §3)", () => {
    for (const bad of ["^(a+)+$", "(a*)*", "(a+)*", "(a*)+", "(?:x[a-z]{2,})+", "(a{2,}){3}", "(\\w+)\\1", "(?<k>A)\\k<k>", "A".repeat(101)]) {
      expect(ticketPatternProblem(bad), bad).toBeDefined();
      expect(SpecsConfigSchema.safeParse({ ticketPattern: bad }).success, bad).toBe(false);
      expect(() => makeTicketMatcher({ ticketPattern: bad }), bad).toThrow(CodeloomError);
    }
    for (const ok of ["#\\d+", "\\bSHOP-\\d+\\b", "(?:SHOP|BILL)-\\d+", "[A-Z]+-\\d+", "(ab)?c+", "([A-Z]+)-\\d+"]) {
      expect(ticketPatternProblem(ok), ok).toBeUndefined();
    }
    // the default pattern passes its own check
    expect(SpecsConfigSchema.safeParse({}).success).toBe(true);
    expect(ticketPatternProblem(makeDefault())).toBeUndefined();
    // a long ref is refused before any regex runs
    const t0 = performance.now();
    expect(ticketKeyProblem(`SHOP-${"1".repeat(100_000)}`, { ticketPattern: "^(?:S|SH|SHO|SHOP)-\\d+$" })).toMatch(/longer than 64/);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(makeTicketMatcher(undefined)(`SHOP-${"1".repeat(80)}`)).toEqual([]);
    expect(makeTicketMatcher(undefined)(`${"x ".repeat(2100)}SHOP-99`)).toEqual([]);
    expect(makeTicketMatcher(undefined)(`${"x ".repeat(100)}SHOP-99`)).toEqual(["SHOP-99"]);
  });

  it("uses the workspace pattern and prefixes when set", () => {
    const m = makeTicketMatcher({ ticketPattern: "#\\d+", ignorePrefixes: [] });
    expect(m("fixes #12 and #7, not SHOP-12")).toEqual(["#12", "#7"]);
    expect(makeTicketMatcher({ ignorePrefixes: ["SHOP"] })("SHOP-12 and BILL-3")).toEqual(["BILL-3"]);
  });

  it("reads branch names from merge commit subjects", () => {
    expect(mergeBranch("Merge branch 'feat/SHOP-14-show'")).toBe("feat/SHOP-14-show");
    expect(mergeBranch("Merge branch 'feat/SHOP-14-show' into main")).toBe("feat/SHOP-14-show");
    expect(mergeBranch("Merge pull request #9 from someone/SHOP-15-pay")).toBe("someone/SHOP-15-pay");
    expect(mergeBranch("Merge remote-tracking branch 'origin/SHOP-16'")).toBe("origin/SHOP-16");
    expect(mergeBranch("SHOP-12 validate")).toBeUndefined();
  });

  it("parses git log records with files", () => {
    const out = "\x1eaaaaaaaaaaaa\x1fp1\x1f20\x1fSHOP-1 one\x1fbody line\n\x1f\n\na.ts\nb.ts\n\x1ebbbbbbbbbbbb\x1fp1 p2\x1f10\x1fMerge branch 'x'\x1f\x1f\n\nc.ts\n";
    expect(parseGitLog(out)).toEqual([
      { sha: "aaaaaaaaaaaa", merge: false, time: 20, subject: "SHOP-1 one", body: "body line\n", files: ["a.ts", "b.ts"] },
      { sha: "bbbbbbbbbbbb", merge: true, time: 10, subject: "Merge branch 'x'", body: "", files: ["c.ts"] },
    ]);
  });
});

describe("workspace specs config", () => {
  it("a bad ticketPattern regex is a data error (exit 2)", () => {
    const root = makeRepo({ "a.ts": "export const a = 1;\n" });
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
      version: 1, name: "x", repos: [{ id: "x", path: "." }], links: [], specs: { ticketPattern: "([A-Z" },
    }));
    let err: unknown;
    try {
      loadWorkspace(root);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodeloomError);
    expect((err as CodeloomError).exitCode).toBe(2);
    expect((err as CodeloomError).message).toMatch(/specs\.ticketPattern/);
  });

  it("passes a valid specs config through", () => {
    const root = makeRepo({ "a.ts": "export const a = 1;\n" });
    const specs = { docs: ["specs/**"], ignoreDocs: ["docs/old/"], ticketPattern: "\\bSHOP-\\d+\\b", ignorePrefixes: ["X"] };
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ version: 1, name: "x", repos: [{ id: "x", path: "." }], links: [], specs }));
    expect(loadWorkspace(root).specs).toEqual(specs);
  });
});

// ---------------------------------------------------------------------------------------------------
// codeloom index on demo-shop
// ---------------------------------------------------------------------------------------------------

function demoShop(): string {
  const root = materializeFixture("demo-shop");
  writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
    version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [],
  }));
  return root;
}

const CREATE = "j_000000000001";
const SHOW = "j_000000000002";

/** Index, then save two journeys (create a customer, show a customer) and index again. */
async function indexWithJourneys(root: string): Promise<void> {
  await runIndex(root);
  const chains = (JSON.parse(readFileSync(join(root, ".codeloom/chains.json"), "utf8")) as { chains: Chain[] }).chains;
  const withRoute = (label: string) => chains.find((c) => c.stops.some((s) => s.kind === "route" && s.label === label) && c.entry.startsWith("page:"))!.id;
  const journeys: Journey[] = [
    { id: CREATE, name: "Create a customer", area: "customers", note: "", chainIds: [withRoute("POST /api/customers")], status: "ok" },
    { id: SHOW, name: "Show a customer", area: "customers", note: "", chainIds: [withRoute("GET /api/customers/:id")], status: "ok" },
  ];
  writeFileSync(join(root, ".codeloom/journeys.json"), JSON.stringify({ version: 1, journeys }, null, 2));
  await runIndex(root);
}

const candidatesFile = (root: string) => join(root, ".codeloom/spec-candidates.json");
const readCandidates = (root: string) => SpecCandidatesFileSchema.parse(JSON.parse(readFileSync(candidatesFile(root), "utf8")));

describe("spec-candidates.json from codeloom index", () => {
  it("is written with an entry per journey even before any journey exists", async () => {
    const root = demoShop();
    await runIndex(root);
    expect(readCandidates(root)).toEqual({ version: 1, journeys: {} });
  });

  it("links docs/customers.md and SHOP keys to the journeys whose stops they touch", async () => {
    const root = demoShop();
    commitTicketHistory(root);
    await indexWithJourneys(root);
    const file = readCandidates(root);
    expect(Object.keys(file.journeys)).toEqual([CREATE, SHOW]);

    const create = file.journeys[CREATE]!;
    expect(create.docs.map((d) => d.ref)).toEqual(["api:docs/customers.md"]);
    const doc = create.docs[0]!;
    expect(doc.evidence).toEqual([
      { kind: "page", term: "/customers/new", file: "docs/customers.md", line: 3 },
      { kind: "route", term: "POST /api/customers", file: "docs/customers.md", line: 3 },
      { kind: "symbol", term: "CustomerService.create", file: "docs/customers.md", line: 5 },
      { kind: "table", term: "customers", file: "docs/customers.md", line: 6 },
      { kind: "table", term: "audit_logs", file: "docs/customers.md", line: 6 },
    ]);
    expect(doc.count).toBe(5);
    // kind weight x rarity log(1 + 2 journeys / journeys using the term): the page, route, symbol and
    // audit_logs are CREATE's own (ln 3); customers is shared with SHOW (ln 2).
    expect(doc.score).toBe(round3(3 * L3 + 3 * L3 + 2 * L3 + 1 * L2 + 1 * L3));
    // SHOP-12 (subject) and SHOP-13 (body) touch CustomerService, SHOP-14 (merged branch name) the
    // controller both journeys use; UTF-8 / CVE are ignored.
    // Each commit touched a file both journeys use (CustomerService, the controller): each weighs 1/2.
    expect(create.tickets.map((t) => [t.ref, t.score])).toEqual([["SHOP-12", 0.5], ["SHOP-13", 0.5], ["SHOP-14", 0.5]]);
    expect(create.tickets[0]!.evidence).toEqual([
      { repo: "api", commit: expect.stringMatching(/^[0-9a-f]{7}$/), file: "app/services/customer_service.ts", subject: "SHOP-12 validate new customers" },
    ]);

    // The show journey reads customers too (table hit) and its controller came in on feat/SHOP-14-show-customer.
    const show = file.journeys[SHOW]!;
    expect(show.docs.map((d) => [d.ref, d.evidence.map((e) => e.term)])).toEqual([["api:docs/customers.md", ["customers"]]]);
    expect(show.tickets.map((t) => t.ref)).toEqual(expect.arrayContaining(["SHOP-14"]));
    expect(show.tickets.find((t) => t.ref === "SHOP-14")!.evidence[0]).toMatchObject({
      file: "app/controllers/customers_controller.ts", subject: "Merge branch 'feat/SHOP-14-show-customer'",
    });
  });

  it("is byte-identical warm and cold, and an unchanged run leaves it untouched", async () => {
    const root = demoShop();
    commitTicketHistory(root);
    await indexWithJourneys(root);
    const warm1 = readFileSync(candidatesFile(root), "utf8");
    const mtime = statSync(candidatesFile(root)).mtimeMs;
    await runIndex(root);
    expect(readFileSync(candidatesFile(root), "utf8")).toBe(warm1);
    expect(statSync(candidatesFile(root)).mtimeMs).toBe(mtime);
    // Cold: drop every per-repo cache and index again.
    for (const repo of ["api", "billing", "web"]) execFileSync("rm", ["-rf", join(root, repo, ".codeloom")]);
    await runIndex(root);
    expect(readFileSync(candidatesFile(root), "utf8")).toBe(warm1);
  });

  it("skips docs over 512 KB and docs in ignored folders, and honours specs.ignoreDocs", async () => {
    const root = demoShop();
    const api = join(root, "api");
    const mention = "Sends POST /api/customers.\n";
    mkdirSync(join(api, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(api, "node_modules/pkg/README.md"), mention);
    mkdirSync(join(api, "docs/old"), { recursive: true });
    writeFileSync(join(api, "docs/old/customers.md"), mention);
    writeFileSync(join(api, "docs/big.md"), mention + "x".repeat(600 * 1024));
    commitChange(api, [], "add docs");
    const ws = JSON.parse(readFileSync(join(root, "codeloom.workspace.json"), "utf8"));
    writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({ ...ws, specs: { ignoreDocs: ["docs/old/"] } }));
    await indexWithJourneys(root);
    expect(readCandidates(root).journeys[CREATE]!.docs.map((d) => d.ref)).toEqual(["api:docs/customers.md"]);
  });

  it("caps each list at 20, sorted by score then ref", () => {
    const root = makeRepo(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [
      `docs/d${String(i).padStart(2, "0")}.md`, i % 2 === 0 ? "POST /api/customers\n" : "customers\n",
    ])));
    const chain: Chain = {
      id: "ch_000000000001", entry: "route:api:POST /api/customers", routeKey: "api:POST /api/customers", name: "n",
      stops: [
        { lane: "api", kind: "route", repo: "api", file: "r.ts", line: 1, symbol: "store", op: "POST", label: "POST /api/customers", hop: { confidence: "exact" } },
        { lane: "db", kind: "db", repo: "api", file: "r.ts", line: 2, symbol: "store", op: "insert", label: "customers", hop: { confidence: "exact" } },
      ],
      unresolved: [], confidence: "exact", complete: true,
    };
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    const out = buildSpecCandidates({
      repos: [{ id: "api", abs: root, files }], chains: [chain],
      journeys: [{ id: CREATE, name: "c", area: "", note: "", chainIds: [chain.id], status: "ok" }],
    });
    const docs = out.journeys[CREATE]!.docs;
    expect(docs).toHaveLength(20);
    expect(docs.slice(0, 13).every((d) => d.score === round3(3 * L2))).toBe(true);
    expect(docs.slice(13).every((d) => d.score === round3(L2))).toBe(true);
    expect(docs.map((d) => d.ref).slice(0, 3)).toEqual(["api:docs/d00.md", "api:docs/d02.md", "api:docs/d04.md"]);
    expect(docs.at(-1)!.ref).toBe("api:docs/d13.md");
  });

  it("builds candidates for a 2,000-file repo with 200 journeys in under 5 s", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1500; i++) files[`src/m${i}/service.ts`] = `export function handler${i}() { return ${i}; }\n`;
    for (let i = 0; i < 500; i++) {
      files[`docs/area${i % 20}/doc${i}.md`] = Array.from({ length: 60 }, (_, l) =>
        `Line ${l}: POST /api/items${(i + l) % 200}/{id} writes items${l % 200} via ItemService${l}.create and handler${(i * l) % 1500}.`).join("\n");
    }
    const root = makeRepo(files);
    for (let c = 0; c < 10; c++) commitChange(root, [`src/m${c * 7}/service.ts`, `src/m${c * 7 + 1}/service.ts`], `SHOP-${c} change ${c}`);
    const chains: Chain[] = Array.from({ length: 200 }, (_, i) => ({
      id: `ch_${String(i).padStart(12, "0")}`, entry: `route:api:POST /api/items${i}/:id`, routeKey: `api:POST /api/items${i}/:id`, name: "n",
      stops: [
        { lane: "api", kind: "route", repo: "api", file: `src/m${i}/service.ts`, line: 1, symbol: `handler${i}`, op: "POST", label: `POST /api/items${i}/:id`, hop: { confidence: "exact" } },
        { lane: "db", kind: "db", repo: "api", file: `src/m${i}/service.ts`, line: 1, symbol: `ItemService${i % 60}.create`, op: "insert", label: `items${i}`, hop: { confidence: "exact" } },
      ],
      unresolved: [], confidence: "exact", complete: true,
    }));
    const journeys: Journey[] = chains.map((c, i) => ({
      id: `j_${String(i).padStart(12, "0")}`, name: `J${i}`, area: "", note: "", chainIds: [c.id], status: "ok",
    }));
    const list = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim().split("\n");
    expect(list).toHaveLength(2000);
    const t0 = performance.now();
    const out = buildSpecCandidates({ repos: [{ id: "api", abs: root, files: list }], chains, journeys });
    const ms = performance.now() - t0;
    console.log(`spec candidates for 2,000 files / 200 journeys: ${Math.round(ms)} ms`);
    // Budget is 5 s on a quiet machine; the bound leaves room for a loaded CI runner.
    expect(ms).toBeLessThan(15_000);
    expect(out.journeys["j_000000000007"]!.docs.length).toBe(20);
    expect(out.journeys["j_000000000007"]!.tickets.map((t) => t.ref)).toEqual(["SHOP-1"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Ranking (final review §8, §11, §13): demo-shop-style Customer / Invoice data
// ---------------------------------------------------------------------------------------------------

const stop = (over: Partial<ChainStop>): ChainStop => ({
  lane: "api", kind: "call", repo: "api", file: "a.ts", line: 1, symbol: "x", hop: { confidence: "exact" }, ...over,
} as ChainStop);

function routeChain(id: string, method: string, path: string, file: string, table: string): Chain {
  return {
    id, entry: `route:api:${method} ${path}`, routeKey: `api:${method} ${path}`, name: "n",
    stops: [
      stop({ kind: "route", file, symbol: "store", op: method, label: `${method} ${path}` }),
      stop({ lane: "db", kind: "db", file, line: 2, symbol: "store", op: "insert", label: table }),
    ],
    unresolved: [], confidence: "exact", complete: true,
  } as Chain;
}

const J_CREATE = "j_000000000011";
const J_SHOW = "j_000000000012";
const J_PAY = "j_000000000013";

describe("ranking (final review §8, §11, §13)", () => {
  it("each journey's own route doc ranks first, above docs that only name a shared table", () => {
    const root = makeRepo({
      "app/controllers/customers_controller.ts": "export const store = 1;\n",
      "app/controllers/customer_show.ts": "export const show = 1;\n",
      "docs/create.md": "# Create\n\nPOST /api/customers writes the customers table.\n",
      "docs/show.md": "# Show\n\nGET /api/customers/:id reads the customers table.\n",
      "docs/schema.md": Array.from({ length: 30 }, () => "customers").join("\n") + "\n",
    });
    const chains = [
      routeChain("ch_000000000011", "POST", "/api/customers", "app/controllers/customers_controller.ts", "customers"),
      routeChain("ch_000000000012", "GET", "/api/customers/:id", "app/controllers/customer_show.ts", "customers"),
    ];
    const journeys: Journey[] = [
      { id: J_CREATE, name: "Create a customer", area: "customers", note: "", chainIds: [chains[0]!.id], status: "ok" },
      { id: J_SHOW, name: "Show a customer", area: "customers", note: "", chainIds: [chains[1]!.id], status: "ok" },
    ];
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    const out = buildSpecCandidates({ repos: [{ id: "api", abs: root, files }], chains, journeys });
    expect(out.journeys[J_CREATE]!.docs[0]!.ref).toBe("api:docs/create.md");
    expect(out.journeys[J_SHOW]!.docs[0]!.ref).toBe("api:docs/show.md");
    // schema.md names customers 30 times, but only a shared table: below every doc with a route hit
    const createDocs = out.journeys[J_CREATE]!.docs;
    expect(createDocs.map((d) => d.ref)).toEqual(["api:docs/create.md", "api:docs/schema.md", "api:docs/show.md"]);
    expect(createDocs.find((d) => d.ref === "api:docs/schema.md")!.score).toBeGreaterThan(createDocs[0]!.score);
  });

  it("a ticket whose commits touch only this journey outranks one whose commits touch every journey", () => {
    const root = makeRepo({
      "app/controllers/customers_controller.ts": "export const store = 1;\n",
      "app/controllers/customer_show.ts": "export const show = 1;\n",
      "app/controllers/invoices_controller.ts": "export const pay = 1;\n",
    });
    const all = ["app/controllers/customers_controller.ts", "app/controllers/customer_show.ts", "app/controllers/invoices_controller.ts"];
    // SHOP-1 touches every journey's files, twice; SHOP-2 only the create controller, once.
    commitChange(root, all, "SHOP-1 lint every controller");
    commitChange(root, all, "SHOP-1 rename helpers");
    commitChange(root, ["app/controllers/customers_controller.ts"], "SHOP-2 validate new customers");
    const chains = [
      routeChain("ch_000000000011", "POST", "/api/customers", all[0]!, "customers"),
      routeChain("ch_000000000012", "GET", "/api/customers/:id", all[1]!, "customers"),
      routeChain("ch_000000000013", "POST", "/billing/invoices/:id/pay", all[2]!, "invoices"),
    ];
    const journeys: Journey[] = chains.map((c, i) => ({ id: [J_CREATE, J_SHOW, J_PAY][i]!, name: "j", area: "", note: "", chainIds: [c.id], status: "ok" }));
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    const out = buildSpecCandidates({ repos: [{ id: "api", abs: root, files }], chains, journeys });
    expect(out.journeys[J_CREATE]!.tickets.map((t) => [t.ref, t.score, t.count])).toEqual([["SHOP-2", 1, 1], ["SHOP-1", round3(2 / 3), 2]]);
    expect(out.journeys[J_SHOW]!.tickets.map((t) => t.ref)).toEqual(["SHOP-1"]);
  });

  it("a git log bigger than the buffer skips that repo's tickets with a note, never silently", () => {
    const root = makeRepo({ "app/controllers/customers_controller.ts": "export const store = 1;\n" });
    for (let i = 0; i < 5; i++) commitChange(root, ["app/controllers/customers_controller.ts"], `SHOP-${i} change ${i}`);
    const chains = [routeChain("ch_000000000011", "POST", "/api/customers", "app/controllers/customers_controller.ts", "customers")];
    const journeys: Journey[] = [{ id: J_CREATE, name: "j", area: "", note: "", chainIds: [chains[0]!.id], status: "ok" }];
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split("\n");
    const notes: string[] = [];
    const out = buildSpecCandidates({ repos: [{ id: "api", abs: root, files }], chains, journeys, notes, gitMaxBuffer: 64 });
    expect(out.journeys[J_CREATE]!.tickets).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/git history of api is too big/);
    const full: string[] = [];
    expect(buildSpecCandidates({ repos: [{ id: "api", abs: root, files }], chains, journeys, notes: full }).journeys[J_CREATE]!.tickets).toHaveLength(5);
    expect(full).toEqual([]);
    // git never fetches missing objects of a partial clone
    expect(gitEnv().GIT_NO_LAZY_FETCH).toBe("1");
  });
});
