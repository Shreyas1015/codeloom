/** Map (`/map`): one repo at a time, one folder level at a time. Folders open into files, files open into
 * their functions. Overlays: a journey's stops, or layers. Search jumps to a file or function. */
import { useNavigate, useSearch as useRouteSearch } from "@tanstack/react-router";
import { ChevronRight, Layers } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useGraphLevel, useJourney, useJourneys, useOverview } from "@/api/queries";
import type { GraphFile, GraphLevel, Lane, SearchHit } from "@/api/types";
import { isBlocking, MapStateScreen } from "@/components/shell/StateBanner";
import { cn } from "@/lib/utils";
import type { MapSearch as MapSearchParams } from "@/router";
import { Inspector } from "./Inspector";
import { MapCanvas } from "./MapCanvas";
import { MapSearch } from "./MapSearch";
import { dirOf, fileOfRef, journeyStops, laneOfLayer, levelItems } from "./layout";

const clean = (s: MapSearchParams): MapSearchParams =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined && v !== "")) as MapSearchParams;

const toolButton = (on: boolean) =>
  cn(
    "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-[13px] font-semibold transition-colors motion-reduce:transition-none",
    on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground hover:bg-muted",
  );

const LANE_SWATCH: Record<Lane, string> = {
  ui: "bg-lane-ui",
  api: "bg-lane-api",
  code: "bg-lane-code",
  db: "bg-lane-db",
  queue: "bg-lane-queue",
};

