import { useEffect, useMemo, useState } from "react";
import { useOverview, useReview } from "@/api/queries";
import { getSnapshot } from "@/api/static";
import type { Review, ReviewJourney, ReviewNodeChange, ReviewStop, SpecState } from "@/api/types";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { stopLabel } from "@/components/gallery/StopRoundel";
import { ScreenError } from "@/components/shell/StateBanner";
import { cn } from "@/lib/utils";
import { ReviewCodePanel, type ReviewLaneStop, StopNum } from "./ReviewCodePanel";

const LANE_ORDER = ["ui", "api", "code", "db", "queue"] as const;
const LANE_NAME: Record<string, string> = { ui: "UI", api: "API", code: "Code", db: "DB", queue: "Queue" };

const fmt = new Intl.NumberFormat("en-US");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** This journey's stops, across every chain it touches, deduped by ref and numbered 1..N in lane order
 * (UI, API, Code, DB, Queue) — the same board shape the approved mockup draws, just assembled from
 * `Review.chainStops` instead of a live journey's own stop list. */
function journeyStops(review: Review, journey: ReviewJourney): ReviewLaneStop[] {
  const byRef = new Map<string, ReviewStop>();
  for (const chainId of journey.chains) {
    for (const s of review.chainStops[chainId] ?? []) {
      if (!byRef.has(s.ref)) byRef.set(s.ref, s);
    }
  }
  const ordered = LANE_ORDER.flatMap((lane) => [...byRef.values()].filter((s) => s.lane === lane));
  return ordered.map((s, i) => ({ ...s, n: i + 1 }));
}

function specBadgeProps(mark: ReviewJourney["spec"]): { state: SpecState; checked: boolean } {
  if (mark === "unchecked") return { state: "none", checked: false };
  if (mark === "none") return { state: "none", checked: true };
  return { state: mark, checked: true };
}

/** Review ("This PR", `/review`): the start page of a hosted snapshot — every changed file and function,
 * the journeys and chains they touch, and (once a journey and a stop are picked) that stop's code. */
export function ReviewScreen() {
  const { data, error } = useReview();
  const overview = useOverview();
  const [journeyId, setJourneyId] = useState<string | undefined>(undefined);
  const [stopRef, setStopRef] = useState<string | undefined>(undefined);

  const journeys = data?.journeys ?? [];
  useEffect(() => {
    if (journeyId === undefined && journeys.length > 0) setJourneyId(journeys[0]!.id);
  }, [journeys, journeyId]);

  const journey = journeys.find((j) => j.id === journeyId);
  const stops = useMemo(() => (data && journey ? journeyStops(data, journey) : []), [data, journey]);
  const nodeByRef = useMemo(() => new Map((data?.nodes ?? []).map((n): [string, ReviewNodeChange] => [n.ref, n])), [data]);
  const journeyNameById = useMemo(() => new Map(journeys.map((j) => [j.id, j.name])), [journeys]);
  const selectedStop = stops.find((s) => s.ref === stopRef);
  const repoPath = (repo: string) => overview.data?.repos.find((r) => r.id === repo)?.path;

  const selectJourney = (id: string) => {
    setJourneyId(id);
    setStopRef(undefined);
  };

  return (
    <section data-testid="screen-review" aria-labelledby="review-title" className="flex flex-col gap-5.5">
      <h1 id="review-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
        What this PR touches
      </h1>

      {error ? (
        <ScreenError error={error} fallback="Something went wrong loading this PR's review." />
      ) : !data ? (
        <p role="status" aria-busy="true" className="text-[13px] text-muted-foreground">
          Loading this PR's review…
        </p>
      ) : (
        <>
          <CountsRow review={data} />

          <JourneysSection journeys={journeys} selectedId={journey?.id} onSelect={selectJourney} />

          {journey && (
            <div className="grid min-h-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <ReviewLanes stops={stops} selectedRef={selectedStop?.ref} onSelect={setStopRef} />
              {selectedStop ? (
                <ReviewCodePanel
                  key={selectedStop.ref}
                  stop={selectedStop}
                  node={nodeByRef.get(selectedStop.ref)}
                  journeyId={journey.id}
                  journeyNameById={journeyNameById}
                  repoPath={repoPath(selectedStop.repo)}
                  snapshot={getSnapshot()}
                />
              ) : (
                <aside aria-label="Code panel" className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-0">
                  <p className="text-[13px] text-muted-foreground">Pick a stop to see its code.</p>
                </aside>
              )}
            </div>
          )}

          <FilesSection files={data.files} />
        </>
      )}
    </section>
  );
}

const CELLS: Array<{ key: "files" | "functions" | "journeys" | "tables" | "queues"; caption: string }> = [
  { key: "files", caption: "files changed" },
  { key: "functions", caption: "functions" },
  { key: "journeys", caption: "journeys" },
  { key: "tables", caption: "tables" },
  { key: "queues", caption: "queues" },
];

