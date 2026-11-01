import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { formatScore, hopKey, hopsFromChains, scoreChains } from "../src/evals/score.js";
import { CODELOOM_DIR, FILES } from "../src/store/paths.js";
import { ChainsFileSchema, ExpectedJourneysSchema } from "../src/store/schemas.js";
import type { Chain, ChainStop, ExpectedHop, ExpectedJourneys } from "../src/store/schemas.js";
import { makeRepo, materializeFixture } from "./helpers.js";

function fakeChain(overrides: Partial<Chain>): Chain {
  return {
    id: "ch_000000000001",
    entry: "page:web:/x",
    routeKey: "api:POST /api/x",
    name: "POST /api/x",
    stops: [],
    unresolved: [],
    confidence: "exact",
    complete: true,
    ...overrides,
  };
}

describe("hopKey", () => {
  it("ignores key order and produces the same key for equal hops", () => {
    const a: ExpectedHop = { type: "ui-api", from: { repo: "web", file: "lib/x.ts", symbol: "getX" }, to: { repo: "api", method: "GET", path: "/api/x" } };
    const b: ExpectedHop = { to: { method: "GET", repo: "api", path: "/api/x" }, type: "ui-api", from: { symbol: "getX", repo: "web", file: "lib/x.ts" } };
    expect(hopKey(a)).toBe(hopKey(b));
  });

  it("distinguishes hops of different types with the same route", () => {
    const rh: ExpectedHop = { type: "route-handler", route: "api:POST /api/x", handler: { file: "a.ts", symbol: "f" } };
    const hs: ExpectedHop = { type: "handler-store", route: "api:POST /api/x", table: "x", op: "insert" };
    expect(hopKey(rh)).not.toBe(hopKey(hs));
  });
});

