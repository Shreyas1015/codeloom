import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { JourneysResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { totalStops } from "./filter";
import { readLastJourney } from "./lastJourney";

/** The journey this viewer opened last. Hidden when none was opened or it no longer exists. */
export function ContinueBand({ workspace, data }: { workspace: string; data: JourneysResponse }) {
  const id = readLastJourney(workspace);
  if (!id) return null;
  const journey = data.journeys.find((j) => j.id === id);
  const chain = journey ? undefined : data.unnamedChains.find((c) => c.id === id);
  if (!journey && !chain) return null;

  const name = journey?.name ?? chain!.name;
  const n = journey ? totalStops(journey) : undefined;
  const caption = journey
    ? [journey.area, `${n} stop${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ")
    : `Unnamed chain · ${chain!.entry}`;

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
        <Link to="/journeys/$id" params={{ id }}>
          {journey ? "Open journey" : "Open chain"}
          <ArrowRight aria-hidden />
        </Link>
      </Button>
    </section>
  );
}
