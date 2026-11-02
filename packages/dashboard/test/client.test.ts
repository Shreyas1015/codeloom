import { describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, MapStateError, SessionError } from "@/api/client";

function stubFetch(body: unknown, status: number) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("apiGet", () => {
  it("fetches same-origin with credentials and query params", async () => {
    const fetch = stubFetch({ ok: 1 }, 200);
    await expect(apiGet("/api/graph", { repo: "api", dir: "", skip: undefined })).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledWith("/api/graph?repo=api&dir=", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("401 → SessionError", async () => {
    stubFetch({ error: "no session" }, 401);
    await expect(apiGet("/api/overview")).rejects.toBeInstanceOf(SessionError);
  });

  it("409 → MapStateError with its code", async () => {
    stubFetch({ error: "not indexed", code: "not-indexed" }, 409);
    const err = await apiGet("/api/overview").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MapStateError);
    expect((err as MapStateError).code).toBe("not-indexed");
    expect((err as MapStateError).message).toBe("not indexed");
  });

  it("409 keeps the no-workspace and bad-data codes; an unknown code reads as not-indexed", async () => {
    for (const code of ["no-workspace", "bad-data"]) {
      stubFetch({ error: "x", code }, 409);
      expect(((await apiGet("/api/overview").catch((e: unknown) => e)) as MapStateError).code).toBe(code);
    }
    stubFetch({ error: "x", code: "weird" }, 409);
    expect(((await apiGet("/api/overview").catch((e: unknown) => e)) as MapStateError).code).toBe("not-indexed");
  });

  it("other errors → ApiError with status and message", async () => {
    stubFetch({ error: "nope" }, 404);
    const err = await apiGet("/api/journeys/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe("nope");
  });
});
