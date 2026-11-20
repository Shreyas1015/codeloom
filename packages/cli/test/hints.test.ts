import { describe, expect, it } from "vitest";
import { baseFromExpr, baseWords, isInternalHost, matchBase, repoWords } from "../src/linker/hints.js";

const repos = [
  { id: "demo-web", names: ["demo-web", "web"] },
  { id: "demo-api", names: ["demo-api", "api"] },
  { id: "demo-billing", names: ["demo-billing", "billing"] },
  { id: "core-service", names: ["core-service", "@demo-shop/core"] },
];

/** The review's probe repos (fix round 1). */
const probeRepos = [
  { id: "sunny-core-service", names: ["sunny-core-service", "@acme/core", "sunny-core-service"] },
  { id: "notification-service", names: ["notification-service", "@acme/notification-service"] },
  { id: "billing", names: ["billing"] },
  { id: "acme-web", names: ["acme-web", "@acme/web"] },
  { id: "auth-api", names: ["auth-api"] },
  { id: "gateway", names: ["gateway"] },
  { id: "core-worker", names: ["core-worker"] },
];

/** What a base expression matches among the probe repos: the repo id, "ambiguous", "unknown", or "-" (no base). */
function probe(expr: string): string {
  const base = baseFromExpr(expr);
  if (!base) return "-";
  const m = matchBase(base, probeRepos);
  return m.kind === "one" ? m.repo : m.kind;
}