export function MapScreen() {
  const search = useRouteSearch({ strict: false }) as MapSearchParams;
  const navigate = useNavigate();
  const overview = useOverview();
  const repos = overview.data?.repos ?? [];
  const repo = search.repo ?? repos[0]?.id;
  const dir = search.dir ?? "";
  const selectedRef = search.node;
  const journeyId = search.overlay?.startsWith("journey:") ? search.overlay.slice("journey:".length) : undefined;
  const layers = search.overlay === "layer";

  const go = useCallback(
    (patch: MapSearchParams) => {
      void navigate({ to: "/map", search: (prev: MapSearchParams) => clean({ ...prev, ...patch }) });
    },
    [navigate],
  );

  const levelQuery = useGraphLevel(repo, dir);
  // a body that is not a level (an old server, a proxy page) reads as an error, not a crash
  const level = levelQuery.data && !isLevel(levelQuery.data) ? { ...levelQuery, data: undefined, isError: true as const, error: new Error("The map server sent something that is not a folder level.") } : levelQuery;
  const journey = useJourney(journeyId);
  const journeysList = useJourneys();

  // files opened by click, per level; a selected function's file is always open
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [selectedFolder, setSelectedFolder] = useState<string | undefined>();
  useEffect(() => {
    setOpened(new Set());
    setSelectedFolder(undefined);
  }, [repo, dir]);

  const selectedFile = selectedRef ? fileOfRef(selectedRef) : undefined;
  const expanded = useMemo(() => {
    const s = new Set(opened);
    if (selectedRef && selectedFile && !selectedRef.includes("::file:")) s.add(selectedFile);
    return s;
  }, [opened, selectedRef, selectedFile]);

  const { items, hidden } = useMemo(
    () => (level.data ? levelItems(level.data, selectedFile ?? selectedFolder) : { items: [], hidden: 0 }),
    [level.data, selectedFile, selectedFolder],
  );
  const stops = useMemo(() => (journey.data && repo ? journeyStops(journey.data, repo) : undefined), [journey.data, repo]);

  const openFolder = useCallback((path: string) => go({ dir: path, node: undefined }), [go]);
  const selectFolder = useCallback(
    (path: string) => {
      setSelectedFolder(path);
      go({ node: undefined });
    },
    [go],
  );
  const toggleFile = useCallback(
    (file: GraphFile) => {
      setSelectedFolder(undefined);
      setOpened((prev) => {
        const next = new Set(prev);
        if (next.has(file.path)) next.delete(file.path);
        else next.add(file.path);
        return next;
      });
      go({ node: file.ref });
    },
    [go],
  );
  const selectFunction = useCallback(
    (ref: string) => {
      setSelectedFolder(undefined);
      go({ node: ref });
    },
    [go],
  );
  const jumpTo = useCallback(
    (ref: string, file?: string) => {
      const f = file ?? fileOfRef(ref);
      if (f === undefined) return;
      go({ dir: dirOf(f) || undefined, node: ref });
    },
    [go],
  );
  const pickHit = useCallback((hit: SearchHit) => jumpTo(hit.ref, hit.file), [jumpTo]);

  const levelFile = level.data?.files.find((f) => f.ref === selectedRef || f.functions.some((fn) => fn.ref === selectedRef));
  const levelFolder = level.data?.folders.find((f) => f.path === selectedFolder);

  const journeyOptions = (Array.isArray(journeysList.data?.journeys) ? journeysList.data.journeys : []).filter((j) => !repo || j.repos.includes(repo) || j.id === journeyId);
  const crumbs = dir ? dir.split("/") : [];
  const layerNames = useMemo(() => [...new Set(items.map((i) => i.layer).filter((l): l is string => !!l))].sort(), [items]);
  const stopsHere = stops ? [...stops.values()].reduce((n, l) => n + l.length, 0) : 0;

  return (
    <section data-testid="screen-map" aria-labelledby="map-title" className="flex min-h-[620px] flex-1 flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 id="map-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em]">
            Map
          </h1>
          {repo && (
            <nav aria-label="Folder" className="min-w-0">
              <ol className="flex flex-wrap items-center gap-0.5 font-mono text-[12.5px] text-muted-foreground">
                <li>
                  {crumbs.length ? (
                    <button type="button" onClick={() => go({ dir: undefined, node: undefined })} className="cursor-pointer rounded px-1 hover:bg-muted hover:text-foreground">
                      {repo}
                    </button>
                  ) : (
                    <span aria-current="location" className="px-1 font-semibold text-foreground">
                      {repo}
                    </span>
                  )}
                </li>
                {crumbs.map((c, i) => {
                  const path = crumbs.slice(0, i + 1).join("/");
                  const last = i === crumbs.length - 1;
                  return (
                    <li key={path} className="flex items-center gap-0.5">
                      <ChevronRight aria-hidden className="size-3" />
                      {last ? (
                        <span aria-current="location" className="px-1 font-semibold text-foreground">
                          {c}
                        </span>
                      ) : (
                        <button type="button" onClick={() => go({ dir: path, node: undefined })} className="cursor-pointer rounded px-1 hover:bg-muted hover:text-foreground">
                          {c}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            </nav>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Repo" className="flex flex-wrap gap-1.5">
          {repos.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === repo}
              onClick={() => go({ repo: r.id, dir: undefined, node: undefined })}
              className={cn(toolButton(r.id === repo), "font-mono font-normal")}
            >
              {r.id}
            </button>
          ))}
        </div>
        <span aria-hidden className="mx-1 h-5.5 w-px bg-border" />
        <button type="button" aria-pressed={layers} onClick={() => go({ overlay: layers ? undefined : "layer" })} className={toolButton(layers)}>
          <Layers aria-hidden className="size-3.5" />
          Layers
        </button>
        <label className="sr-only" htmlFor="map-journey-overlay">
          Journey overlay
        </label>
        <select
          id="map-journey-overlay"
          value={journeyId ?? ""}
          onChange={(e) => go({ overlay: e.target.value ? `journey:${e.target.value}` : undefined })}
          className={cn(
            "h-8 max-w-64 cursor-pointer truncate rounded-md border px-2.5 text-[13px]",
            journeyId ? "border-[#EBCB86] bg-accent-soft font-semibold text-accent-foreground" : "border-border bg-card",
          )}
        >
          <option value="">No journey overlay</option>
          {journeyOptions.map((j) => (
            <option key={j.id} value={j.id}>
              {j.name}
            </option>
          ))}
        </select>
        {repo && (
          <div className="ml-auto">
            <MapSearch repo={repo} onPick={pickHit} />
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px] overflow-hidden rounded-xl border border-border">
        <div className="relative min-h-[520px] min-w-0">
          {overview.isError && !repo ? (
            <Message alert>{overview.error.message}</Message>
          ) : !repo ? (
            overview.isPending ? <Message>Loading the map…</Message> : <Message>No repos in this workspace yet.</Message>
          ) : level.isError ? (
            isBlocking(level.error) ? (
              <div className="h-full min-h-[520px] overflow-y-auto bg-card px-8">
                <MapStateScreen error={level.error} />
              </div>
            ) : (
              <Message alert>{level.error.message}</Message>
            )
          ) : level.isPending ? (
            <Message>Loading the map…</Message>
          ) : items.length === 0 ? (
            <Message>This folder has no mapped files.</Message>
          ) : (
            <>
              <MapCanvas
                level={level.data}
                items={items}
                expanded={expanded}
                {...(selectedRef ? { selectedRef } : {})}
                {...(selectedFolder ? { selectedFolder } : {})}
                {...(stops ? { stops } : {})}
                layers={layers}
                onSelectFolder={selectFolder}
                onOpenFolder={openFolder}
                onToggleFile={toggleFile}
                onSelectFunction={selectFunction}
              />
              <Legend layers={layers ? layerNames : undefined} journey={journeyId ? (journey.data?.journey?.name ?? journeyId) : undefined} stopsHere={stopsHere} hidden={hidden} repo={repo} />
            </>
          )}
        </div>
        <Inspector
          repo={repo ?? ""}
          {...(selectedRef ? { selectedRef } : {})}
          {...(levelFile ? { file: levelFile } : {})}
          {...(levelFolder ? { folder: levelFolder } : {})}
          onOpenFolder={openFolder}
          onJump={jumpTo}
        />
      </div>
    </section>
  );
}

function isLevel(v: unknown): v is GraphLevel {
  const l = v as GraphLevel;
  return typeof l === "object" && l !== null && Array.isArray(l.folders) && Array.isArray(l.files) && Array.isArray(l.edges);
}

function Message({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <div className="grid h-full min-h-[520px] place-items-center bg-[#EEF0EC] p-6">
      <p role={alert ? "alert" : "status"} className={cn("max-w-md text-center text-[14px]", alert ? "text-destructive" : "text-muted-foreground")}>
        {children}
      </p>
    </div>
  );
}

function Legend({ layers, journey, stopsHere, hidden, repo }: { layers?: string[]; journey?: string; stopsHere: number; hidden: number; repo: string }) {
  if (!layers?.length && !journey && !hidden) return null;
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex max-w-[70%] flex-wrap items-center gap-x-3.5 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
      {layers?.map((l) => (
        <span key={l} className="flex items-center gap-1.5">
          <i aria-hidden className={cn("size-2.5 rounded-[3px]", LANE_SWATCH[laneOfLayer(l)])} />
          {l}
        </span>
      ))}
      {journey && (
        <span className="flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 rounded-full bg-accent" />
          {stopsHere ? `${journey}: stops in ${repo}` : `${journey} has no stops in ${repo}`}
        </span>
      )}
      {hidden > 0 && <span>{hidden.toLocaleString("en-US")} more not drawn</span>}
    </div>
  );
}
