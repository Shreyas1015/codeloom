import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { KnowledgeGraph } from "@codeloom/core";
import { callPathWithClient, linkUi, proxyPathFor, resolveProxyTargets, routeCandidatesByRepo } from "../src/linker/link.js";
import { effectiveRoutes } from "../src/linker/mounts.js";
import { runIndex } from "../src/commands/index-cmd.js";
import type { RepoData, WorkspaceData } from "../src/store/read.js";
import { ChainsFileSchema, type ChainsFile, type EndpointsFile, type HttpCall, type HttpClient, type ProxyRule } from "../src/store/schemas.js";
import { materializeFixture } from "./helpers.js";

// Task 4 (spec §4): workspace `proxies` — a UI call through a backend-for-frontend proxy route also
// matches the named repo's routes, so the chain continues into its handler and tables.

function graphStub(): KnowledgeGraph {
  return {
    version: "1",
    project: { name: "x", languages: [], frameworks: [], description: "", analyzedAt: "", gitCommitHash: "" },
    nodes: [], edges: [], layers: [], tour: [],
  };
}

function endpoints(repo: string, partial: Partial<EndpointsFile>): EndpointsFile {
  return {
    version: 2, repo, pages: [], httpCalls: [], httpClients: [], routes: [], mounts: [],
    dbAccess: [], tables: [], models: [], queues: [], ...partial,
  };
}

function repo(id: string, ep: Partial<EndpointsFile>, proxies?: ProxyRule[]): RepoData {
  return { ref: { id, path: id, ...(proxies ? { proxies } : {}) }, abs: `/ws/${id}`, graph: graphStub(), endpoints: endpoints(id, ep) };
}

function ws(repos: RepoData[]): WorkspaceData {
  return { root: "/ws", name: "ws", repos, links: [] };
}

function call(partial: Partial<HttpCall> = {}): HttpCall {
  return {
    method: "GET", path: "/api/core/customers/42", raw: "x", resolved: true, client: "fetch",
    at: { file: "lib/x.ts", line: 1, symbol: "f" }, kind: "literal", ...partial,
  };
}

describe("proxyPathFor", () => {
  it("strips the prefix by default", () => {
    expect(proxyPathFor("/api/core/customers/42", { from: "/api/core" })).toBe("/customers/42");
  });

  it("strips down to the root when the call is exactly the prefix", () => {
    expect(proxyPathFor("/api/core", { from: "/api/core" })).toBe("/");
  });

  it("keeps the full path when stripPrefix is false", () => {
    expect(proxyPathFor("/api/core/customers/42", { from: "/api/core", stripPrefix: false })).toBe("/api/core/customers/42");
  });

  it("trims a trailing slash from `from`", () => {
    expect(proxyPathFor("/api/core/x", { from: "/api/core/" })).toBe("/x");
  });

  // Review fix 5: the schema now requires `from` to start with "/" (no more silent "api/core" ->
  // "/api/core" correction) — a `from` with no leading slash (which the schema would reject on load)
  // simply never matches, here at the pure-function level.
  it("never matches when `from` has no leading slash (no silent normalisation)", () => {
    expect(proxyPathFor("/api/core/x", { from: "api/core" })).toBeUndefined();
  });

  it("never matches a different prefix sharing the same text (segment boundary)", () => {
    expect(proxyPathFor("/api/core-x/customers/42", { from: "/api/core" })).toBeUndefined();
  });

  it("does not match when the call's URL does not start with the prefix at all", () => {
    expect(proxyPathFor("/other/thing", { from: "/api/core" })).toBeUndefined();
  });
});

const UNRESOLVED = { kind: "unresolved" as const, reason: "no matching route" };
const EXTERNAL_TARGET = { kind: "external" as const, base: "api.stripe.com" };

