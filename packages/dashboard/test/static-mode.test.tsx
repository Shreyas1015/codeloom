import { createHash } from "node:crypto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, renderHook, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { apiGet, ApiError, apiPost } from "@/api/client";
import { useMapEvents } from "@/api/events";
import { detectSnapshot, getSnapshot, isSnapshot, NotInSnapshotError, snapshotKey, startOnReview } from "@/api/static";
import type { CodeResponse, Overview } from "@/api/types";
import { ScreenError } from "@/components/shell/StateBanner";
import { SnapshotBanner } from "@/components/shell/SnapshotBanner";
import { createAppRouter } from "@/router";
import { WidgetView } from "@/screens/views/Widgets";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const MANIFEST = {
  version: 1,
  codeloom: "0.4.0",
  head: "a41c9e2abcdef0123456789abcdef0123456789",
  base: "b52d0f1abcdef0123456789abcdef0123456789",
  baseRef: "main",
  builtAt: "2026-11-13T00:00:00.000Z",
  pr: 12,
  repoSlug: "acme/widgets",
  files: [],
  omitted: { mapFolders: [], codeFiles: [] },
  bytes: 1234,
};

const EMPTY_OVERVIEW: Overview = {
  name: "demo",
  repos: [],
  chains: { total: 0, complete: 0, byConfidence: { exact: 0, param: 0, guess: 0 } },
  journeys: { total: 0, orphaned: 0 },
  unnamedChains: 0,
  indexStatus: { repos: [] },
  mcpConnected: true,
};

describe("snapshotKey", () => {
  it("drops the /api/ prefix and turns remaining slashes into ~", () => {
    expect(snapshotKey("/api/graph")).toBe("graph");
    expect(snapshotKey("/api/journeys/j_1")).toBe("journeys~j_1");
  });

  it("appends sorted params after @", () => {
    expect(snapshotKey("/api/graph", { repo: "api", dir: "app" })).toBe("graph@dir=app&repo=api");
  });

  it("drops undefined params and sorts the rest", () => {
    expect(snapshotKey("/api/code", { repo: "api", file: "a.ts", start: 1, end: undefined })).toBe("code@file=a.ts&repo=api&start=1");
  });

  it("a key with any character outside [A-Za-z0-9._~@=&-] (here the %2F of an encoded \"/\") is made safe: unsafe chars → _, cut to 80, + '-' + 16 hex of the full key's sha256", () => {
    const full = "graph@dir=app%2Fservices&repo=api";
    const expectedHash = createHash("sha256").update(full).digest("hex").slice(0, 16);
    expect(snapshotKey("/api/graph", { repo: "api", dir: "app/services" })).toBe(`graph@dir=app_2Fservices&repo=api-${expectedHash}`);
  });

  it("a file path with [ ] ( ) + $ space or non-ASCII never yields an unsafe file name", () => {
    for (const file of ["app/customers/[id]/page.tsx", "app/(shop)/page.tsx", "routes/+page.svelte", "routes/$id.tsx", "a b.md", "café.md"]) {
      expect(snapshotKey(`/api/files/web/${file}`), file).toMatch(/^[A-Za-z0-9._~@=&-]+$/);
    }
  });

  it("no params → just the path part", () => {
    expect(snapshotKey("/api/overview", {})).toBe("overview");
  });

  it("a key over 120 chars is cut to 80 chars + '-' + the first 16 hex chars of its sha256", () => {
    const longFile = `src/${"a".repeat(140)}.ts`;
    const key = snapshotKey("/api/code", { repo: "api", file: longFile });
    const full = `code@file=${encodeURIComponent(longFile)}&repo=api`;
    expect(full.length).toBeGreaterThan(120);
    const expectedHash = createHash("sha256").update(full).digest("hex").slice(0, 16);
    expect(key).toBe(`${full.replace(/[^A-Za-z0-9._~@=&-]/g, "_").slice(0, 80)}-${expectedHash}`);
    expect(key.length).toBe(80 + 1 + 16);
  });

  it("a key at or under 120 chars is left alone", () => {
    const key = snapshotKey("/api/journeys/j_short");
    expect(key.length).toBeLessThanOrEqual(120);
    expect(key).toBe("journeys~j_short");
  });
});

