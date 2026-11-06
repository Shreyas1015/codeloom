import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidationFilters, useMapEvents } from "@/api/events";

/** A scriptable EventSource: tests call open(), change(keys) and fail(). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  change(keys: string[]) {
    for (const fn of this.listeners.get("change") ?? []) fn(new MessageEvent("change", { data: JSON.stringify({ keys }) }));
  }
  fail() {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
}

const KEYS: QueryKey[] = [
  ["overview"],
  ["journeys"],
  ["journey", "j_a"],
  ["journey", "ch_b"],
  ["graph", "api", ""],
  ["graph", "api", "app"],
  ["graph", "web", ""],
  ["node", "api::file:a.ts"],
  ["node", "web::file:b.ts"],
  ["neighbors", "api::file:a.ts", 1, "both"],
  ["layers", "api"],
  ["layers", "web"],
  ["layers", null],
  ["code", "api", "a.ts", 1, 10],
  ["code", "web", "b.ts", null, null],
  ["search", "cart", [], null],
];

function setup(keys: QueryKey[] = KEYS) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const k of keys) queryClient.setQueryData(k, { cached: true });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useMapEvents(), { wrapper });
  const invalidated = () =>
    queryClient
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => JSON.stringify(q.queryKey))
      .sort();
  return { queryClient, hook, invalidated, es: () => FakeEventSource.instances.at(-1)! };
}

const str = (keys: QueryKey[]) => keys.map((k) => JSON.stringify(k)).sort();

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useMapEvents", () => {
  it("opens one EventSource on /api/events and closes it on unmount", () => {
    const { hook, es } = setup();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es().url).toBe("/api/events");
    hook.unmount();
    expect(es().closed).toBe(true);
  });

  it("journeys → overview, journeys, every journey/*, every graph/*, node/* (it lists journeys) and every search/*", () => {
    const { es, invalidated } = setup();
    act(() => es().open());
    act(() => es().change(["journeys"]));
    expect(invalidated()).toEqual(str([["overview"], ["journeys"], ["journey", "j_a"], ["journey", "ch_b"], ["graph", "api", ""], ["graph", "api", "app"], ["graph", "web", ""], ["node", "api::file:a.ts"], ["node", "web::file:b.ts"], ["search", "cart", [], null]]));
  });

  it("chains → overview, journeys, every journey/*, every graph/*, node/* (it lists journeys) and every search/*", () => {
    const { es, invalidated } = setup();
    act(() => es().change(["chains"]));
    expect(invalidated()).toEqual(str([["overview"], ["journeys"], ["journey", "j_a"], ["journey", "ch_b"], ["graph", "api", ""], ["graph", "api", "app"], ["graph", "web", ""], ["node", "api::file:a.ts"], ["node", "web::file:b.ts"], ["search", "cart", [], null]]));
  });

  it("repo:<id> → overview, that repo's graph/layers/code, every node/neighbors, the all-repos layers and every search/*", () => {
    const { es, invalidated } = setup();
    act(() => es().change(["repo:api"]));
    expect(invalidated()).toEqual(
      str([
        ["overview"],
        ["graph", "api", ""],
        ["graph", "api", "app"],
        ["node", "api::file:a.ts"],
        ["node", "web::file:b.ts"],
        ["neighbors", "api::file:a.ts", 1, "both"],
        ["layers", "api"],
        ["layers", null],
        ["code", "api", "a.ts", 1, 10],
        ["search", "cart", [], null],
      ]),
    );
  });

  it("workspace → everything", () => {
    const { es, invalidated } = setup();
    act(() => es().change(["workspace"]));
    expect(invalidated()).toEqual(str(KEYS));
  });

  it("several keys in one event → the union", () => {
    const { es, invalidated } = setup();
    act(() => es().change(["journeys", "repo:web"]));
    expect(invalidated()).toEqual(
      str([
        ["overview"],
        ["journeys"],
        ["journey", "j_a"],
        ["journey", "ch_b"],
        ["graph", "api", ""],
        ["graph", "api", "app"],
        ["graph", "web", ""],
        ["node", "api::file:a.ts"],
        ["node", "web::file:b.ts"],
        ["neighbors", "api::file:a.ts", 1, "both"],
        ["layers", "web"],
        ["layers", null],
        ["code", "web", "b.ts", null, null],
        ["search", "cart", [], null],
      ]),
    );
  });

  it("ignores a malformed event", () => {
    const { es, invalidated } = setup();
    act(() => {
      for (const fn of (es() as unknown as { listeners: Map<string, Array<(e: MessageEvent) => void>> }).listeners.get("change") ?? []) {
        fn(new MessageEvent("change", { data: "not json" }));
      }
    });
    expect(invalidated()).toEqual([]);
  });

  it("on error: paused, reconnects with backoff, and on reopening refetches everything (changes may have been missed)", () => {
    vi.useFakeTimers();
    const { es, hook, invalidated } = setup();
    act(() => es().open());
    expect(hook.result.current.paused).toBe(false);

    act(() => es().fail());
    expect(hook.result.current.paused).toBe(true);
    const first = es();
    expect(first.closed).toBe(true);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);

    // Fails again: the next wait doubles.
    act(() => es().fail());
    act(() => vi.advanceTimersByTime(1999));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(3);

    expect(invalidated()).toEqual([]);
    act(() => es().open());
    expect(hook.result.current.paused).toBe(false);
    expect(invalidated()).toEqual(str(KEYS));

    hook.unmount();
    expect(es().closed).toBe(true);
  });

  it("the backoff is capped at 30 s and resets after a successful open", () => {
    vi.useFakeTimers();
    const { es } = setup();
    for (let i = 0; i < 8; i++) {
      act(() => es().fail());
      act(() => vi.advanceTimersByTime(30_000));
    }
    expect(FakeEventSource.instances).toHaveLength(9);
    act(() => es().open());
    act(() => es().fail());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeEventSource.instances).toHaveLength(10);
  });

  it("does nothing where EventSource does not exist", () => {
    vi.stubGlobal("EventSource", undefined);
    const { hook } = setup();
    expect(hook.result.current.paused).toBe(false);
  });
});

describe("tours and progress keys", () => {
  const V2B: QueryKey[] = [...KEYS, ["progress"], ["tour", "j_a"], ["tour", "j_c"]];

  it("tours → every tour/* and every journey/*", () => {
    const { es, invalidated } = setup(V2B);
    act(() => es().change(["tours"]));
    expect(invalidated()).toEqual(str([["tour", "j_a"], ["tour", "j_c"], ["journey", "j_a"], ["journey", "ch_b"]]));
  });

  it("progress → progress, overview and journeys (and nothing else)", () => {
    const { es, invalidated } = setup(V2B);
    act(() => es().change(["progress"]));
    expect(invalidated()).toEqual(str([["progress"], ["overview"], ["journeys"]]));
  });

  it("journeys, chains and repo:<id> also make progress and tours stale (stops and file hashes may have moved)", () => {
    for (const key of ["journeys", "chains", "repo:api"]) {
      const { es, invalidated } = setup(V2B);
      act(() => es().change([key]));
      expect(invalidated(), key).toEqual(expect.arrayContaining(str([["progress"], ["tour", "j_a"], ["tour", "j_c"]])));
    }
  });

  it("workspace → everything, tours and progress included", () => {
    const { es, invalidated } = setup(V2B);
    act(() => es().change(["workspace"]));
    expect(invalidated()).toEqual(str(V2B));
  });
});

describe("invalidationFilters", () => {
  it("maps workspace to everything", () => {
    expect(invalidationFilters(["workspace"])).toBe("all");
  });
});