describe("resolveProxyTargets", () => {
  const apiRoute: EndpointsFile["routes"][number] = {
    method: "GET", path: "/customers/:id", handler: "CustomersController.show", inline: false,
    framework: "adonis", at: { file: "app/controllers/customers_controller.ts", line: 5, symbol: "CustomersController.show" },
  };
  const candidatesByRepo = routeCandidatesByRepo(new Map([["api", effectiveRoutes(endpoints("api", { routes: [apiRoute] }))]]));

  it("matches the stripped path against the named repo's routes, param confidence", () => {
    const targets = resolveProxyTargets(call(), { id: "web", path: "web", proxies: [{ from: "/api/core", to: "api" }] }, [], candidatesByRepo, UNRESOLVED);
    expect(targets).toEqual([{ kind: "route", route: expect.objectContaining({ repo: "api", effectivePath: "/customers/:id" }), confidence: "param" }]);
  });

  it("contributes nothing when the proxy's prefix does not match the call", () => {
    const targets = resolveProxyTargets(call({ path: "/other/customers/42" }), { id: "web", path: "web", proxies: [{ from: "/api/core", to: "api" }] }, [], candidatesByRepo, UNRESOLVED);
    expect(targets).toEqual([]);
  });

  it("contributes nothing for an unknown-kind call (no literal URL)", () => {
    const targets = resolveProxyTargets(
      call({ kind: "unknown", path: "" }), { id: "web", path: "web", proxies: [{ from: "/api/core", to: "api" }] }, [], candidatesByRepo, UNRESOLVED,
    );
    expect(targets).toEqual([]);
  });

  it("contributes nothing when the repo declares no proxies", () => {
    expect(resolveProxyTargets(call(), { id: "web", path: "web" }, [], candidatesByRepo, UNRESOLVED)).toEqual([]);
  });

  it("stripPrefix: false matches the un-stripped path; the stripped form of the same route then misses", () => {
    const fullRoute: EndpointsFile["routes"][number] = { ...apiRoute, path: "/api/core/customers/:id" };
    const byRepo = routeCandidatesByRepo(new Map([["api", effectiveRoutes(endpoints("api", { routes: [fullRoute] }))]]));
    const matched = resolveProxyTargets(call(), { id: "web", path: "web", proxies: [{ from: "/api/core", to: "api", stripPrefix: false }] }, [], byRepo, UNRESOLVED);
    expect(matched).toEqual([{ kind: "route", route: expect.objectContaining({ effectivePath: "/api/core/customers/:id" }), confidence: "param" }]);
    const missed = resolveProxyTargets(call(), { id: "web", path: "web", proxies: [{ from: "/api/core", to: "api", stripPrefix: false }] }, [], candidatesByRepo, UNRESOLVED);
    expect(missed).toEqual([]);
  });

  it("only the one rule that matches fires (none, or several unrelated, never apply)", () => {
    const billingRoute: EndpointsFile["routes"][number] = {
      method: "GET", path: "/widgets/:id", handler: "show", inline: false, framework: "express",
      at: { file: "src/server.ts", line: 1, symbol: "show" },
    };
    const byRepo = routeCandidatesByRepo(new Map([
      ["api", effectiveRoutes(endpoints("api", { routes: [apiRoute] }))],
      ["billing", effectiveRoutes(endpoints("billing", { routes: [billingRoute] }))],
    ]));
    const ref = { id: "web", path: "web", proxies: [{ from: "/a", to: "api" }, { from: "/b", to: "billing" }] };
    const targets = resolveProxyTargets(call({ path: "/b/widgets/42" }), ref, [], byRepo, UNRESOLVED);
    expect(targets).toEqual([{ kind: "route", route: expect.objectContaining({ repo: "billing", effectivePath: "/widgets/:id" }), confidence: "param" }]);
  });

  // Review fix 4: overlapping rules — the longest (most specific) matching prefix wins; the broader one
  // is never also tried (never two targets, never the wrong one picked).
  it("longest-prefix-wins when two rules both match the same call", () => {
    const billingRoute: EndpointsFile["routes"][number] = {
      method: "GET", path: "/customers/:id", handler: "show", inline: false, framework: "express",
      at: { file: "src/server.ts", line: 1, symbol: "show" },
    };
    const byRepo = routeCandidatesByRepo(new Map([
      ["api", effectiveRoutes(endpoints("api", { routes: [apiRoute] }))],
      ["billing", effectiveRoutes(endpoints("billing", { routes: [billingRoute] }))],
    ]));
    // "/api/core" and "/api" both match "/api/core/customers/42"; the longer, more specific one ("/api/core"
    // -> billing) must be the only one that fires.
    const ref = { id: "web", path: "web", proxies: [{ from: "/api", to: "api" }, { from: "/api/core", to: "billing" }] };
    const targets = resolveProxyTargets(call({ path: "/api/core/customers/42" }), ref, [], byRepo, UNRESOLVED);
    expect(targets).toEqual([{ kind: "route", route: expect.objectContaining({ repo: "billing" }), confidence: "param" }]);
    // declaration order reversed: the same rule (by prefix length) must still win.
    const reversed = { id: "web", path: "web", proxies: [{ from: "/api/core", to: "billing" }, { from: "/api", to: "api" }] };
    expect(resolveProxyTargets(call({ path: "/api/core/customers/42" }), reversed, [], byRepo, UNRESOLVED))
      .toEqual([{ kind: "route", route: expect.objectContaining({ repo: "billing" }), confidence: "param" }]);
  });

  it("matches on the call's effective URL through a known client's baseLiteral, not the bare call-site path (follow-up)", () => {
    const openapiCall = call({ path: "/customers/{id}", client: "apiClient" });
    const clients = [{ name: "apiClient", file: "lib/api-client.ts", line: 1, factory: "createClient", baseLiteral: "/api/api" }];
    const targets = resolveProxyTargets(openapiCall, { id: "web", path: "web", proxies: [{ from: "/api/api", to: "api" }] }, clients, candidatesByRepo, UNRESOLVED);
    expect(targets).toEqual([{ kind: "route", route: expect.objectContaining({ repo: "api", effectivePath: "/customers/:id" }), confidence: "param" }]);
  });

  // Review fix 1 ("never invent links"): proxies are a same-origin, relative-URL convention. A call that
  // is plainly going somewhere else — its own absolute host, a stripped base of its own, a client whose
  // own base is absolute or unresolved, or a call the linker already classified "external" — must never
  // get a proxied match, even when its (host-stripped) path happens to start with a configured `from`.
  describe("never applies to a call that isn't same-origin", () => {
    const ref = { id: "web", path: "web", proxies: [{ from: "/v1", to: "api" }] };
    const v1Route: EndpointsFile["routes"][number] = {
      method: "GET", path: "/customers/:id", handler: "show", inline: false, framework: "express",
      at: { file: "src/server.ts", line: 1, symbol: "show" },
    };
    const v1CandidatesByRepo = routeCandidatesByRepo(new Map([["api", effectiveRoutes(endpoints("api", { routes: [v1Route] }))]]));

    it("a call with its own absolute host (fetch to a third-party URL)", () => {
      const stripeCall = call({ path: "/v1/customers/42", raw: '"https://api.stripe.com/v1/customers/42"', kind: "literal" });
      expect(resolveProxyTargets(stripeCall, ref, [], v1CandidatesByRepo, EXTERNAL_TARGET)).toEqual([]);
    });

    it("a call with its own stripped `base` (a template whose leading expression was stripped as a base)", () => {
      const envCall = call({ path: "/v1/customers/42", base: "process.env.PAY_URL", kind: "template" });
      expect(resolveProxyTargets(envCall, ref, [], v1CandidatesByRepo, EXTERNAL_TARGET)).toEqual([]);
    });

    it("a call through a client whose own baseURL is absolute (baseHost set)", () => {
      const viaClient = call({ path: "/v1/customers/42", client: "payClient" });
      const clients = [{ name: "payClient", file: "lib/pay.ts", line: 1, factory: "axios", baseLiteral: "/v1", baseHost: "api.stripe.com" }];
      expect(resolveProxyTargets(viaClient, ref, clients, v1CandidatesByRepo, UNRESOLVED)).toEqual([]);
    });

    it("a call through a client whose own baseURL is unresolved (baseExpr set, e.g. an env var)", () => {
      const viaClient = call({ path: "/v1/customers/42", client: "payClient" });
      const clients = [{ name: "payClient", file: "lib/pay.ts", line: 1, factory: "axios", baseExpr: "process.env.PAY_URL" }];
      expect(resolveProxyTargets(viaClient, ref, clients, v1CandidatesByRepo, UNRESOLVED)).toEqual([]);
    });

    it("a call the linker already resolved as external, even with a plain relative path", () => {
      const plain = call({ path: "/v1/customers/42" });
      expect(resolveProxyTargets(plain, ref, [], v1CandidatesByRepo, EXTERNAL_TARGET)).toEqual([]);
    });

    it("still applies to a genuinely same-origin relative call (no over-correction)", () => {
      const plain = call({ path: "/v1/customers/42" });
      expect(resolveProxyTargets(plain, ref, [], v1CandidatesByRepo, UNRESOLVED)).toEqual([
        { kind: "route", route: expect.objectContaining({ repo: "api" }), confidence: "param" },
      ]);
    });
  });
});

