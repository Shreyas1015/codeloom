import { type QueryClient, type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { ChangeEvent, ChangeKey } from "./types.js";

/** One query-key predicate per affected family, or "all". */
export type Invalidation = "all" | Array<(key: QueryKey) => boolean>;

const named = (name: string) => (key: QueryKey) => key[0] === name;
const ofRepo = (name: string, repo: string) => (key: QueryKey) => key[0] === name && key[1] === repo;

/** Which cached queries a set of change keys makes stale (the Plan 3 registry):
 * - workspace → all
 * - chains, journeys → overview, journeys, journey/*
 * - repo:<id> → overview, graph/<id>/*, node/*, neighbors/*, layers/<id> (and the all-repos layers), code/<id>/* */
export function invalidationFilters(keys: readonly ChangeKey[]): Invalidation {
  if (keys.includes("workspace")) return "all";
  const preds: Array<(key: QueryKey) => boolean> = [];
  if (keys.includes("chains") || keys.includes("journeys")) preds.push(named("overview"), named("journeys"), named("journey"));
  for (const k of keys) {
    if (!k.startsWith("repo:")) continue;
    const repo = k.slice("repo:".length);
    preds.push(
      named("overview"),
      ofRepo("graph", repo),
      named("node"),
      named("neighbors"),
      ofRepo("layers", repo),
      (key) => key[0] === "layers" && key[1] === null,
      ofRepo("code", repo),
    );
  }
  return preds;
}

/** Mark the affected queries stale; the ones on screen refetch. */
export function applyChange(queryClient: QueryClient, keys: readonly ChangeKey[]): void {
  const inv = invalidationFilters(keys);
  if (inv === "all") {
    void queryClient.invalidateQueries();
    return;
  }
  if (inv.length === 0) return;
  void queryClient.invalidateQueries({ predicate: (q) => inv.some((p) => p(q.queryKey)) });
}

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Live updates: listens to /api/events and invalidates the queries each change touches. On an error it
 * closes the stream and reconnects with backoff (1 s, 2 s, 4 s … 30 s); `paused` is true from the error
 * until a stream opens again, and on reopening every query is invalidated, since changes may have been
 * missed meanwhile. Mount once (the shell). */
export function useMapEvents(): { paused: boolean } {
  const queryClient = useQueryClient();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let es: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = FIRST_RETRY_MS;
    let missed = false;
    let disposed = false;

    const onChange = (e: MessageEvent) => {
      let data: ChangeEvent;
      try {
        data = JSON.parse(String(e.data)) as ChangeEvent;
      } catch {
        return;
      }
      if (Array.isArray(data?.keys)) applyChange(queryClient, data.keys.filter((k) => typeof k === "string"));
    };

    const connect = () => {
      if (disposed) return;
      const source = new EventSource("/api/events");
      es = source;
      source.addEventListener("change", onChange as EventListener);
      source.onopen = () => {
        retryMs = FIRST_RETRY_MS;
        setPaused(false);
        if (missed) {
          missed = false;
          void queryClient.invalidateQueries();
        }
      };
      source.onerror = () => {
        // Take over from the browser's own retry, so a 401 or a stopped server backs off too.
        source.close();
        if (disposed || es !== source) return;
        missed = true;
        setPaused(true);
        const wait = retryMs;
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        timer = setTimeout(connect, wait);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [queryClient]);

  return { paused };
}
