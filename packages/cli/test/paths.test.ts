import { describe, expect, it } from "vitest";
import { joinPaths, matchPath, methodMatches, parsePath, pickRoute } from "../src/linker/paths.js";
import type { RouteCandidate } from "../src/linker/paths.js";

describe("parsePath", () => {
  it("splits literal paths into literal segments", () => {
    expect(parsePath("/api/customers")).toEqual([
      { kind: "literal", value: "api" },
      { kind: "literal", value: "customers" },
    ]);
  });

  it("treats root as no segments and trims a trailing slash", () => {
    expect(parsePath("/")).toEqual([]);
    expect(parsePath("/api/customers/")).toEqual(parsePath("/api/customers"));
  });

  it("recognises :name params and :name* / * / (.*) splats", () => {
    expect(parsePath("/customers/:id")).toEqual([
      { kind: "literal", value: "customers" },
      { kind: "param", name: "id" },
    ]);
    expect(parsePath("/files/:rest*")).toEqual([
      { kind: "literal", value: "files" },
      { kind: "splat", name: "rest" },
    ]);
    expect(parsePath("/files/*")).toEqual([
      { kind: "literal", value: "files" },
      { kind: "splat", name: "*" },
    ]);
    expect(parsePath("/files/(.*)"))
      .toEqual([{ kind: "literal", value: "files" }, { kind: "splat", name: "*" }]);
  });
});

describe("joinPaths", () => {
  it("joins and normalises parts, skipping empty ones", () => {
    expect(joinPaths("/billing", "/invoices")).toBe("/billing/invoices");
    expect(joinPaths("", "/billing/", "/invoices/:id")).toBe("/billing/invoices/:id");
    expect(joinPaths()).toBe("/");
    expect(joinPaths("", "")).toBe("/");
    expect(joinPaths("/api")).toBe("/api");
  });
});

describe("matchPath", () => {
  it("literal = literal -> exact, full specificity", () => {
    expect(matchPath("/api/customers", "/api/customers")).toEqual({ confidence: "exact", literals: 2 });
  });

  it("a literal call segment against a route param/splat -> param", () => {
    expect(matchPath("/customers/42", "/customers/:id")).toEqual({ confidence: "param", literals: 1 });
    expect(matchPath("/files/a/b/c", "/files/:rest*")).toEqual({ confidence: "param", literals: 1 });
  });

  it("a splat matches zero segments too ([...x] zero-or-more)", () => {
    expect(matchPath("/files", "/files/:rest*")).toEqual({ confidence: "exact", literals: 1 });
  });

  it("a dynamic call segment against a route literal -> guess, with a reason", () => {
    expect(matchPath("/customers/:id", "/customers/active")).toEqual({
      confidence: "guess",
      literals: 1, // the leading "customers" segment still matches literal-for-literal
      reason: "call segment is a variable",
    });
  });

  it("two params in the same position both dynamic -> exact (no literal credit)", () => {
    expect(matchPath("/customers/:x", "/customers/:id")).toEqual({ confidence: "exact", literals: 1 });
  });

  it("returns null when segment counts cannot line up", () => {
    expect(matchPath("/api/customers", "/api/customers/extra")).toBeNull();
    expect(matchPath("/api/customers/extra", "/api/customers")).toBeNull();
  });
});

describe("methodMatches", () => {
  it("ANY on either side matches anything; otherwise methods must be equal", () => {
    expect(methodMatches("GET", "ANY")).toBe(true);
    expect(methodMatches("ANY", "POST")).toBe(true);
    expect(methodMatches("ANY", "ANY")).toBe(true);
    expect(methodMatches("GET", "POST")).toBe(false);
    expect(methodMatches("GET", "GET")).toBe(true);
  });
});