describe("detectSnapshot / isSnapshot", () => {
  it("200 + version 1 → the manifest's info, and isSnapshot() becomes true", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      expect(url).toBe("./data/manifest.json");
      return json(MANIFEST);
    });
    const info = await detectSnapshot(fetch);
    expect(info).toEqual({
      pr: 12,
      repoSlug: "acme/widgets",
      head: MANIFEST.head,
      base: MANIFEST.base,
      baseRef: "main",
      builtAt: MANIFEST.builtAt,
      omitted: { mapFolders: [], codeFiles: [] },
    });
    expect(isSnapshot()).toBe(true);
    expect(getSnapshot()).toEqual(info);
  });

  it("404 → null, and isSnapshot() stays false", async () => {
    const fetch = vi.fn(async () => json({ error: "not found" }, 404));
    expect(await detectSnapshot(fetch)).toBeNull();
    expect(isSnapshot()).toBe(false);
  });

  it("final review m1: a manifest with no baseRef (or a non-string one) leaves baseRef out", async () => {
    const { baseRef: _drop, ...noRef } = MANIFEST;
    expect(await detectSnapshot(vi.fn(async () => json(noRef)))).not.toHaveProperty("baseRef");
    expect(await detectSnapshot(vi.fn(async () => json({ ...MANIFEST, baseRef: 7 })))).not.toHaveProperty("baseRef");
  });

  it("a manifest with an unknown version → null", async () => {
    const fetch = vi.fn(async () => json({ ...MANIFEST, version: 2 }));
    expect(await detectSnapshot(fetch)).toBeNull();
    expect(isSnapshot()).toBe(false);
  });

  it("a network error → null, not a throw", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await detectSnapshot(fetch)).toBeNull();
    expect(isSnapshot()).toBe(false);
  });
});

// ---- Everything below exercises the dashboard while isSnapshot() is true: set it once, up front, the way
// main.tsx does at boot. (isSnapshot's state is module-level and this file gets its own fresh module
// graph from vitest, so this has no effect on any other test file.) ----------------------------------

