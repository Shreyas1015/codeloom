import { describe, expect, it } from "vitest";
import { CodeloomError, dataError } from "../src/errors.js";
import { type ApiRoute, errorResponse, HttpError, matchRoute } from "../src/web/api.js";

const noop = () => null;
const routes: ApiRoute[] = [
  { path: "/api/overview", handler: noop },
  { path: "/api/journeys", handler: noop },
  { path: "/api/journeys/:id", handler: noop },
  { path: "/api/node/:ref", handler: noop },
];

describe("matchRoute", () => {
  it("matches fixed paths and :params (decoded)", () => {
    expect(matchRoute(routes, "/api/overview")?.route.path).toBe("/api/overview");
    expect(matchRoute(routes, "/api/journeys")?.route.path).toBe("/api/journeys");
    expect(matchRoute(routes, "/api/journeys/j_1")).toMatchObject({ route: { path: "/api/journeys/:id" }, params: { id: "j_1" } });
    expect(matchRoute(routes, "/api/node/api%3A%3Afile%3Asrc%2Fa.ts")?.params).toEqual({ ref: "api::file:src/a.ts" });
  });

  it("no match for unknown paths, extra segments, empty or undecodable params", () => {
    expect(matchRoute(routes, "/api/nope")).toBeNull();
    expect(matchRoute(routes, "/api/journeys/a/b")).toBeNull();
    expect(matchRoute(routes, "/api/journeys/")).toBeNull();
    expect(matchRoute(routes, "/api/journeys/%zz")).toBeNull();
  });
});

describe("errorResponse", () => {
  it("maps store and handler errors to statuses", () => {
    expect(errorResponse(new HttpError(400, "bad q"))).toEqual({ status: 400, body: { error: "bad q" } });
    expect(errorResponse(dataError('Repo "api" has no .codeloom data yet.', { code: "not-indexed" }))).toEqual({
      status: 409,
      body: { error: 'Repo "api" has no .codeloom data yet.', code: "not-indexed" },
    });
    expect(errorResponse(dataError("x.json is not valid JSON.")).body.code).toBe("bad-data");
    expect(errorResponse(dataError('Unknown journey "j_x".')).status).toBe(404);
    expect(errorResponse(dataError('Bad node reference "x".')).status).toBe(400);
    expect(errorResponse(new CodeloomError("git was not found")).status).toBe(500);
    expect(errorResponse(new Error("boom"))).toEqual({ status: 500, body: { error: "codeloom hit an unexpected error: boom" } });
  });
});
