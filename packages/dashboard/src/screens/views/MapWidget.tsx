/** A view's map widget: one folder level of one repo on the Map's own canvas, with its layer or journey
 * overlay. Files open into their functions in place; a folder or function opens the full Map there. */
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { ApiError } from "@/api/client";
import { useGraphLevel, useJourney, useOverview } from "@/api/queries";
import type { GraphFile } from "@/api/types";
import { cn } from "@/lib/utils";
import { MapCanvas } from "@/screens/map/MapCanvas";
import { journeyStops, levelItems } from "@/screens/map/layout";
import { EmptyCard, H2 } from "./parts";

const OPEN =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] font-semibold transition-colors outline-offset-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring motion-reduce:transition-none";

export function MapWidget({ repo, overlay, dir = "" }: { repo: string; overlay?: string; dir?: string }) {
  const id = useId();
  const navigate = useNavigate();
  const overview = useOverview();
  const known = overview.data ? overview.data.repos.some((r) => r.id === repo) : undefined;
  const journeyId = overlay?.startsWith("journey:") ? overlay.slice("journey:".length) : undefined;
  const layers = overlay === "layer";
  const level = useGraphLevel(known ? repo : undefined, dir);
  const journey = useJourney(known ? journeyId : undefined);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | undefined>();

  const { items } = useMemo(() => (level.data ? levelItems(level.data, selected) : { items: [], hidden: 0 }), [level.data, selected]);
  const stops = useMemo(() => (journey.data ? journeyStops(journey.data, repo) : undefined), [journey.data, repo]);
  const journeyGone = journey.error instanceof ApiError && journey.error.status === 404;

  const search = { repo, ...(dir ? { dir } : {}), ...(overlay ? { overlay } : {}) };
  const openFolder = useCallback((path: string) => void navigate({ to: "/map", search: { ...search, dir: path } }), [navigate, search]);
  const openFunction = useCallback((ref: string) => void navigate({ to: "/map", search: { ...search, node: ref } }), [navigate, search]);
  const toggleFile = useCallback((file: GraphFile) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(file.path)) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  }, []);

  const where = dir ? `${repo}/${dir}` : repo;
  const caption = journeyId
    ? journeyGone
      ? `The journey ${journeyId} is not in this workspace any more; shown without its stops.`
      : `${journey.data?.journey?.name ?? journeyId}: its stops in ${repo}`
    : layers
      ? "Coloured by layer"
      : undefined;

  return (
    <section aria-label={`Map of ${where}`} aria-describedby={caption ? id : undefined} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={H2}>
            Map · <span className="font-mono text-[17px] font-semibold">{where}</span>
          </h2>
          {caption && (
            <p id={id} className="text-[13px] text-muted-foreground">
              {caption}
            </p>
          )}
        </div>
        {known && (
          <Link to="/map" search={search} className={OPEN}>
            Open in Map
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        )}
      </div>
      {known === false ? (
        <EmptyCard>
          <span className="font-mono text-[12.5px] text-foreground">{repo}</span> is not a repo in this workspace. Ask your agent to update this view.
        </EmptyCard>
      ) : (
        <div className={cn("relative h-[420px] overflow-hidden rounded-xl border border-border bg-[#EEF0EC]")}>
          {overview.error || level.error ? (
            <Centered alert>{(overview.error ?? level.error)!.message}</Centered>
          ) : !level.data ? (
            <Centered>Loading the map…</Centered>
          ) : items.length === 0 ? (
            <Centered>This folder has no mapped files.</Centered>
          ) : (
            <MapCanvas
              level={level.data}
              items={items}
              expanded={expanded}
              {...(selected ? { selectedFolder: selected } : {})}
              {...(stops ? { stops } : {})}
              layers={layers}
              onSelectFolder={setSelected}
              onOpenFolder={openFolder}
              onToggleFile={toggleFile}
              onSelectFunction={openFunction}
            />
          )}
        </div>
      )}
    </section>
  );
}

function Centered({ children, alert = false }: { children: React.ReactNode; alert?: boolean }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <p role={alert ? "alert" : "status"} className={cn("max-w-md text-center text-[14px]", alert ? "text-destructive" : "text-muted-foreground")}>
        {children}
      </p>
    </div>
  );
}
