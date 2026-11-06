import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { useTour } from "@/api/queries";
import type { JourneyProgressView, JourneysResponse, ProgressResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { displayLevel, nextTourStop, pickContinue } from "@/lib/progress";
import { parseKey, phaseName } from "@/screens/tour/model";
import { readTourPlace } from "@/screens/tour/position";
import { totalStops } from "./filter";
import { readLastJourney } from "./lastJourney";

const stops = (n: number) => `${n} stop${n === 1 ? "" : "s"}`;

function Band({ name, caption, children }: { name: string; caption: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby="home-continue"
      className="flex flex-wrap items-center gap-x-4.5 gap-y-3 rounded-xl bg-primary px-4.5 py-3.5 text-primary-foreground"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id="home-continue" className="text-[15px] font-bold">
          Continue: {name}
        </h2>
        <p className="truncate text-[13px] text-rail-foreground">{caption}</p>
      </div>
      <Button asChild variant="accent" className="ml-auto focus-visible:ring-rail-ring">
        {children}
      </Button>
    </section>
  );
}

/** Where you left off. With progress: the next unfinished tour stop of the journey you are walking (the
 * last opened one while unfinished, else the one touched last), or its first changed stop when it needs a
 * re-walk. Without progress, or with nothing in progress: the journey or chain this viewer opened last.
 * Hidden when there is neither. */
export function ContinueBand({ workspace, data, progress }: { workspace: string; data: JourneysResponse; progress?: ProgressResponse }) {
  const lastId = readLastJourney(workspace);
  const pick = progress ? pickContinue(progress.journeys, lastId) : undefined;
  const view = pick ? progress!.journeys.find((v) => v.journeyId === pick) : undefined;
  if (view && data.journeys.some((j) => j.id === view.journeyId)) return <TourBand workspace={workspace} data={data} view={view} />;

  const id = lastId;
  if (!id) return null;
  const journey = data.journeys.find((j) => j.id === id);
  const chain = journey ? undefined : data.unnamedChains.find((c) => c.id === id);
  if (!journey && !chain) return null;

  const name = journey?.name ?? chain!.name;
  const n = journey ? totalStops(journey) : undefined;
  const caption = journey ? [journey.area, stops(n!)].filter(Boolean).join(" · ") : `Unnamed chain · ${chain!.entry}`;
  return (
    <Band name={name} caption={caption}>
      <Link to="/journeys/$id" params={{ id }}>
        {journey ? "Open journey" : "Open chain"}
        <ArrowRight aria-hidden />
      </Link>
    </Band>
  );
}

function TourBand({ workspace, data, view }: { workspace: string; data: JourneysResponse; view: JourneyProgressView }) {
  const journey = data.journeys.find((j) => j.id === view.journeyId)!;
  const { data: t } = useTour(view.journeyId);
  const tour = t?.tour;
  const next = nextTourStop(tour, view, readTourPlace(workspace, view.journeyId));

  if (!tour || !next) {
    const caption = [journey.area, stops(totalStops(journey)), ...(t && !tour ? ["No tour yet"] : [])].filter(Boolean).join(" · ");
    return (
      <Band name={view.name} caption={caption}>
        <Link to="/journeys/$id" params={{ id: view.journeyId }}>
          Open journey
          <ArrowRight aria-hidden />
        </Link>
      </Band>
    );
  }

  const rewalk = displayLevel(view) === "re-walk";
  const at = next.phase === "flow" ? parseKey(tour.stops[next.stop - 1]!.key) : null;
  const caption = rewalk
    ? [`${stops(view.needsReWalk.length)} changed`, at?.symbol].filter(Boolean).join(" · ")
    : next.phase === "flow"
      ? [`Stop ${next.stop} of ${tour.stops.length}`, at?.symbol].filter(Boolean).join(" · ")
      : phaseName(next.phase);
  return (
    <Band name={view.name} caption={caption}>
      <Link
        to="/journeys/$id/tour"
        params={{ id: view.journeyId }}
        search={{ phase: next.phase, stop: next.stop, ...(next.stopId ? { stopId: next.stopId } : {}) }}
      >
        {rewalk ? "Re-walk" : next.resumed ? "Resume tour" : "Start tour"}
        <ArrowRight aria-hidden />
      </Link>
    </Band>
  );
}