describe("hopsFromChains", () => {
  it("extracts a ui-api hop from a call stop followed by a route stop", () => {
    const chain = fakeChain({
      stops: [
        { lane: "ui", kind: "call", repo: "web", file: "lib/x.ts", line: 2, symbol: "getX", op: "GET", hop: { confidence: "exact" } },
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.show", op: "GET", label: "GET /api/x/:id", hop: { confidence: "param" } },
      ],
    });
    const hops = hopsFromChains([chain]).filter((f) => f.hop.type === "ui-api");
    expect(hops).toEqual([
      { hop: { type: "ui-api", from: { repo: "web", file: "lib/x.ts", symbol: "getX" }, to: { repo: "api", method: "GET", path: "/api/x/:id" } }, confidence: "param" },
    ]);
  });

  it("extracts a route-handler hop from a route stop followed by a handler stop", () => {
    const chain = fakeChain({
      routeKey: "api:POST /api/x",
      stops: [
        { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.store", op: "POST", label: "POST /api/x", hop: { confidence: "exact" } },
        { lane: "code", kind: "handler", repo: "api", file: "app/controllers/x_controller.ts", line: 5, symbol: "X.store", hop: { confidence: "exact" } },
      ],
    });
    const hops = hopsFromChains([chain]).filter((f) => f.hop.type === "route-handler");
    expect(hops).toEqual([
      { hop: { type: "route-handler", route: "api:POST /api/x", handler: { file: "app/controllers/x_controller.ts", symbol: "X.store" } }, confidence: "exact" },
    ]);
  });

  it("extracts handler-store hops for db, publish and consume stops, using entry for consumer chains", () => {
    const routeChain = fakeChain({
      routeKey: "billing:POST /billing/invoices",
      stops: [
        { lane: "db", kind: "db", repo: "billing", file: "src/invoice-service.ts", line: 3, symbol: "invoiceService.create", op: "insert", label: "invoices", hop: { confidence: "exact" } },
        { lane: "queue", kind: "publish", repo: "billing", file: "src/events.ts", line: 4, symbol: "publishInvoiceCreated", op: "publish", label: "invoice.created", hop: { confidence: "exact" } },
      ],
    });
    // Consumer chain ids always carry the handler: consumer:<repo>:<queue>#<file>#<symbol>.
    const consumerChain = fakeChain({
      entry: "consumer:billing:emails#src/notify-consumer.ts#handleEmail",
      routeKey: "",
      stops: [
        { lane: "queue", kind: "consume", repo: "billing", file: "src/notify-consumer.ts", line: 2, symbol: "startNotifier", op: "consume", label: "emails", hop: { confidence: "exact" } },
        { lane: "db", kind: "db", repo: "billing", file: "src/notify-consumer.ts", line: 6, symbol: "handleEmail", op: "insert", label: "email_logs", hop: { confidence: "exact" } },
      ],
    });
    const hops = hopsFromChains([routeChain, consumerChain]).filter((f) => f.hop.type === "handler-store");
    expect(hops.map((f) => f.hop)).toEqual([
      { type: "handler-store", route: "billing:POST /billing/invoices", table: "invoices", op: "insert" },
      { type: "handler-store", route: "billing:POST /billing/invoices", queue: "invoice.created", op: "publish" },
      { type: "handler-store", route: "consumer:billing:emails#src/notify-consumer.ts#handleEmail", queue: "emails", op: "consume" },
      { type: "handler-store", route: "consumer:billing:emails#src/notify-consumer.ts#handleEmail", table: "email_logs", op: "insert" },
    ]);
  });

  it("deduplicates identical hops across chains, keeping the first one seen", () => {
    const stop = { lane: "api" as const, kind: "route" as const, repo: "api", file: "r.ts", line: 1, symbol: "X.store", op: "POST" as const, label: "POST /api/x", hop: { confidence: "exact" as const } };
    const handler = { lane: "code" as const, kind: "handler" as const, repo: "api", file: "c.ts", line: 2, symbol: "X.store", hop: { confidence: "exact" as const } };
    const c1 = fakeChain({ id: "ch_000000000001", routeKey: "api:POST /api/x", stops: [stop, handler] });
    const c2 = fakeChain({ id: "ch_000000000002", routeKey: "api:POST /api/x", stops: [stop, handler] });
    const hops = hopsFromChains([c1, c2]).filter((f) => f.hop.type === "route-handler");
    expect(hops).toHaveLength(1);
  });

  it("keeps the best confidence when an earlier-id chain finds a hop as a guess and a later one finds it exact", () => {
    const guessRoute = { lane: "api" as const, kind: "route" as const, repo: "api", file: "r.ts", line: 1, symbol: "X.store", op: "POST" as const, label: "POST /api/x", hop: { confidence: "guess" as const, reason: "suffix match" } };
    const exactRoute = { lane: "api" as const, kind: "route" as const, repo: "api", file: "r.ts", line: 1, symbol: "X.store", op: "POST" as const, label: "POST /api/x", hop: { confidence: "exact" as const } };
    const handler = { lane: "code" as const, kind: "handler" as const, repo: "api", file: "c.ts", line: 2, symbol: "X.store", hop: { confidence: "exact" as const } };
    const c1 = fakeChain({ id: "ch_000000000001", routeKey: "api:POST /api/x", stops: [guessRoute, handler] });
    const c2 = fakeChain({ id: "ch_000000000002", routeKey: "api:POST /api/x", stops: [exactRoute, handler] });
    const hops = hopsFromChains([c1, c2]).filter((f) => f.hop.type === "route-handler");
    expect(hops).toHaveLength(1);
    expect(hops[0]!.confidence).toBe("exact");
  });

  it("keeps the best confidence when an earlier-id chain finds a hop as exact and a later one finds it as a guess", () => {
    const exactRoute = { lane: "api" as const, kind: "route" as const, repo: "api", file: "r.ts", line: 1, symbol: "X.store", op: "POST" as const, label: "POST /api/x", hop: { confidence: "exact" as const } };
    const guessRoute = { lane: "api" as const, kind: "route" as const, repo: "api", file: "r.ts", line: 1, symbol: "X.store", op: "POST" as const, label: "POST /api/x", hop: { confidence: "guess" as const, reason: "suffix match" } };
    const handler = { lane: "code" as const, kind: "handler" as const, repo: "api", file: "c.ts", line: 2, symbol: "X.store", hop: { confidence: "exact" as const } };
    const c1 = fakeChain({ id: "ch_000000000001", routeKey: "api:POST /api/x", stops: [exactRoute, handler] });
    const c2 = fakeChain({ id: "ch_000000000002", routeKey: "api:POST /api/x", stops: [guessRoute, handler] });
    const hops = hopsFromChains([c1, c2]).filter((f) => f.hop.type === "route-handler");
    expect(hops).toHaveLength(1);
    expect(hops[0]!.confidence).toBe("exact");
  });
});

function dbStop(overrides: Partial<ChainStop> = {}): ChainStop {
  return { lane: "db", kind: "db", repo: "api", file: "app/services/x_service.ts", line: 4, symbol: "X.create", op: "insert", label: "x", hop: { confidence: "exact" }, ...overrides };
}

const scoreKey: ExpectedJourneys = {
  version: 1,
  source: { url: "fixtures/demo-shop (written for codeloom)", sha: "n/a", licence: "MIT" },
  hops: [
    { type: "ui-api", from: { repo: "web", file: "lib/x.ts", symbol: "getX" }, to: { repo: "api", method: "GET", path: "/api/x" } },
    { type: "route-handler", route: "api:POST /api/x", handler: { file: "a.ts", symbol: "X.store" } },
    { type: "handler-store", route: "api:POST /api/x", table: "x", op: "insert" },
  ],
};

describe("scoreChains", () => {
  const key = scoreKey;
  const callStop: ChainStop = { lane: "ui", kind: "call", repo: "web", file: "lib/x.ts", line: 2, symbol: "getX", op: "GET", hop: { confidence: "exact" } };
  const routeStop: ChainStop = { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 1, symbol: "X.show", op: "GET", label: "GET /api/x", hop: { confidence: "exact" } };
  const routeStopPost: ChainStop = { lane: "api", kind: "route", repo: "api", file: "start/routes.ts", line: 2, symbol: "X.store", op: "POST", label: "POST /api/x", hop: { confidence: "exact" } };
  const handlerStop: ChainStop = { lane: "code", kind: "handler", repo: "api", file: "a.ts", line: 3, symbol: "X.store", hop: { confidence: "exact" } };

  it("scores precision 1 / recall 1 when chains produce exactly the key's hops", () => {
    const uiChain = fakeChain({ id: "ch_000000000001", entry: "page:web:/x", routeKey: "api:GET /api/x", stops: [callStop, routeStop] });
    const routeChain = fakeChain({ id: "ch_000000000002", entry: "route:api:POST /api/x", routeKey: "api:POST /api/x", stops: [routeStopPost, handlerStop, dbStop()] });
    const score = scoreChains(key, [uiChain, routeChain]);
    for (const type of ["ui-api", "route-handler", "handler-store"] as const) {
      expect(score[type].precision).toBe(1);
      expect(score[type].recall).toBe(1);
      expect(score[type].guesses).toBe(0);
      expect(score[type].missing).toEqual([]);
      expect(score[type].extra).toEqual([]);
    }
  });

  it("counts an extra found hop against precision and lists its key", () => {
    const uiChain = fakeChain({ id: "ch_000000000001", entry: "page:web:/x", routeKey: "api:GET /api/x", stops: [callStop, routeStop] });
    const extraDbChain = fakeChain({ id: "ch_000000000003", entry: "route:api:DELETE /api/x", routeKey: "api:DELETE /api/x", stops: [dbStop({ repo: "api", label: "y", file: "app/services/y_service.ts", symbol: "Y.destroy" })] });
    const score = scoreChains(key, [uiChain, extraDbChain]);
    expect(score["handler-store"].expected).toBe(1);
    expect(score["handler-store"].found).toBe(1);
    expect(score["handler-store"].truePositives).toBe(0);
    expect(score["handler-store"].precision).toBe(0);
    expect(score["handler-store"].extra).toEqual([hopKey({ type: "handler-store", route: "api:DELETE /api/x", table: "y", op: "insert" })]);
  });

  it("counts a missing expected hop against recall and lists its key", () => {
    const score = scoreChains(key, []);
    expect(score["route-handler"].found).toBe(0);
    expect(score["route-handler"].recall).toBe(0);
    expect(score["route-handler"].missing).toEqual([hopKey(key.hops[1]!)]);
  });

  it("reports a guess hop separately: not counted as found, not in missing/extra", () => {
    const guessRoute: ChainStop = { ...routeStop, hop: { confidence: "guess", reason: "suffix match" } };
    const uiChain = fakeChain({ id: "ch_000000000001", entry: "page:web:/x", routeKey: "api:GET /api/x", stops: [callStop, guessRoute] });
    const score = scoreChains(key, [uiChain]);
    expect(score["ui-api"].found).toBe(0);
    expect(score["ui-api"].guesses).toBe(1);
    expect(score["ui-api"].guessCorrect).toBe(1);
    expect(score["ui-api"].recall).toBe(0);
    expect(score["ui-api"].missing).toEqual([hopKey(key.hops[0]!)]);
  });

  it("treats a zero denominator as a perfect score (1), not a division error", () => {
    const score = scoreChains({ ...key, hops: [] }, []);
    expect(score["ui-api"]).toMatchObject({ expected: 0, found: 0, precision: 1, recall: 1 });
  });
});

describe("formatScore", () => {
  it("prints a table with one row per hop type", () => {
    const score = scoreChains(scoreKey, []);
    const text = formatScore(score);
    expect(text).toContain("ui-api");
    expect(text).toContain("route-handler");
    expect(text).toContain("handler-store");
  });
});

describe("demo-shop answer key", () => {
  it("scores precision 1.0 / recall 1.0 on every hop type, with zero guesses", async () => {
    const root = materializeFixture("demo-shop");
    writeFileSync(
      join(root, "codeloom.workspace.json"),
      JSON.stringify({ version: 1, name: "demo-shop", repos: [{ id: "api", path: "api" }, { id: "billing", path: "billing" }, { id: "web", path: "web" }], links: [] }),
    );
    await runIndex(root);
    const chainsFile = ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, CODELOOM_DIR, FILES.chains), "utf8")));
    const key = ExpectedJourneysSchema.parse(JSON.parse(readFileSync(join(root, "expected-journeys.json"), "utf8")));

    const score = scoreChains(key, chainsFile.chains);
    for (const type of ["ui-api", "route-handler", "handler-store"] as const) {
      expect(score[type], `${type}: ${JSON.stringify(score[type])}`).toMatchObject({ precision: 1, recall: 1, guesses: 0 });
    }
  });
});