describe("in static mode", () => {
  beforeAll(async () => {
    const fetch = vi.fn(async () => json(MANIFEST));
    const info = await detectSnapshot(fetch);
    expect(info).not.toBeNull();
    expect(isSnapshot()).toBe(true);
  });

  describe("staticGet (through apiGet)", () => {
    it('apiGet("/api/journeys") fetches ./data/journeys.json', async () => {
      const fetch = vi.fn(async (url: string) => {
        if (url === "./data/journeys.json") return json({ journeys: [], unnamedChains: [] });
        return json({ error: "not found" }, 404);
      });
      vi.stubGlobal("fetch", fetch);
      await expect(apiGet("/api/journeys")).resolves.toEqual({ journeys: [], unnamedChains: [] });
      expect(fetch).toHaveBeenCalledWith("./data/journeys.json", expect.objectContaining({ headers: expect.anything() }));
    });

    it('apiGet("/api/journeys/j_1") fetches ./data/journeys~j_1.json', async () => {
      const fetch = vi.fn(async (url: string) => (url === "./data/journeys~j_1.json" ? json({ ok: true }) : json({}, 404)));
      vi.stubGlobal("fetch", fetch);
      await expect(apiGet("/api/journeys/j_1")).resolves.toEqual({ ok: true });
    });

    it("a missing data file → NotInSnapshotError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ error: "no such file" }, 404)),
      );
      await expect(apiGet("/api/layers")).rejects.toBeInstanceOf(NotInSnapshotError);
    });

    it("/api/code loads the stored whole file and slices it like the server's sliceCode", async () => {
      const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      const fetch = vi.fn(async (url: string) => {
        if (url === "./data/files~api~app~service.ts.json") return json({ file: "app/service.ts", text });
        return json({}, 404);
      });
      vi.stubGlobal("fetch", fetch);
      const res = await apiGet<CodeResponse>("/api/code", { repo: "api", file: "app/service.ts", start: 2, end: 4 });
      expect(res).toEqual({ file: "app/service.ts", startLine: 2, endLine: 4, text: "line 2\nline 3\nline 4", truncated: false });
    });

    it("/api/code with no end slices to the end of the file and marks nothing truncated", async () => {
      const text = "a\nb\nc";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => (url === "./data/files~api~x.ts.json" ? json({ file: "x.ts", text }) : json({}, 404))),
      );
      const res = await apiGet<CodeResponse>("/api/code", { repo: "api", file: "x.ts", start: 1 });
      expect(res).toEqual({ file: "x.ts", startLine: 1, endLine: 3, text: "a\nb\nc", truncated: false });
    });

    it("final review C1/I2: /api/code for a Next.js [id] page reads the same key the writer wrote (snapshotKey of /api/files/<repo>/<file>)", async () => {
      const text = "export default function Page() {}";
      const fetch = vi.fn(async (url: string) =>
        url === "./data/files~web~app~customers~_id_~page.tsx-d15e5510e5cd4598.json" ? json({ file: "app/customers/[id]/page.tsx", text }) : json({}, 404),
      );
      vi.stubGlobal("fetch", fetch);
      const res = await apiGet<CodeResponse>("/api/code", { repo: "web", file: "app/customers/[id]/page.tsx", start: 1 });
      expect(res.text).toBe(text);
    });

    it("final review I2: /api/code for a path over 120 characters reads the writer's shortened key, not the raw path", async () => {
      const file = `app/${"a".repeat(100)}/very_long_file_name.ts`;
      const key = snapshotKey(`/api/files/api/${file}`);
      expect(key).toBe("files~api~app~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-9c28935ea4081ad5");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => (url === `./data/${key}.json` ? json({ file, text: "x" }) : json({}, 404))),
      );
      await expect(apiGet<CodeResponse>("/api/code", { repo: "api", file, start: 1 })).resolves.toMatchObject({ text: "x" });
    });

    it("final review I1: the fetch URL is the key, URL-encoded (a static host decodes the path back to the real file name)", async () => {
      const fetch = vi.fn(async (_url: string) => json({ ok: true }));
      vi.stubGlobal("fetch", fetch);
      await apiGet("/api/graph", { repo: "api" });
      expect(fetch).toHaveBeenCalledWith(`./data/${encodeURIComponent("graph@repo=api")}.json`, expect.anything());
    });

    it("a missing code file → NotInSnapshotError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({}, 404)),
      );
      await expect(apiGet<CodeResponse>("/api/code", { repo: "api", file: "gone.ts", start: 1 })).rejects.toBeInstanceOf(NotInSnapshotError);
    });

    it("a start past the end of the file → the same 400 ApiError the live server's sliceCode throws", async () => {
      const text = "a\nb\nc";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => (url === "./data/files~api~x.ts.json" ? json({ file: "x.ts", text }) : json({}, 404))),
      );
      const err = await apiGet<CodeResponse>("/api/code", { repo: "api", file: "x.ts", start: 9 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
      expect((err as ApiError).message).toBe("Bad range: x.ts has 3 lines; start 9 is past the end.");
    });
  });

  it("apiPost throws without making a network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(apiPost("/api/progress/seen", { journey: "j_1" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("useMapEvents opens no EventSource", () => {
    class TrackedEventSource {
      static count = 0;
      constructor() {
        TrackedEventSource.count++;
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", TrackedEventSource);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const hook = renderHook(() => useMapEvents(), { wrapper });
    expect(TrackedEventSource.count).toBe(0);
    expect(hook.result.current.paused).toBe(false);
  });

  it("Rail hides the Progress nav item", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url, "http://127.0.0.1");
        if (u.pathname === "/api/overview") return json(EMPTY_OVERVIEW);
        if (u.pathname === "/api/journeys") return json({ journeys: [], unnamedChains: [] });
        return json({ error: "not found" }, 404);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/review"] }) });
    render(<App router={router} queryClient={queryClient} />);
    const rail = await screen.findByRole("complementary", { name: "codeloom" });
    const nav = within(rail).getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByRole("link", { name: /Progress/ })).not.toBeInTheDocument();
  });

  it('Rail shows "This PR" first, current on /review; Home stays listed but is not current there', async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url, "http://127.0.0.1");
        if (u.pathname === "/api/overview") return json(EMPTY_OVERVIEW);
        if (u.pathname === "/api/journeys") return json({ journeys: [], unnamedChains: [] });
        return json({ error: "not found" }, 404);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/review"] }) });
    render(<App router={router} queryClient={queryClient} />);
    const rail = await screen.findByRole("complementary", { name: "codeloom" });
    const nav = within(rail).getByRole("navigation", { name: "Main" });
    const links = within(nav).getAllByRole("link");
    expect(links[0]).toHaveAccessibleName(/^This PR/);
    expect(links[0]).toHaveAttribute("aria-current", "page");
    const home = within(nav).getByRole("link", { name: /^Home/ });
    expect(home).not.toHaveAttribute("aria-current");
  });

  it("the search input on the Map screen is hidden", async () => {
    const overview: Overview = {
      ...EMPTY_OVERVIEW,
      repos: [{ id: "api", path: "api", role: "api", files: 1, nodes: 1, edges: 0, pages: 0, routes: 1, calls: 0, tables: 0, queues: 0 }],
    };
    const level = { repo: "api", dir: "", folders: [], files: [], edges: [] };
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input, "http://127.0.0.1");
      if (url.pathname === "/api/overview") return json(overview);
      if (url.pathname === "/api/graph") return json(level);
      if (url.pathname === "/api/journeys") return json({ journeys: [], unnamedChains: [] });
      return json({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetch);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/map"] }) });
    render(<App router={router} queryClient={queryClient} />);
    await screen.findByRole("group", { name: "Repo" });
    expect(screen.queryByPlaceholderText("Find a file or function")).not.toBeInTheDocument();
  });

  it("final review I5: \"/\" is Home in a snapshot too (the rail's Home works), rendered without progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "./data/overview.json") return json(EMPTY_OVERVIEW);
        if (url === "./data/journeys.json") return json({ journeys: [], unnamedChains: [] });
        return json({ error: "not found" }, 404);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<App router={router} queryClient={queryClient} />);
    expect(await screen.findByTestId("screen-home")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-review")).not.toBeInTheDocument();
  });

  it("final review I5: startOnReview sends an empty hash (\"\", \"#\", \"#/\") to #/review and leaves any other hash alone", () => {
    for (const hash of ["", "#", "#/"]) {
      const replaceState = vi.fn();
      startOnReview({ location: { hash }, history: { replaceState } });
      expect(replaceState, JSON.stringify(hash)).toHaveBeenCalledWith(null, "", "#/review");
    }
    for (const hash of ["#/journeys/j_1", "#/map?repo=api", "#/review"]) {
      const replaceState = vi.fn();
      startOnReview({ location: { hash }, history: { replaceState } });
      expect(replaceState, hash).not.toHaveBeenCalled();
    }
  });

  it("final review m2: progress and checks widgets say \"Not in this snapshot\" instead of loading forever", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <WidgetView widget={{ type: "progress", by: "repo" }} />
        <WidgetView widget={{ type: "progress", by: "area" }} />
        <WidgetView widget={{ type: "checks" }} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByText("Not in this snapshot: a snapshot never includes your own progress.")).toHaveLength(3);
    expect(screen.queryByLabelText(/Loading your/)).not.toBeInTheDocument();
  });

  it("/progress also redirects to /review (a snapshot never has progress, so the screen would load forever)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url, "http://127.0.0.1");
        if (u.pathname === "/api/overview") return json(EMPTY_OVERVIEW);
        return json({ error: "not found" }, 404);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/progress"] }) });
    render(<App router={router} queryClient={queryClient} />);
    expect(await screen.findByTestId("screen-review")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-progress")).not.toBeInTheDocument();
  });
});

