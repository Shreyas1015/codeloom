import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { useJourney, useMarkSeen, useMarkToured, useOverview, useProgress, useTour } from "@/api/queries";
import type { Lane, TourFile, TourPhase } from "@/api/types";
import { Command } from "@/components/gallery/CopyCommand";
import { stopLabel, StopRoundel } from "@/components/gallery/StopRoundel";
import { ScreenError } from "@/components/shell/StateBanner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LANE_RING } from "@/screens/home/parts";
import { buildJourneyModel } from "@/screens/journey/model";
import { buildTourModel, nextPlace, PHASE_IDS, phaseName, phaseViewed, placeOf, prevPlace, type TourModel, type TourPlace, type TourStopItem, TOUR_PHASES } from "./model";
import { CheckPhase, DataJourneyPhase, FileNotesPhase, FlowPhase, RemovedRoundel } from "./phases";
import { readTourPlace, rememberTourPlace } from "./position";

export const writeTourCommand = (id: string) => `/mcp__codeloom__write-tour ${id}`;
export const checkMeCommand = (id: string) => `/mcp__codeloom__check-me ${id}`;

const focusRing = "outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring";
const quiet = "text-[13px] text-muted-foreground";

/** Keys that belong to whatever has focus: typing, tabs, scrolling code, a disclosure. */
function ownsArrows(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || !!t.closest("input, textarea, select, pre, summary, [role='tablist'], [role='slider']");
}

/** How a place is named on a button and to a screen reader: "Stop 4" or "Removed stop" in Flow, else the phase. */
function placeName(place: TourPlace, model: TourModel): string {
  if (place.phase !== "flow") return phaseName(place.phase);
  const s = model.stops[place.stop - 1];
  return s?.n !== undefined ? `Stop ${s.n}` : "Removed stop";
}