describe("linkUi: proxied targets", () => {
  const apiRoute: EndpointsFile["routes"][number] = {
    method: "GET", path: "/customers/:id", handler: "CustomersController.show", inline: false,
    framework: "adonis", at: { file: "app/controllers/customers_controller.ts", line: 5, symbol: "CustomersController.show" },
  };

  it("populates `proxied` without disturbing an unresolved own-repo target", () => {
    const web = repo("web", { httpCalls: [call()] }, [{ from: "/api/core", to: "api" }]);
    const api = repo("api", { routes: [apiRoute] });
    const links = linkUi({ ws: ws([web, api]), resolvers: new Map() });
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toEqual({ kind: "unresolved", reason: "no matching route" });
    expect(links[0]!.proxied).toEqual([{ kind: "route", route: expect.objectContaining({ repo: "api", effectivePath: "/customers/:id" }), confidence: "param" }]);
  });

  it("keeps the call's own-repo route target when one also matches, alongside the proxied one", () => {
    const catchAll: EndpointsFile["routes"][number] = {
      method: "GET", path: "/api/core/:path*", handler: "GET", inline: false, framework: "next-api",
      at: { file: "app/api/core/[...path]/route.ts", line: 1, symbol: "GET" }, handlerFile: "app/api/core/[...path]/route.ts",
    };
    const web = repo("web", { httpCalls: [call()], routes: [catchAll] }, [{ from: "/api/core", to: "api" }]);
    const api = repo("api", { routes: [apiRoute] });
    const links = linkUi({ ws: ws([web, api]), resolvers: new Map() });
    expect(links).toHaveLength(1);
    expect(links[0]!.target).toMatchObject({ kind: "route", confidence: "param" });
    expect(links[0]!.target.kind === "route" && links[0]!.target.route.repo).toBe("web");
    expect(links[0]!.proxied).toEqual([{ kind: "route", route: expect.objectContaining({ repo: "api" }), confidence: "param" }]);
  });

  it("without any `proxies`, `proxied` is always empty — no behaviour change (spec §4)", () => {
    const web = repo("web", { httpCalls: [call()] });
    const api = repo("api", { routes: [apiRoute] });
    const links = linkUi({ ws: ws([web, api]), resolvers: new Map() });
    expect(links[0]!.proxied).toEqual([]);
  });

  // Review fix 1: a proxy must never fire for a call that is plainly going to a third party, even when
  // its host-stripped path happens to start with a configured `from`.
  it("never proxies a call to a third-party absolute URL even when the path coincides with `from`", () => {
    const stripeCall: HttpCall = {
      method: "GET", path: "/customers/42", raw: '"https://api.stripe.com/customers/42"', resolved: true,
      client: "fetch", at: { file: "lib/pay.ts", line: 1, symbol: "charge" }, kind: "literal",
    };
    const web = repo("web", { httpCalls: [stripeCall] }, [{ from: "/customers", to: "api" }]);
    const api = repo("api", { routes: [apiRoute] });
    const links = linkUi({ ws: ws([web, api]), resolvers: new Map() });
    expect(links[0]!.target).toMatchObject({ kind: "external", base: "api.stripe.com" });
    expect(links[0]!.proxied).toEqual([]);
  });
});