describe("pickRoute", () => {
  function cand(path: string, method: "GET" | "POST" | "ANY" = "GET", mountsKnown = true): RouteCandidate<string> {
    return { item: `${method} ${path}`, method, path, mountsKnown };
  }

  it("picks the most specific (most literal segments) candidate", () => {
    const candidates = [cand("/customers/:id"), cand("/customers/active")];
    const picked = pickRoute("GET", "/customers/active", candidates);
    expect(picked).toEqual({ item: "GET /customers/active", match: { confidence: "exact", literals: 2 } });
  });

  it("matches ANY-method routes against any call method", () => {
    const candidates = [cand("/health", "ANY")];
    const picked = pickRoute("GET", "/health", candidates);
    expect(picked).toEqual({ item: "ANY /health", match: { confidence: "exact", literals: 1 } });
  });

  it("ties on specificity -> guess, winner is first by compare of path", () => {
    const candidates = [cand("/items/:id"), cand("/items/:slug")];
    const picked = pickRoute("GET", "/items/42", candidates);
    expect(picked).toEqual({
      item: "GET /items/:id",
      match: { confidence: "guess", literals: 1, reason: "tie between equally specific routes" },
    });
  });

  it("breaks an equal-rank tie by the left-most literal segment: that route wins at param", () => {
    const candidates = [cand("/:kind/summary"), cand("/invoices/:id")];
    expect(pickRoute("GET", "/invoices/summary", candidates)).toEqual({
      item: "GET /invoices/:id",
      match: { confidence: "param", literals: 1, reason: "literal segment preferred over a parameter" },
    });
    // Three-way: the literal at position 1 decides between the two that share position 0.
    const three = [cand("/api/:a/:b"), cand("/api/customers/:id"), cand("/api/:x/active")];
    expect(pickRoute("GET", "/api/customers/active", three)).toEqual({
      item: "GET /api/customers/:id",
      match: { confidence: "param", literals: 2, reason: "literal segment preferred over a parameter" },
    });
  });

  it("keeps a real tie a guess: same literal positions, or a splat route in the tie", () => {
    expect(pickRoute("GET", "/invoices/42", [cand("/invoices/:id"), cand("/invoices/:ref")])!.match.confidence).toBe("guess");
    const splat = [cand("/files/*"), cand("/:kind/readme")];
    expect(pickRoute("GET", "/files/readme", splat)!.match).toEqual({
      confidence: "guess", literals: 1, reason: "tie between equally specific routes",
    });
  });

  it("breaks an equal-literal tie by match confidence: exact :slug beats guess /feed", () => {
    const candidates = [cand("/api/articles/feed"), cand("/api/articles/:slug")];
    expect(pickRoute("GET", "/api/articles/:slug", candidates)).toEqual({
      item: "GET /api/articles/:slug",
      match: { confidence: "exact", literals: 2 },
    });
  });

  it("drops a call-param-vs-route-literal guess when a less-specific candidate also matched", () => {
    // "/customers/active" is the most specific (1 literal) but only a guess; "/:section/:id" also
    // matches (0 literals, confidence "param") so the guess is not the sole candidate and is dropped.
    const candidates = [cand("/customers/active"), cand("/:section/:id")];
    expect(pickRoute("GET", "/customers/:id", candidates)).toBeNull();
  });

  it("keeps a call-param-vs-route-literal guess when it is the only matching candidate", () => {
    const candidates = [cand("/customers/active")];
    expect(pickRoute("GET", "/customers/:id", candidates)).toEqual({
      item: "GET /customers/active",
      match: { confidence: "guess", literals: 1, reason: "call segment is a variable" },
    });
  });

  it("falls back to a suffix match under an unknown mount only when unique", () => {
    const one = [cand("/invoices/:id/pay", "POST", false)];
    expect(pickRoute("POST", "/billing/invoices/42/pay", one)).toEqual({
      item: "POST /invoices/:id/pay",
      match: { confidence: "guess", literals: 2, reason: "suffix match under unknown mount" },
    });

    // "/:prefix/pay" also matches the call's last 2 segments, so the suffix match is no longer unique.
    const two = [cand("/invoices/:id/pay", "POST", false), cand("/:prefix/pay", "POST", false)];
    expect(pickRoute("POST", "/billing/invoices/42/pay", two)).toBeNull();
  });

  it("prefers a known-mount match over an unknown-mount suffix match", () => {
    const candidates = [cand("/billing/invoices/:id/pay", "POST", true), cand("/invoices/:id/pay", "POST", false)];
    const picked = pickRoute("POST", "/billing/invoices/42/pay", candidates);
    expect(picked!.item).toBe("POST /billing/invoices/:id/pay");
  });

  it("returns null when nothing matches", () => {
    expect(pickRoute("GET", "/nope", [cand("/customers")])).toBeNull();
    expect(pickRoute("POST", "/customers", [cand("/customers", "GET")])).toBeNull();
  });
});