describe("SnapshotBanner", () => {
  it('reads "Snapshot of PR #12 · commit a41c9e2 vs main · read-only" — the --base the user passed, not the merge-base SHA', () => {
    render(
      <SnapshotBanner
        snapshot={{
          pr: 12,
          head: "a41c9e2abcdef",
          base: "b52d0f1abcdef0123456789abcdef0123456789",
          baseRef: "main",
          builtAt: "2026-11-13T00:00:00.000Z",
          omitted: { mapFolders: [], codeFiles: [] },
        }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Snapshot of PR #12 · commit a41c9e2 vs main · read-only");
  });

  it("final review m1: with no baseRef, falls back to the base's 7-character SHA", () => {
    render(
      <SnapshotBanner
        snapshot={{ head: "a41c9e2abcdef", base: "b52d0f1abcdef0123456789abcdef0123456789", builtAt: "2026-11-13T00:00:00.000Z", omitted: { mapFolders: [], codeFiles: [] } }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Snapshot · commit a41c9e2 vs b52d0f1 · read-only");
  });
});

describe("NotInSnapshotError on screen", () => {
  it('shows "Not in this snapshot" through the shared ScreenError', () => {
    render(<ScreenError error={new NotInSnapshotError("/api/layers")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not in this snapshot: /api/layers");
  });
});