// Review fix 7: look a client up within the calling file first — two unrelated files that each declare
// their own local client under the same conventional name must never cross-link.
describe("callPathWithClient: same-named clients in different files don't cross-link", () => {
  it("uses the client declared in the call's own file when two files each define one by the same name", () => {
    const clients: HttpClient[] = [
      { name: "apiClient", file: "lib/a.ts", line: 1, factory: "axios", baseLiteral: "/from-a" },
      { name: "apiClient", file: "lib/b.ts", line: 1, factory: "axios", baseLiteral: "/from-b" },
    ];
    const callInA: HttpCall = {
      method: "GET", path: "/x", raw: '"/x"', resolved: true, client: "apiClient",
      at: { file: "lib/a.ts", line: 5, symbol: "f" }, kind: "literal",
    };
    const callInB: HttpCall = { ...callInA, at: { file: "lib/b.ts", line: 5, symbol: "g" } };
    expect(callPathWithClient(callInA, clients)).toBe("/from-a/x");
    expect(callPathWithClient(callInB, clients)).toBe("/from-b/x");
  });

  // Review fix 4 (round 2): no real import graph is available here, so when the calling file declares
  // neither candidate and more than one repo-wide client shares the name, that's a genuine ambiguity —
  // never guessed at (no base prepended), rather than silently picking one (the old behaviour).
  it("the ambiguous case: the calling file declares neither, and more than one repo-wide client shares the name — no base prepended", () => {
    const clients: HttpClient[] = [
      { name: "apiClient", file: "lib/a.ts", line: 1, factory: "axios", baseLiteral: "/from-a" },
      { name: "apiClient", file: "lib/b.ts", line: 1, factory: "axios", baseLiteral: "/from-b" },
    ];
    const callElsewhere: HttpCall = {
      method: "GET", path: "/x", raw: '"/x"', resolved: true, client: "apiClient",
      at: { file: "lib/c.ts", line: 5, symbol: "h" }, kind: "literal",
    };
    expect(callPathWithClient(callElsewhere, clients)).toBe("/x");
  });

  it("a single repo-wide client with that name is used even when a different file calls it", () => {
    const clients: HttpClient[] = [{ name: "apiClient", file: "lib/a.ts", line: 1, factory: "axios", baseLiteral: "/from-a" }];
    const callElsewhere: HttpCall = {
      method: "GET", path: "/x", raw: '"/x"', resolved: true, client: "apiClient",
      at: { file: "lib/c.ts", line: 5, symbol: "h" }, kind: "literal",
    };
    expect(callPathWithClient(callElsewhere, clients)).toBe("/from-a/x");
  });
});