export function TourScreen({ id, phase, stop }: { id: string; phase?: TourPhase; stop?: number }) {
  const tourQ = useTour(id);
  const journeyQ = useJourney(id);
  const overview = useOverview();
  const progress = useProgress();
  const markSeen = useMarkSeen();
  const markToured = useMarkToured();
  const navigate = useNavigate();

  const tour = tourQ.data;
  const exists = tour?.journeyExists === true;
  const journeyModel = useMemo(() => (journeyQ.data ? buildJourneyModel(journeyQ.data) : undefined), [journeyQ.data]);
  const model = useMemo(() => (tour ? buildTourModel(tour, exists ? journeyModel : undefined) : undefined), [tour, exists, journeyModel]);
  const count = model?.stops.length ?? 0;
  const place = placeOf(phase, stop, count);
  const hasTour = !!tour?.tour;
  const workspace = overview.data?.name;

  // opening a journey (here or on the Journey screen) marks it seen; an older journey's tour cannot be
  const seenFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!exists || seenFor.current === id) return;
    seenFor.current = id;
    markSeen.mutate(id);
  }, [exists, id, markSeen]);

  const go = useCallback(
    (p: TourPlace) => void navigate({ to: "/journeys/$id/tour", params: { id }, search: { phase: p.phase, stop: p.stop }, replace: true }),
    [navigate, id],
  );

  // a ?stop= outside the tour is put right in the URL once the tour is known
  useEffect(() => {
    if (!model || !hasTour || stop === undefined || place.phase !== "flow" || stop === place.stop) return;
    go(place);
  }, [model, hasTour, stop, place, go]);

  // phases viewed: read once from this browser, then grow as the walk goes on; the place is remembered for Resume
  const [viewed, setViewed] = useState<TourPhase[] | null>(null);
  useEffect(() => {
    if (workspace && hasTour && viewed === null) setViewed(readTourPlace(workspace, id)?.viewed ?? []);
  }, [workspace, hasTour, viewed, id]);
  useEffect(() => {
    if (!workspace || !hasTour || viewed === null || count === 0) return;
    const v = phaseViewed(place, count);
    const next = v && !viewed.includes(v) ? PHASE_IDS.filter((p) => p === v || viewed.includes(p)) : viewed;
    if (next !== viewed) setViewed(next);
    rememberTourPlace(workspace, id, { phase: place.phase, stop: place.stop, viewed: next });
  }, [workspace, hasTour, viewed, count, place.phase, place.stop, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // all four phases viewed: toured, once (not again for a journey already toured or understood)
  const allViewed = viewed !== null && PHASE_IDS.every((p) => viewed.includes(p));
  const level = progress.data?.journeys.find((j) => j.journeyId === id)?.level;
  const touredSent = useRef(false);
  useEffect(() => {
    if (!allViewed || !exists || !hasTour || touredSent.current || progress.isPending) return;
    touredSent.current = true;
    if (level === "toured" || level === "understood") return;
    markToured.mutate({ journey: id, phases: [...PHASE_IDS] });
  }, [allViewed, exists, hasTour, progress.isPending, level, id, markToured]);

  // ←/→ walk the one sequence; held keys step from the last place asked for
  const at = useRef(place);
  at.current = place;
  useEffect(() => {
    if (!hasTour || count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || ownsArrows(e.target)) return;
      const to = e.key === "ArrowRight" ? nextPlace(at.current, count) : e.key === "ArrowLeft" ? prevPlace(at.current, count) : null;
      if (to === null) return;
      e.preventDefault();
      if (!to) return;
      at.current = to;
      go(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasTour, count, go]);

  if (tourQ.isPending || (tour?.journeyExists && journeyQ.isPending)) return <p className={quiet}>Loading tour…</p>;

  if (tourQ.error) {
    if (tourQ.error instanceof ApiError && (tourQ.error.status === 404 || tourQ.error.status === 400)) return <NotFound id={id} />;
    return <ScreenError error={tourQ.error} fallback="Something went wrong loading this tour." />;
  }
  if (exists && journeyQ.error) return <ScreenError error={journeyQ.error} fallback="Something went wrong loading this journey." />;

  const name = journeyQ.data?.journey?.name ?? id;
  const t = tour!;
  const m = model!;

  if (!t.tour) return <NoTour id={id} name={name} />;

  const prev = prevPlace(place, count);
  const next = nextPlace(place, count);
  const current = place.phase === "flow" ? m.stops[place.stop - 1] : undefined;

  return (
    <div className="flex min-h-full flex-1 flex-col gap-5">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border pb-4">
        <h1 className="text-[20px] leading-tight font-bold tracking-[-0.02em] text-balance">{name}</h1>
        <PhaseNav id={id} current={place.phase} viewed={viewed ?? []} />
        <Link to="/journeys/$id" params={{ id }} className={cn("ml-auto rounded-sm text-[13px] font-semibold text-muted-foreground underline-offset-3 hover:text-foreground hover:underline", focusRing)}>
          Exit tour
        </Link>
      </header>

      {!t.journeyExists ? (
        <p role="status" className="max-w-[78ch] rounded-lg border border-dashed border-muted-foreground bg-card px-4 py-3 text-[13.5px]">
          This tour is for an older journey: it was renamed, merged or split, so every stop is shown as removed. Open the journey it became and ask
          Claude for a new tour: <span className="font-mono text-[12.5px]">{writeTourCommand("<journey id>")}</span>
        </p>
      ) : null}

      <div className="min-w-0 flex-1">
        {place.phase === "flow" && current ? (
          <FlowPhase stop={current} index={place.stop} count={count} steps={m.steps} traps={trapsFor(t.tour.fileNotes, current)} />
        ) : place.phase === "data-journey" ? (
          <DataJourneyPhase input={t.tour.dataJourney.input} output={t.tour.dataJourney.output} steps={m.steps} />
        ) : place.phase === "file-notes" ? (
          <FileNotesPhase notes={t.tour.fileNotes} />
        ) : place.phase === "check" ? (
          <CheckPhase
            id={id}
            check={t.tour.check}
            progress={progress.data?.journeys.find((j) => j.journeyId === id)}
            progressError={progress.error}
            walked={allViewed}
            canCheck={t.journeyExists}
          />
        ) : null}
      </div>

      <footer className="sticky -bottom-7 -mx-9 -mb-7 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border bg-card px-9 py-3">
        <Button type="button" variant="outline" disabled={!prev} onClick={() => prev && go(prev)} aria-label={prev ? `Previous: ${placeName(prev, m)}` : "Previous"}>
          <ArrowLeft aria-hidden />
          {prev ? placeName(prev, m) : "Previous"}
        </Button>
        <StopStrip
          stops={m.stops}
          current={place.phase === "flow" ? place.stop : undefined}
          flowViewed={(viewed ?? []).includes("flow")}
          onPick={(n) => go({ phase: "flow", stop: n })}
        />
        {next ? (
          <Button
            type="button"
            className="ml-auto"
            onClick={() => go(next)}
            aria-label={`Next: ${placeName(next, m)}${next.phase === "flow" ? ` · ${m.stops[next.stop - 1]!.title}` : ""}`}
          >
            {placeName(next, m)}
            {next.phase === "flow" ? <span className="max-w-[28ch] truncate font-normal opacity-90">· {m.stops[next.stop - 1]!.title}</span> : null}
            <ArrowRight aria-hidden />
          </Button>
        ) : (
          <Link
            to="/journeys/$id"
            params={{ id }}
            className={cn("ml-auto inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 motion-reduce:transition-none", focusRing)}
          >
            Back to the journey
          </Link>
        )}
      </footer>

      <p role="status" aria-live="polite" className="sr-only">
        {current ? (current.n !== undefined ? stopLabel(current.n, current.title) : `Removed stop: ${current.title}`) : phaseName(place.phase)}
      </p>
    </div>
  );
}

/** The four phases as links; the current one is marked, viewed ones carry a check. */
function PhaseNav({ id, current, viewed }: { id: string; current: TourPhase; viewed: TourPhase[] }) {
  return (
    <nav aria-label="Tour phases">
      <ol className="flex flex-wrap">
        {TOUR_PHASES.map((p, i) => {
          const on = p.id === current;
          const done = viewed.includes(p.id);
          return (
            <li key={p.id} className={cn(i > 0 && "-ml-px")}>
              <Link
                to="/journeys/$id/tour"
                params={{ id }}
                search={{ phase: p.id, stop: 1 }}
                replace
                aria-current={on ? "step" : undefined}
                aria-label={done ? `${p.name} (viewed)` : undefined}
                className={cn(
                  "relative flex items-center gap-1.5 border border-border px-3.5 py-1.75 text-[13px] font-semibold transition-colors motion-reduce:transition-none",
                  i === 0 && "rounded-l-lg",
                  i === TOUR_PHASES.length - 1 && "rounded-r-lg",
                  on ? "z-10 border-foreground bg-foreground text-card" : done ? "bg-success-soft text-foreground hover:bg-success-soft/70" : "bg-card text-muted-foreground hover:text-foreground",
                  "focus-visible:z-20",
                  focusRing,
                )}
              >
                {done && !on ? <Check aria-hidden className="size-3.5" /> : null}
                {p.name}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The traps the tour's file notes give for this stop's file: shown beside its code as "Remember this". */
function trapsFor(notes: TourFile["fileNotes"], stop: TourStopItem) {
  const repo = stop.view?.repo ?? stop.fields?.repo;
  const file = stop.view?.file ?? stop.fields?.file;
  return notes.find((f) => f.repo === repo && f.file === file)?.notes.filter((n) => n.kind === "trap") ?? [];
}

type Walk = "walked" | "here" | "ahead";
const WALK_WORD: Record<Walk, string | undefined> = { walked: "Walked", here: undefined, ahead: "Not walked yet" };

/** Every Flow stop as a roundel (the Honest Roundel Rule): stops you walked are filled ochre, the current one
 * is haloed, the rest are hollow and ringed in their lane's hue. Removed ones are hollow and dashed. Once Flow
 * has been viewed to its end, every stop counts as walked. */
function StopStrip({ stops, current, flowViewed, onPick }: { stops: TourStopItem[]; current?: number; flowViewed: boolean; onPick: (n: number) => void }) {
  const descId = useId();
  return (
    <>
    <ol aria-label="Tour stops" className="flex min-w-0 items-center overflow-x-auto py-1.5">
      {stops.map((s, i) => {
        const walk: Walk = current === i + 1 ? "here" : flowViewed || (current !== undefined && i + 1 < current) ? "walked" : "ahead";
        const lane = s.view?.lane ?? (s.fields?.lane as Lane | undefined);
        const word = WALK_WORD[walk];
        return (
          <li key={s.key} className="flex flex-none items-center">
            {i > 0 ? <span aria-hidden className="h-0.5 w-3.5 bg-connector" /> : null}
            <button
              type="button"
              onClick={() => onPick(i + 1)}
              aria-current={walk === "here" ? "step" : undefined}
              aria-label={s.n !== undefined ? stopLabel(s.n, s.title) : `Removed stop: ${s.title}`}
              aria-describedby={word ? `${descId}-${walk}` : undefined}
              className={cn("rounded-full", focusRing)}
            >
              <span data-slot="tour-stop" data-walk={walk} className="flex">
                {s.n === undefined ? (
                  <RemovedRoundel on={walk === "here"} />
                ) : walk === "ahead" ? (
                  <span aria-hidden className={cn(AHEAD, LANE_RING[lane ?? "code"] ?? LANE_RING.code)}>
                    {s.n}
                  </span>
                ) : (
                  <StopRoundel n={s.n} label={s.title} state={walk === "here" ? "selected" : "default"} decorative />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
    <span hidden>
      <span id={`${descId}-walked`}>{WALK_WORD.walked}</span>
      <span id={`${descId}-ahead`}>{WALK_WORD.ahead}</span>
    </span>
    </>
  );
}

const AHEAD =
  "inline-grid size-6 flex-none place-items-center rounded-full border-[1.5px] bg-card font-mono text-[11px] leading-none font-semibold tabular-nums select-none";

function NoTour({ id, name }: { id: string; name: string }) {
  return (
    <section aria-labelledby="no-tour" className="flex max-w-[64ch] flex-col gap-3">
      <p className="text-[13px] text-muted-foreground">{name}</p>
      <h1 id="no-tour" className="text-[24px] font-bold tracking-[-0.02em]">
        No tour for this journey yet
      </h1>
      <p className="text-[14px]">
        A tour walks the journey stop by stop: what each step does, the data as it moves, the traps in each file, and three questions to check
        yourself. Claude writes it from the code. Paste this in Claude Code:
      </p>
      <Command text={writeTourCommand(id)} />
      <Link to="/journeys/$id" params={{ id }} className={cn("w-fit rounded-sm text-[14px] font-semibold text-primary underline-offset-3 hover:underline", focusRing)}>
        Back to the journey
      </Link>
    </section>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <section aria-labelledby="tour-missing" className="flex max-w-[60ch] flex-col gap-2">
      <h1 id="tour-missing" className="text-[24px] font-bold tracking-[-0.02em]">
        Journey not found
      </h1>
      <p className="text-[14px] text-muted-foreground">
        Nothing in this map is called <span className="font-mono text-foreground">{id}</span>, and it has no tour. It may have been renamed or deleted.
      </p>
      <Link to="/" className={cn("w-fit rounded-sm text-[14px] font-semibold text-primary underline-offset-3 hover:underline", focusRing)}>
        Back to all journeys
      </Link>
    </section>
  );
}
