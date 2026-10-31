import { describe, expect, it } from "vitest";
import { effectiveRoutes, routeKey } from "../src/linker/mounts.js";
import { pickRoute } from "../src/linker/paths.js";
import type { RouteCandidate } from "../src/linker/paths.js";
import type { EndpointsFile, HttpMethod, Loc, Mount, MountKind, Route } from "../src/store/schemas.js";

function loc(file: string, line: number, symbol: string): Loc {
  return { file, line, symbol };
}
function route(method: HttpMethod, path: string, file: string, framework: Route["framework"], router?: string): Route {
  return { method, path, handler: "handler", inline: false, framework, at: loc(file, 1, "handler"), ...(router ? { router } : {}) };
}
function mount(prefix: string, kind: MountKind, on: string, target: { name?: string; file?: string }, file: string): Mount {
  return { prefix, kind, on, target, at: loc(file, 1, "<module>") };
}
function endpoints(repo: string, routes: Route[], mounts: Mount[]): EndpointsFile {
  return { version: 2, repo, pages: [], httpCalls: [], httpClients: [], routes, mounts, dbAccess: [], tables: [], models: [], queues: [] };
}

describe("effectiveRoutes: express app.use, multi-level", () => {
  it("composes an outer app.use and an inner router.use into one effective path", () => {
    const r = route("GET", "/customers", "customers-router.ts", "express", "router");
    const m1 = mount("/v1", "express-use", "router", { file: "customers-router.ts" }, "api-router.ts");
    const m2 = mount("/api", "express-use", "app", { file: "api-router.ts" }, "server.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [m1, m2]));
    expect(eff).toMatchObject({ effectivePath: "/api/v1/customers", mountsKnown: true, mounts: [m2, m1] });
  });
});

describe("effectiveRoutes: fastify register prefix", () => {
  it("applies a single register({ prefix }) mount", () => {
    const r = route("POST", "/orders", "orders-plugin.ts", "fastify", "instance");
    const m = mount("/orders-api", "fastify-register", "fastify", { file: "orders-plugin.ts" }, "app.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [m]));
    expect(eff).toMatchObject({ effectivePath: "/orders-api/orders", mountsKnown: true, mounts: [m] });
  });
});

describe("effectiveRoutes: nest global prefix", () => {
  it("applies setGlobalPrefix to every nest-framework route in the repo", () => {
    const r1 = route("GET", "/widgets/:id", "widgets.controller.ts", "nest");
    const r2 = route("POST", "/widgets", "widgets.controller.ts", "nest");
    const m = mount("/api", "nest-global", "", {}, "main.ts");
    const effs = effectiveRoutes(endpoints("api", [r1, r2], [m]));
    expect(effs.map((e) => e.effectivePath).sort()).toEqual(["/api/widgets", "/api/widgets/:id"]);
    expect(effs.every((e) => e.mountsKnown && e.mounts.length === 1)).toBe(true);
  });
});

describe("effectiveRoutes: mountsKnown", () => {
  it("is false for a sub-router no recorded mount targets, when the repo does mount other routers", () => {
    const r = route("POST", "/invoices/:id/pay", "billing-routes.ts", "express", "billingRouter");
    const unrelated = mount("/other", "express-use", "app", { file: "other-routes.ts" }, "server.ts");
    const [eff] = effectiveRoutes(endpoints("billing", [r], [unrelated]));
    expect(eff).toMatchObject({ effectivePath: "/invoices/:id/pay", mountsKnown: false, mounts: [] });
  });

  it("is true when the repo records no mounts at all (a flat app)", () => {
    const r = route("GET", "/health", "server.ts", "express", "app");
    const [eff] = effectiveRoutes(endpoints("api", [r], []));
    expect(eff).toMatchObject({ effectivePath: "/health", mountsKnown: true, mounts: [] });
  });

  it("is true for a route declared directly on a top-level receiver even when other mounts exist", () => {
    const r = route("GET", "/health", "server.ts", "express", "app");
    const unrelated = mount("/billing", "express-use", "app", { file: "billing-routes.ts" }, "server.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [unrelated]));
    expect(eff).toMatchObject({ effectivePath: "/health", mountsKnown: true, mounts: [] });
  });
});

describe("effectiveRoutes: several mounts for one router", () => {
  it("emits one EffectiveRoute per mount prefix, sorted", () => {
    const r = route("GET", "/items", "items-router.ts", "express", "router");
    const mb = mount("/b", "express-use", "app", { file: "items-router.ts" }, "server.ts");
    const ma = mount("/a", "express-use", "app", { file: "items-router.ts" }, "server.ts");
    const effs = effectiveRoutes(endpoints("api", [r], [mb, ma]));
    expect(effs.map((e) => e.effectivePath)).toEqual(["/a/items", "/b/items"]);
  });
});

describe("routeKey", () => {
  it("formats repo:METHOD effectivePath", () => {
    const r = route("GET", "/health", "server.ts", "express", "app");
    const [eff] = effectiveRoutes(endpoints("api", [r], []));
    expect(routeKey(eff!)).toBe("api:GET /health");
  });
});

describe("effectiveRoutes: mount chains that dead-end, cycle or exceed the cap", () => {
  it("is false when the outer router of a mount chain is never itself mounted (orphaned)", () => {
    // inner.ts's router is mounted at /a onto "outer" (declared in mid.ts), but "outer" is never
    // mounted anywhere codeloom can see, so the chain dead-ends mid-way.
    const r = route("GET", "/widgets", "inner.ts", "express", "innerRouter");
    const m = mount("/a", "express-use", "outer", { file: "inner.ts" }, "mid.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [m]));
    expect(eff!.mountsKnown).toBe(false);
    expect(eff!.effectivePath).toBe("/a/widgets");
  });

  it("terminates and is false for a mutual-mount cycle between two files", () => {
    // fileA's routerA is mounted (prefix /x) onto fileB's routerB; fileB's routerB is in turn mounted
    // (prefix /y) onto fileA's routerA — a cycle with no top-level terminator.
    const r = route("GET", "/thing", "fileA.ts", "express", "routerA");
    const mountAOntoB = mount("/x", "express-use", "routerB", { file: "fileA.ts" }, "fileB.ts");
    const mountBOntoA = mount("/y", "express-use", "routerA", { file: "fileB.ts" }, "fileA.ts");
    const effs = effectiveRoutes(endpoints("api", [r], [mountAOntoB, mountBOntoA]));
    expect(effs).toHaveLength(1);
    expect(effs[0]!.mountsKnown).toBe(false);
  });

  it("is false for a mount chain longer than the depth cap", () => {
    const r = route("GET", "/leaf", "f0.ts", "express", "r0");
    const mounts: Mount[] = [];
    // Chain of 8 mounts, each mounting the previous router one level further out: well past
    // MAX_MOUNT_LEVELS (5), so the depth cap trips before the chain's top is reached.
    for (let i = 0; i < 8; i++) {
      mounts.push(mount(`/p${i}`, "express-use", `r${i + 1}`, { file: `f${i}.ts` }, `f${i + 1}.ts`));
    }
    const effs = effectiveRoutes(endpoints("api", [r], mounts));
    expect(effs).toHaveLength(1);
    expect(effs[0]!.mountsKnown).toBe(false);
  });

  it("is true with the full composed path for a complete 3-level chain", () => {
    const r = route("GET", "/c", "file0.ts", "express", "r0");
    const mid = mount("/mid", "express-use", "r1", { file: "file0.ts" }, "file1.ts");
    const outer = mount("/outer", "express-use", "app", { file: "file1.ts" }, "file2.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [mid, outer]));
    expect(eff).toMatchObject({ effectivePath: "/outer/mid/c", mountsKnown: true, mounts: [outer, mid] });
  });

  it("does not prefix a route with an in-file middleware mount (regression)", () => {
    // app.use("/api", requireAuth) in the same file as a route declared directly on app: requireAuth
    // is not a router and must not contribute a prefix to this unrelated route.
    const r = route("GET", "/health", "server.ts", "express", "app");
    const middleware = mount("/api", "express-use", "app", { name: "requireAuth" }, "server.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [middleware]));
    expect(eff).toMatchObject({ effectivePath: "/health", mountsKnown: true, mounts: [] });
  });

  it("does not double-apply an Adonis group prefix already baked into the route path", () => {
    // Adonis routes never carry a `router` field (there is no app.use()-style mount step for them),
    // so they must pass through untouched even when the repo records other mounts.
    const r = route("GET", "/api/v1/users", "users-routes.ts", "adonis");
    const unrelated = mount("/other", "express-use", "app", { file: "other-routes.ts" }, "server.ts");
    const [eff] = effectiveRoutes(endpoints("api", [r], [unrelated]));
    expect(eff).toMatchObject({ effectivePath: "/api/v1/users", mountsKnown: true, mounts: [] });
  });
});

describe("unknown-mount routes are only matched by callers via a unique path suffix", () => {
  it("feeds mountsKnown: false into pickRoute's suffix-guess rule (Task 8)", () => {
    const r = route("POST", "/invoices/:id/pay", "billing-routes.ts", "express", "billingRouter");
    const unrelated = mount("/other", "express-use", "app", { file: "other-routes.ts" }, "server.ts");
    const [eff] = effectiveRoutes(endpoints("billing", [r], [unrelated]));
    expect(eff!.mountsKnown).toBe(false);

    type Item = typeof eff;
    const one: RouteCandidate<Item>[] = [{ item: eff, method: eff!.route.method, path: eff!.effectivePath, mountsKnown: eff!.mountsKnown }];
    expect(pickRoute("POST", "/billing/invoices/42/pay", one)).toEqual({
      item: eff,
      match: { confidence: "guess", literals: 2, reason: "suffix match under unknown mount" },
    });

    // a second, independently-unmounted route with the same effective path makes the suffix ambiguous.
    const r2 = route("POST", "/invoices/:id/pay", "legacy-routes.ts", "express", "legacyRouter");
    const [eff2] = effectiveRoutes(endpoints("billing", [r2], [unrelated]));
    const two: RouteCandidate<Item>[] = [
      { item: eff, method: eff!.route.method, path: eff!.effectivePath, mountsKnown: eff!.mountsKnown },
      { item: eff2, method: eff2!.route.method, path: eff2!.effectivePath, mountsKnown: eff2!.mountsKnown },
    ];
    expect(pickRoute("POST", "/billing/invoices/42/pay", two)).toBeNull();
  });
});