// ---------------------------------------------------------------------------------------------------
// End-to-end: a Next.js catch-all proxy route + a call through it, over a materialized demo-shop copy
// (never the committed fixture — same convention as manual-links.test.ts).
// ---------------------------------------------------------------------------------------------------

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** web's own backend-for-frontend proxy route, and a call through it to pay an invoice (Customer/Invoice
 * names only), forwarded by convention to "/billing/invoices/:id/pay" once a workspace proxy strips the
 * "/api/core" prefix. */
function addProxyRoute(root: string): void {
  write(root, "web/app/api/core/[...path]/route.ts", `export async function GET() {
  return Response.json({ ok: true });
}

export async function POST() {
  return Response.json({ ok: true });
}
`);
  // A literal id (not a template expression): matches the brief's own example (".../customers/42" against
  // "GET /customers/:id" -> param confidence). A templated id would match a route's own `:id` segment as
  // two dynamic segments, which matchSegments scores "exact" (no literal credit either way) — a different,
  // already-covered case, not what this fixture is demonstrating.
  write(root, "web/lib/pay-invoice-via-core.ts", `export async function payInvoiceViaCore() {
  const res = await fetch("/api/core/billing/invoices/42/pay", { method: "POST" });
  return res.json();
}
`);
}

function workspace(root: string, proxies: ProxyRule[]): void {
  writeFileSync(join(root, "codeloom.workspace.json"), JSON.stringify({
    version: 1, name: "demo-shop",
    repos: [
      { id: "api", path: "api" },
      { id: "billing", path: "billing" },
      { id: "web", path: "web", ...(proxies.length > 0 ? { proxies } : {}) },
    ],
    links: [],
  }));
}

function chainsFile(root: string): ChainsFile {
  return ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8")));
}

const CALL_ENTRY = "call:web:lib/pay-invoice-via-core.ts#payInvoiceViaCore";