function CountsRow({ review }: { review: Review }) {
  const counts = {
    files: review.files.length,
    functions: review.nodes.length,
    journeys: review.journeys.length,
    tables: review.tables.length,
    queues: review.queues.length,
  };
  return (
    <ul aria-label="PR totals" className="flex flex-wrap gap-2">
      {CELLS.map(({ key, caption }) => (
        <li key={key} className="flex min-w-[84px] flex-col gap-0.5 rounded-[10px] border border-border bg-card px-3 py-2">
          <span data-slot="count-value" className="text-xl leading-tight font-bold tracking-[-0.02em] tabular-nums">
            {fmt.format(counts[key])}
          </span>
          <span data-slot="count-caption">{` ${caption}`}</span>
        </li>
      ))}
    </ul>
  );
}

function JourneysSection({
  journeys,
  selectedId,
  onSelect,
}: {
  journeys: ReviewJourney[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <section aria-labelledby="review-journeys-title" className="flex flex-col gap-2">
      <h2 id="review-journeys-title" className="text-xl font-bold tracking-[-0.02em]">
        Journeys affected
      </h2>
      {journeys.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No journeys touched by this PR.</p>
      ) : (
        <ul aria-label="Journeys affected" className="flex flex-col gap-1.5">
          {journeys.map((j) => {
            const selected = j.id === selectedId;
            const badge = specBadgeProps(j.spec);
            return (
              <li key={j.id}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(j.id)}
                  className={cn(
                    "flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border bg-card px-3.5 py-2.5 text-left text-[13.5px] transition-colors outline-offset-2 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                    // the same selection halo as LaneColumn's selected stop card (Elevation's Selection halo)
                    selected ? "border-accent-foreground shadow-[0_0_0_3px_rgb(227_167_47_/_0.4)]" : "border-border",
                  )}
                >
                  <b className="font-bold">{j.name}</b>
                  <span className="flex items-center gap-2">
                    <span className="inline-flex w-fit items-center rounded-[4px] bg-accent-soft px-1.75 py-px text-[11.5px] font-semibold whitespace-nowrap text-accent-foreground">
                      {plural(j.changedStops.length, "stop")} changed
                    </span>
                    <SpecBadge state={badge.state} checked={badge.checked} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ReviewLanes({
  stops,
  selectedRef,
  onSelect,
}: {
  stops: ReviewLaneStop[];
  selectedRef: string | undefined;
  onSelect: (ref: string) => void;
}) {
  const lanes = LANE_ORDER.map((lane) => ({ lane, items: stops.filter((s) => s.lane === lane) })).filter((g) => g.items.length > 0);
  if (lanes.length === 0) return null;
  return (
    // the approved mockup's plain white board: lanes as rows on dashed hairlines, not the Journey screen's
    // coloured per-lane washes — here ochre is reserved for "changed" alone (review-maps-constraints.md)
    <div className="min-w-0 overflow-x-auto rounded-xl border border-border bg-card p-3">
      <div className="flex flex-col">
        {lanes.map(({ lane, items }, li) => (
          <div
            key={lane}
            role="region"
            aria-label={LANE_NAME[lane]}
            data-lane={lane}
            className={cn("flex flex-wrap items-center gap-2.5 py-2.5", li > 0 && "border-t border-dashed border-border")}
          >
            <h3 className="w-12 flex-none text-[12.5px] font-bold text-muted-foreground uppercase">{LANE_NAME[lane]}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {items.map((s, i) => (
                <div key={s.ref} className="flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden className="text-muted-foreground">
                      →
                    </span>
                  )}
                  <button
                    type="button"
                    data-changed={s.changed ? "true" : "false"}
                    aria-label={stopLabel(s.n, s.label)}
                    aria-pressed={s.ref === selectedRef}
                    onClick={() => onSelect(s.ref)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] transition-colors outline-offset-2 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                      s.changed ? "border-2 border-accent bg-accent-soft font-semibold" : "border-border",
                      s.ref === selectedRef && "shadow-[0_0_0_3px_rgb(227_167_47_/_0.4)]",
                    )}
                  >
                    <StopNum n={s.n} changed={s.changed} size="sm" />
                    {s.label}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesSection({ files }: { files: Review["files"] }) {
  return (
    <section aria-labelledby="review-files-title" className="flex flex-col gap-2">
      <h2 id="review-files-title" className="text-xl font-bold tracking-[-0.02em]">
        Files changed
      </h2>
      {files.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No files changed.</p>
      ) : (
        <ul aria-label="Files changed" className="flex flex-wrap gap-2 font-mono text-xs">
          {files.map((f) => (
            <li key={`${f.repo}:${f.file}`} className="rounded-[7px] border border-border bg-card px-2 py-1">
              {f.file}
              {f.added > 0 && <span className="text-success"> +{f.added}</span>}
              {f.removed > 0 && <span className="text-destructive"> −{f.removed}</span>}
              {!f.onJourney && <span className="text-muted-foreground"> · not on a journey</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