describe("handler-store hops carry the worst confidence of their path (final review item 1)", () => {
  const schema = "model Order {\n  id Int @id @default(autoincrement())\n}\n";
  const service = [
    "import { PrismaClient } from \"@prisma/client\";",
    "const prisma = new PrismaClient();",
    "export class OrderService {",
    "  async createOrder(data: { n: number }) {",
    "    return prisma.order.create({ data });",
    "  }",
    "}",
    "",
  ].join("\n");
  const pkg = JSON.stringify({ name: "shop", dependencies: { express: "^4", "@prisma/client": "^5" } });

  async function chainsOf(files: Record<string, string>) {
    const root = makeRepo({ "package.json": pkg, "prisma/schema.prisma": schema, "src/order-service.ts": service, ...files });
    await runIndex(root);
    return ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, CODELOOM_DIR, FILES.chains), "utf8"))).chains;
  }

  it("a store reached through a guessed (unique-method) call scores as guess, not exact", async () => {
    const chains = await chainsOf({
      "src/server.ts": [
        "import express from \"express\";",
        "const app = express();",
        "export async function createOrderHandler(req, res, svc) {",
        "  const order = await svc.createOrder(req.body);",
        "  res.json(order);",
        "}",
        "app.post(\"/orders\", createOrderHandler);",
        "app.listen(3000);",
        "",
      ].join("\n"),
    });
    const stores = hopsFromChains(chains).filter((f) => f.hop.type === "handler-store");
    expect(stores.map((f) => [f.hop.type === "handler-store" ? f.hop.table : "", f.confidence])).toEqual([["Order", "guess"]]);
  }, 60_000);

  it("a store under an unknown mount prefix scores as guess", async () => {
    const chains = await chainsOf({
      "src/routes.ts": [
        "import express from \"express\";",
        "import { OrderService } from \"./order-service\";",
        "export const router = express.Router();",
        "router.post(\"/orders\", async (req, res) => {",
        "  res.json(await new OrderService().createOrder(req.body));",
        "});",
        "",
      ].join("\n"),
    });
    const stores = hopsFromChains(chains).filter((f) => f.hop.type === "handler-store");
    expect(stores.map((f) => f.confidence)).toEqual(["guess"]);
  }, 60_000);
});