describe("workspace proxies: end-to-end over demo-shop (spec §4)", () => {
  it("without proxies: the call matches only web's own catch-all route (today's behaviour)", async () => {
    const root = materializeFixture("demo-shop");
    addProxyRoute(root);
    workspace(root, []);
    await runIndex(root);
    const { chains } = chainsFile(root);
    const own = chains.filter((c) => c.entry === CALL_ENTRY);
    expect(own).toHaveLength(1);
    expect(own[0]!.stops.map((s) => s.kind)).toEqual(["call", "route", "handler"]);
    expect(own[0]!.stops[1]).toMatchObject({ repo: "web", op: "POST", label: "POST /api/core/:path*" });
    expect(chains.some((c) => c.stops.some((s) => s.repo === "billing" && c.entry === CALL_ENTRY))).toBe(false);
  }, 60_000);

  it("with proxies to billing: the call ALSO reaches billing's route, handler and table — the web chain stays", async () => {
    const root = materializeFixture("demo-shop");
    addProxyRoute(root);
    workspace(root, [{ from: "/api/core", to: "billing" }]);
    await runIndex(root);
    const { chains } = chainsFile(root);
    const own = chains.filter((c) => c.entry === CALL_ENTRY);
    expect(own).toHaveLength(2);

    const webChain = own.find((c) => c.stops.some((s) => s.kind === "route" && s.repo === "web"))!;
    expect(webChain).toBeDefined();
    expect(webChain.stops.map((s) => s.kind)).toEqual(["call", "route", "handler"]);

    const billingChain = own.find((c) => c.stops.some((s) => s.kind === "route" && s.repo === "billing"))!;
    expect(billingChain).toBeDefined();
    expect(billingChain.stops[0]!.kind).toBe("call");
    const route = billingChain.stops.find((s) => s.kind === "route")!;
    expect(route).toMatchObject({ repo: "billing", op: "POST", label: "POST /billing/invoices/:id/pay", hop: { confidence: "param" } });
    expect(billingChain.stops.some((s) => s.kind === "handler" && s.symbol === "payInvoice")).toBe(true);
    expect(billingChain.stops.some((s) => s.kind === "db" && s.label === "invoices" && s.op === "update")).toBe(true);
    expect(billingChain.complete).toBe(true);
  }, 60_000);

  it("is additive and deterministic: every chain from a proxies-less run is unchanged when proxies is added", async () => {
    // Target a route already reached by an existing UI call (billing's POST /billing/invoices, called
    // from web's "new invoice" page) so this run's own set of chains is unaffected either way; only the
    // new call's own chains are new. (Proxying a route with no other UI caller instead replaces its
    // existing headless "route:" chain with a richer one — correct, but a different invariant than
    // "every old chain's id is untouched".)
    const addCreateInvoiceCall = (root: string) => {
      write(root, "web/app/api/core/[...path]/route.ts", `export async function GET() {
  return Response.json({ ok: true });
}

export async function POST() {
  return Response.json({ ok: true });
}
`);
      write(root, "web/lib/create-invoice-via-core.ts", `export async function createInvoiceViaCore(customerId: number) {
  const res = await fetch("/api/core/billing/invoices", { method: "POST", body: JSON.stringify({ customerId }) });
  return res.json();
}
`);
    };

    const rootA = materializeFixture("demo-shop");
    addCreateInvoiceCall(rootA);
    workspace(rootA, []);
    await runIndex(rootA);
    const before = chainsFile(rootA).chains;

    const rootB = materializeFixture("demo-shop");
    addCreateInvoiceCall(rootB);
    workspace(rootB, [{ from: "/api/core", to: "billing" }]);
    await runIndex(rootB);
    const after = chainsFile(rootB).chains;

    const afterById = new Map(after.map((c) => [c.id, c]));
    for (const c of before) expect(afterById.get(c.id)).toEqual(c);
    expect(after.length).toBe(before.length + 1);
  }, 60_000);

  it("stripPrefix: false matches the un-stripped URL — billing's routes (mounted under /billing) never match", async () => {
    const root = materializeFixture("demo-shop");
    addProxyRoute(root);
    workspace(root, [{ from: "/api/core", to: "billing", stripPrefix: false }]);
    await runIndex(root);
    const { chains } = chainsFile(root);
    const own = chains.filter((c) => c.entry === CALL_ENTRY);
    expect(own).toHaveLength(1); // no proxied match: billing has no route at "/api/core/billing/invoices/:id/pay"
  }, 60_000);

  it("an unknown repo id in proxies is a data error (spec §4)", async () => {
    const root = materializeFixture("demo-shop");
    addProxyRoute(root);
    workspace(root, [{ from: "/api/core", to: "core" }]);
    await expect(runIndex(root)).rejects.toThrow(/unknown repo "core"/);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------
// Follow-up (coordinator): openapi-fetch-style generated client, created behind a local factory whose
// literal argument only flows into a templated baseUrl at runtime — `call.path` alone never shows it.
// Per-test materialized demo-shop copy, as above.
// ---------------------------------------------------------------------------------------------------

/** `web`'s generated-client setup: a local factory (`backendClient`) whose single literal argument
 * flows into a templated `baseUrl`, a client built from it (`apiClient`), two calls through its
 * uppercase verb methods with OpenAPI-style `{param}` path placeholders, and the Next.js catch-all proxy
 * route they go through — all in `web`, Customer names only. */
function addGeneratedClient(root: string): void {
  write(root, "web/lib/api-client.ts", `import createClient from "openapi-fetch";

function sameOrigin(path: string): string {
  return path;
}

function backendClient(backend: "api" | "billing") {
  const client = createClient({ baseUrl: sameOrigin(\`/api/\${backend}\`) });
  return client;
}

export const apiClient = backendClient("api");
`);
  write(root, "web/hooks/use-customer-v2.ts", `import { apiClient } from "../lib/api-client";

export async function getCustomerV2(id: string) {
  const { data } = await apiClient.GET("/customers/{id}", { params: { path: { id } } });
  return data;
}

export async function createCustomerV2(body: unknown) {
  const { data } = await apiClient.POST("/customers", { body });
  return data;
}
`);
  write(root, "web/app/api/[backend]/[...path]/route.ts", `export async function GET() {
  return Response.json({ ok: true });
}

export async function POST() {
  return Response.json({ ok: true });
}
`);
}

const GET_ENTRY = "call:web:hooks/use-customer-v2.ts#getCustomerV2";
const POST_ENTRY = "call:web:hooks/use-customer-v2.ts#createCustomerV2";

describe("workspace proxies: a generated client behind a local factory (follow-up)", () => {
  it("without proxies: both calls match only web's own catch-all route (the factory fold alone changes nothing about proxies)", async () => {
    const root = materializeFixture("demo-shop");
    addGeneratedClient(root);
    workspace(root, []);
    await runIndex(root);
    const { chains } = chainsFile(root);
    for (const entry of [GET_ENTRY, POST_ENTRY]) {
      const own = chains.filter((c) => c.entry === entry);
      expect(own).toHaveLength(1);
      expect(own[0]!.stops.map((s) => s.kind)).toEqual(["call", "route", "handler"]);
      expect(own[0]!.stops[1]).toMatchObject({ repo: "web" });
    }
  }, 60_000);

  // The factory folds backendClient("api")'s baseUrl to "/api/api" (text "/api/" + the literal "api").
  // api's own routes are themselves grouped under "/api" (start/routes.ts's router.group(...).prefix("/api")),
  // so the call's effective URL "/api/api/customers/{id}" reaches api's real "GET /api/customers/:id" once
  // one "/api" layer — the factory's own prefix text, not api's route group — is stripped by the proxy.
  it("with proxies: GET reaches api's customer route + handler + table; POST reaches it, its handler and two tables", async () => {
    const root = materializeFixture("demo-shop");
    addGeneratedClient(root);
    workspace(root, [{ from: "/api", to: "api" }]);
    await runIndex(root);
    const { chains } = chainsFile(root);

    const getChains = chains.filter((c) => c.entry === GET_ENTRY);
    expect(getChains).toHaveLength(2);
    const getOwn = getChains.find((c) => c.stops.some((s) => s.kind === "route" && s.repo === "web"))!;
    expect(getOwn.stops.map((s) => s.kind)).toEqual(["call", "route", "handler"]);
    const getProxied = getChains.find((c) => c.stops.some((s) => s.kind === "route" && s.repo === "api"))!;
    expect(getProxied).toBeDefined();
    expect(getProxied.stops.find((s) => s.kind === "route")).toMatchObject({
      repo: "api", op: "GET", label: "GET /api/customers/:id", hop: { confidence: "param" },
    });
    expect(getProxied.stops.some((s) => s.kind === "handler" && s.symbol === "CustomersController.show")).toBe(true);
    expect(getProxied.stops.some((s) => s.kind === "db" && s.label === "customers" && s.op === "read")).toBe(true);
    expect(getProxied.complete).toBe(true);

    const postChains = chains.filter((c) => c.entry === POST_ENTRY);
    expect(postChains).toHaveLength(2);
    const postProxied = postChains.find((c) => c.stops.some((s) => s.kind === "route" && s.repo === "api"))!;
    expect(postProxied.stops.find((s) => s.kind === "route")).toMatchObject({
      repo: "api", op: "POST", label: "POST /api/customers", hop: { confidence: "exact" },
    });
    expect(postProxied.stops.some((s) => s.kind === "handler" && s.symbol === "CustomersController.store")).toBe(true);
    expect(postProxied.stops.filter((s) => s.kind === "db").map((s) => s.label)).toEqual(["customers", "audit_logs"]);
    expect(postProxied.complete).toBe(true);
  }, 60_000);

  it("is additive: the no-proxies run's own chains are all still present once proxies is added", async () => {
    const rootA = materializeFixture("demo-shop");
    addGeneratedClient(rootA);
    workspace(rootA, []);
    await runIndex(rootA);
    const before = chainsFile(rootA).chains;

    const rootB = materializeFixture("demo-shop");
    addGeneratedClient(rootB);
    workspace(rootB, [{ from: "/api", to: "api" }]);
    await runIndex(rootB);
    const after = chainsFile(rootB).chains;

    const afterById = new Map(after.map((c) => [c.id, c]));
    for (const c of before) expect(afterById.get(c.id)).toEqual(c);
    expect(after.length).toBe(before.length + 2); // the GET and POST calls each gain one proxied chain
  }, 60_000);
});

// Review fix 2: a UI repo whose proxy is a Next.js `rewrites()` entry (no route file of its own, so the
// call's own-repo target stays "unresolved") must not ALSO get a bogus "no matching route" partial
// chain once a workspace `proxies` rule rescues the call — only the real, proxied chain.
describe("workspace proxies: no catch-all route file (Next `rewrites()`-style proxy) (follow-up)", () => {
  function addCallOnly(root: string): void {
    write(root, "web/lib/pay-invoice-no-route.ts", `export async function payInvoiceNoRoute() {
  const res = await fetch("/api/core/billing/invoices/42/pay", { method: "POST" });
  return res.json();
}
`);
  }
  const ENTRY = "call:web:lib/pay-invoice-no-route.ts#payInvoiceNoRoute";

  it("without proxies: the call is genuinely unresolved (no route file, no proxy, no page reaching it) — no chain at all", async () => {
    // Baseline: an unresolved call that no page reaches gets no chain of its own (only a page-reached
    // unmatched call does — check's uiReach/ui-unreached items cover this one instead). This confirms the
    // "with proxies" case below is adding a real chain, not merely suppressing an existing partial one.
    const root = materializeFixture("demo-shop");
    addCallOnly(root);
    workspace(root, []);
    await runIndex(root);
    const { chains, uiReach } = chainsFile(root);
    expect(chains.some((c) => c.stops.some((s) => s.symbol === "payInvoiceNoRoute"))).toBe(false);
    expect(uiReach?.some((f) => f.symbol === "payInvoiceNoRoute" && !f.reached)).toBe(true);
  }, 60_000);

  it("with proxies: exactly one chain — the real one through billing's handler and table, no bogus unmatched one", async () => {
    const root = materializeFixture("demo-shop");
    addCallOnly(root);
    workspace(root, [{ from: "/api/core", to: "billing" }]);
    await runIndex(root);
    const { chains } = chainsFile(root);
    const own = chains.filter((c) => c.entry === ENTRY);
    expect(own).toHaveLength(1);
    expect(own[0]!.stops.map((s) => s.kind)).toEqual(expect.arrayContaining(["call", "route", "handler", "db"]));
    expect(own[0]!.stops.some((s) => s.kind === "route" && s.repo === "billing")).toBe(true);
    expect(own[0]!.unresolved.some((u) => u.reason.includes("no matching route"))).toBe(false);
    expect(own[0]!.complete).toBe(true);
  }, 60_000);
});