describe("base hints (0.6 §2)", () => {
  it("reads the words of an env var, host or identifier base", () => {
    expect(baseWords({ kind: "env", text: "BILLING_API_URL" })).toEqual(["billing"]);
    expect(baseWords({ kind: "env", text: "NEXT_PUBLIC_BILLING_URL" })).toEqual(["billing"]);
    expect(baseWords({ kind: "env", text: "NEXT_PUBLIC_API_URL" })).toEqual([]);
    expect(baseWords({ kind: "env", text: "CORE_SERVICE_BASE_URL" })).toEqual(["core"]);
    expect(baseWords({ kind: "host", text: "billing.example.com" })).toEqual(["billing"]);
    expect(baseWords({ kind: "host", text: "billing-svc:8080" })).toEqual(["billing"]);
    expect(baseWords({ kind: "host", text: "10.0.0.1:80" })).toEqual([]);
    expect(baseWords({ kind: "name", text: "config.coreServiceUrl" })).toEqual(["core"]);
    expect(baseWords({ kind: "name", text: "this.baseUrl" })).toEqual([]);
  });

  it("drops version and internal words, and folds plurals", () => {
    expect(baseWords({ kind: "env", text: "CORE_API_V2_URL" })).toEqual(["core"]);
    expect(baseWords({ kind: "env", text: "CORE_SERVICE_URL_V2" })).toEqual(["core"]);
    expect(baseWords({ kind: "env", text: "CORE_BASE_URL_INTERNAL" })).toEqual(["core"]);
    expect(baseWords({ kind: "env", text: "NOTIFICATIONS_URL" })).toEqual(["notification"]);
  });

  it("reads the words of a repo name, scope and service words dropped", () => {
    expect(repoWords("@demo-shop/billing-service")).toEqual(["billing"]);
    expect(repoWords("demo-billing")).toEqual(["demo", "billing"]);
  });

  it("finds the base expression's env var, config key or identifier", () => {
    expect(baseFromExpr("process.env.CORE_API_URL")).toEqual({ kind: "env", text: "CORE_API_URL" });
    expect(baseFromExpr('process.env["CORE_API_URL"] ?? "http://localhost"')).toEqual({ kind: "env", text: "CORE_API_URL" });
    expect(baseFromExpr("import.meta.env.VITE_CORE_URL")).toEqual({ kind: "env", text: "VITE_CORE_URL" });
    expect(baseFromExpr("BILLING_URL")).toEqual({ kind: "name", text: "BILLING_URL" });
    expect(baseFromExpr("getBase()")).toBeUndefined();
    expect(baseFromExpr("config.get('services.core.url')")).toEqual({ kind: "name", text: "services.core.url" });
    expect(baseFromExpr("configService.getOrThrow<string>('NOTIFICATION_SERVICE_BASE_URL')"))
      .toEqual({ kind: "env", text: "NOTIFICATION_SERVICE_BASE_URL" });
    expect(baseFromExpr("this.configService.get('NOTIFICATION_SERVICE_BASE_URL')")).toEqual({ kind: "env", text: "NOTIFICATION_SERVICE_BASE_URL" });
    expect(baseFromExpr("Env.get('CORE_SERVICE_URL')")).toEqual({ kind: "env", text: "CORE_SERVICE_URL" });
    expect(baseFromExpr("env('CORE_URL')")).toEqual({ kind: "env", text: "CORE_URL" });
  });

  it("matches exactly one repo, by equal words first and then by a repo name with leading words added", () => {
    expect(matchBase({ kind: "env", text: "BILLING_API_URL" }, repos)).toEqual({ kind: "one", repo: "demo-billing" });
    expect(matchBase({ kind: "env", text: "CORE_API_URL" }, repos)).toEqual({ kind: "one", repo: "core-service" });
    expect(matchBase({ kind: "host", text: "core:8080" }, repos)).toEqual({ kind: "one", repo: "core-service" });
    expect(matchBase({ kind: "env", text: "SHOP_URL" }, [{ id: "demo-shop", names: ["demo-shop"] }])).toEqual({ kind: "one", repo: "demo-shop" });
  });

  it("never lets a base add a leading word to a repo name", () => {
    expect(matchBase({ kind: "env", text: "SHOP_BILLING_URL" }, [{ id: "billing", names: ["billing"] }])).toEqual({ kind: "unknown" });
  });

  it("never picks between two matching repos, and knows a base that names none", () => {
    const two = [...repos, { id: "billing-service", names: ["billing-service"] }];
    expect(matchBase({ kind: "env", text: "BILLING_URL" }, two)).toEqual({ kind: "ambiguous", candidates: ["billing-service", "demo-billing"] });
    expect(matchBase({ kind: "env", text: "PAYMENTS_URL" }, repos)).toEqual({ kind: "unknown" });
    expect(matchBase({ kind: "env", text: "API_URL" }, repos)).toEqual({ kind: "unknown" });
  });

  it("reads the review's probe bases (fix round 1)", () => {
    const table: Array<[string, string]> = [
      ["process.env.CORE_API_URL", "sunny-core-service"],
      ["process.env.NEXT_PUBLIC_CORE_SERVICE_BASE_URL", "sunny-core-service"],
      ["coreServiceUrl", "sunny-core-service"],
      ["this.config.coreServiceUrl", "sunny-core-service"],
      ["config.get('services.core.url')", "sunny-core-service"],
      ["configService.getOrThrow<string>('NOTIFICATION_SERVICE_BASE_URL')", "notification-service"],
      ["this.configService.get('NOTIFICATION_SERVICE_BASE_URL')", "notification-service"],
      ["Env.get('CORE_SERVICE_URL')", "sunny-core-service"],
      ["env('CORE_URL')", "sunny-core-service"],
      ["process.env.CORE_API_V2_URL", "sunny-core-service"],
      ["process.env.PAYMENT_GATEWAY_URL", "unknown"],
      ["process.env.CORE_SERVICE_URL_V2", "sunny-core-service"],
      ["process.env.API_URL", "unknown"],
      ["process.env.NOTIFICATIONS_URL", "notification-service"],
      ["process.env.NOTIFY_URL", "unknown"],
      ["process.env.AUTH_URL", "auth-api"],
      ["process.env.CORE_BASE_URL_INTERNAL", "sunny-core-service"],
      ["process.env.SUNNY_CORE_URL", "sunny-core-service"],
      ["process.env.CUSTOMER_CORE_URL", "unknown"],
      ["baseUrl", "unknown"],
      ["this.baseUrl", "unknown"],
      ["BASE_URL", "unknown"],
      ["config.services.core.url", "sunny-core-service"],
    ];
    expect(table.map(([expr]) => [expr, probe(expr)])).toEqual(table);
  });

  it("trusts a host name only when the host looks internal", () => {
    const internal = ["billing:3000", "billing-svc.default.svc.cluster.local", "notification-service:8080", "billing", "core.internal",
      "core.local", "core.lan", "core.default.svc"];
    const external = ["billing.vendor.com", "core.vendor.com", "customer-billing.vendor.com", "auth.okta.com", "gateway.stripe.com", "api.billing.com"];
    expect(internal.filter((h) => !isInternalHost(h))).toEqual([]);
    expect(external.filter((h) => isInternalHost(h))).toEqual([]);
  });
});

describe("a repo's remote name (fix round 1)", () => {
  it("is read from the git config's remote URL, with no git or ssh process", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { remoteRepoName } = await import("../src/linker/run.js");
    const dir = mkdtempSync(join(tmpdir(), "codeloom-remote-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://example.com/x/other.git\n[remote "origin"]\n\turl = git@my-alias:demo-shop/Billing-Service.git\n');
    expect(remoteRepoName(dir)).toBe("billing-service");
    expect(remoteRepoName(join(dir, "missing"))).toBeUndefined();
  });
});
