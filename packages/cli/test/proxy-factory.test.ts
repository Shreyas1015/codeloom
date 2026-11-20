import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runIndex } from "../src/commands/index-cmd.js";
import { runDoctor } from "../src/commands/doctor.js";
import { mapGaps } from "../src/map/gaps.js";
import { saveMapAnswers } from "../src/map/save.js";
import { type Chain, ChainsFileSchema, EndpointsFileSchema } from "../src/store/schemas.js";
import { commitAll } from "./helpers.js";
import { shopRepo } from "./shop-group-fixture.js";

// 0.6 §2: demo-shop web's Next.js proxy routes do not fetch themselves (fixtures/demo-shop-proxy/web, laid over
// demo-shop/web): `serviceRoute("billing")` from lib/server/route-handlers.ts hands the service and the path to
// lib/server/forward.ts, which builds `${env[BASE_URL_KEY[service]]}/${service}/${path}` and fetches it. The
// `/api/legacy/*` route forwards to a base read from a package codeloom cannot see: a question, never a guess.

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `codeloom-${prefix}-`));
const chainsOf = (root: string): Chain[] => ChainsFileSchema.parse(JSON.parse(readFileSync(join(root, ".codeloom", "chains.json"), "utf8"))).chains;
const brief = (c: Chain) => c.stops.map((s) => `${s.repo}|${s.kind}|${s.label ?? s.symbol}`);
const OVERLAY = fileURLToPath(new URL("../../../fixtures/demo-shop-proxy/web", import.meta.url));

describe("a Next.js proxy route made by a factory in another file (0.6 §2)", () => {
  let home: string;
  let web: string;
  let root: string;
  beforeAll(async () => {
    home = tmp("home");
    process.env.CODELOOM_HOME = home;
    web = shopRepo("web", tmp("p"));
    cpSync(OVERLAY, web, { recursive: true });
    commitAll(web);
    await runIndex(web);
    root = (await runIndex(shopRepo("billing", tmp("p")))).root;
  }, 120_000);
  beforeEach(() => {
    process.env.CODELOOM_HOME = home;
  });

  it("records where each catch-all route forwards, followed across imports", () => {
    const endpoints = EndpointsFileSchema.parse(JSON.parse(readFileSync(join(web, ".codeloom", "endpoints.json"), "utf8")));
    const forwards = endpoints.routes.filter((r) => r.forwards).map((r) => [r.method, r.path, r.forwards]);
    expect(forwards).toEqual([
      ["GET", "/api/billing/:path*", {
        at: { file: "lib/server/forward.ts", line: 16, symbol: "forwardTo" },
        raw: "${env.BILLING_API_URL}/billing/${path}", base: "env.BILLING_API_URL", path: "/billing/:path*",
      }],
      ["POST", "/api/billing/:path*", expect.objectContaining({ base: "env.BILLING_API_URL", path: "/billing/:path*" })],
      ["POST", "/api/legacy/:path*", { at: { file: "lib/server/forward.ts", line: 20, symbol: "forwardToLegacy" }, raw: "${…}/${path}" }],
    ]);
  });

  it("continues a page's call through the proxy into the billing route, handler and table", () => {
    const chains = chainsOf(root);
    const page = chains.filter((c) => c.entry === "page:demo-web:/invoices/:id/pay");
    expect(page.map(brief), JSON.stringify(page.map(brief), null, 1)).toHaveLength(1);
    expect(brief(page[0]!).slice(0, 5)).toEqual([
      "demo-web|page|PayInvoicePage", "demo-web|call|/api/billing/invoices/:id/pay", "demo-web|route|POST /api/billing/:path*",
      "demo-billing|route|POST /billing/invoices/:id/pay", "demo-billing|handler|payInvoice",
    ]);
    expect(brief(page[0]!)).toContain("demo-billing|db|invoices");
    expect(page[0]).toMatchObject({ complete: true });
  });

  it("asks where a proxy whose base cannot be read forwards, and a proxy answer places it", () => {
    const gaps = mapGaps(web).gaps;
    const proxy = gaps.filter((g) => g.kind === "unplaced-proxy");
    expect(proxy).toHaveLength(1);
    expect(proxy[0]!.question).toMatch(/^Where does demo-web's \/api\/legacy\/\* proxy route forward \(codeloom cannot read its base\)\?/);
    expect(proxy[0]!.evidence).toEqual([
      "demo-web app/api/legacy/[...path]/route.ts:3 POST /api/legacy/:path*",
      "forwards at lib/server/forward.ts:20 forwardToLegacy: ${…}/${path}",
    ]);
    expect(proxy[0]!.close).toBe("proxy|ignore-gap");
    expect((proxy[0]!.journeys ?? 0) + (proxy[0]!.chains ?? 0)).toBeGreaterThan(0); // 0 counts are left out
    // The forwarding fetch is the proxy itself: no question of its own; the billing proxy is no question at all.
    expect(gaps.filter((g) => g.evidence.some((e) => e.includes("lib/server/forward.ts")) && g.kind !== "unplaced-proxy")).toEqual([]);
    expect(gaps.filter((g) => g.question.includes("/api/billing") && g.kind !== "route-no-caller")).toEqual([]); // (only its POST has a caller here)

    const legacy = chainsOf(root).find((c) => c.entry === "page:demo-web:/legacy/invoices/new")!;
    expect(legacy.stops.some((s) => s.repo === "demo-billing")).toBe(false);
    const saved = saveMapAnswers(web, { answers: [{ kind: "proxy", repo: "demo-web", from: "/api/legacy", to: "demo-billing" }] });
    expect(saved.closed.map((g) => g.id)).toContain(proxy[0]!.id);
    const placed = chainsOf(root).filter((c) => c.entry === "page:demo-web:/legacy/invoices/new" && c.stops.some((s) => s.repo === "demo-billing"));
    expect(placed).toHaveLength(1);
    expect(brief(placed[0]!)).toEqual(expect.arrayContaining(["demo-billing|route|POST /billing/invoices", "demo-billing|handler|createInvoice"]));
    expect(mapGaps(web).gaps.filter((g) => g.kind === "unplaced-proxy")).toEqual([]);
    const answers = runDoctor(web, {}).items.find((c) => c.check === "answers");
    expect(answers?.status, JSON.stringify(answers)).toBe("ok");
  });
});
