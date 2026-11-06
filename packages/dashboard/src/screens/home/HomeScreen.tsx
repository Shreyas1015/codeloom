import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useJourneys, useOverview, useProgress } from "@/api/queries";
import type { JourneysResponse, Overview, ProgressResponse } from "@/api/types";
import { ScreenError } from "@/components/shell/StateBanner";
import { CountStrip, type Counts } from "@/components/gallery/CountStrip";
import { Button } from "@/components/ui/button";
import { stripCounts, understoodPercent } from "@/lib/progress";
import { ContinueBand } from "./ContinueBand";
import { JourneyList } from "./JourneyList";
import { UnnamedChains } from "./UnnamedChains";
import { AgentHint } from "./parts";

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

function counts(o: Overview): Counts {
  const sum = (k: "files" | "pages" | "routes" | "tables" | "queues") => o.repos.reduce((n, r) => n + r[k], 0);
  return { files: sum("files"), pages: sum("pages"), routes: sum("routes"), tables: sum("tables"), queues: sum("queues"), journeys: o.journeys.total };
}

function Skeleton() {
  const bar = "rounded-md bg-muted motion-safe:animate-pulse";
  return (
    <div data-testid="home-loading" aria-busy="true" aria-label="Loading journeys" className="flex flex-col gap-5.5">
      <div className={`${bar} h-16`} />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 border-b border-border px-5 py-3.5 last:border-0">
            <div className="flex w-1/3 flex-col gap-1.5">
              <div className={`${bar} h-3.5 w-3/4`} />
              <div className={`${bar} h-3 w-1/2`} />
            </div>
            <div className={`${bar} h-3 w-24`} />
            <div className={`${bar} h-4 w-48`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty() {
  return (
    <section aria-labelledby="home-empty" className="flex max-w-[70ch] flex-col items-start gap-3 rounded-xl border border-border bg-card px-6 py-6">
      <h2 id="home-empty" className="text-xl font-bold tracking-[-0.02em]">
        No journeys found
      </h2>
      <p className="text-[13.5px] text-muted-foreground">
        codeloom traced no flows from a page or route to the database in this workspace. The code itself is still on the map.
      </p>
      <Button asChild variant="default" size="sm">
        <Link to="/map">
          Open the map
          <ArrowRight aria-hidden />
        </Link>
      </Button>
      <AgentHint tone="quiet" />
    </section>
  );
}

/** Home (`/`): the workspace, its totals, where you left off, and every user journey. */
export function HomeScreen() {
  const overview = useOverview();
  const journeys = useJourneys();
  // Progress is personal and optional here: when it cannot load, Home shows the map without it.
  const progress = useProgress().data;
  const o = overview.data;
  const error = overview.error ?? journeys.error;

  return (
    <section data-testid="screen-home" aria-labelledby="home-title" className="flex flex-col gap-5.5">
      <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 id="home-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
            {o?.name ?? "Home"}
          </h1>
          {o && (
            <p className="text-[13.5px] text-muted-foreground">
              {plural(o.journeys.total, "journey")} · {plural(o.chains.total, "chain")}, {fmt(o.chains.complete)} complete
            </p>
          )}
        </div>
        {progress && <Understood progress={progress} />}
      </header>

      {error ? (
        <ScreenError error={error} fallback="Something went wrong loading the journeys." />
      ) : !o || !journeys.data ? (
        <Skeleton />
      ) : (
        <HomeBody overview={o} data={journeys.data} progress={progress} />
      )}
    </section>
  );
}

/** The understood share: big tabular percent, the count beside it, linked to Progress. */
function Understood({ progress }: { progress: ProgressResponse }) {
  const pct = understoodPercent(progress.totals.all);
  if (pct === undefined) return null;
  const n = stripCounts(progress.totals.all).understood;
  return (
    <Link
      to="/progress"
      data-testid="home-understood"
      className="flex items-center gap-3.5 rounded-lg outline-offset-4 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
    >
      <b className="text-[44px] leading-none font-bold tracking-[-0.03em] tabular-nums">{pct}%</b>
      <small className="max-w-40 text-[12.5px] leading-snug text-muted-foreground">
        {fmt(n)} of {plural(progress.totals.all.total, "journey")} understood
      </small>
    </Link>
  );
}

function HomeBody({ overview, data, progress }: { overview: Overview; data: JourneysResponse; progress?: ProgressResponse }) {
  const nothing = data.journeys.length === 0 && data.unnamedChains.length === 0;
  return (
    <>
      <CountStrip counts={counts(overview)} />
      <ContinueBand workspace={overview.name} data={data} progress={progress} />
      {nothing ? (
        <Empty />
      ) : data.journeys.length === 0 ? (
        <section aria-labelledby="home-journeys" className="flex flex-col gap-1">
          <h2 id="home-journeys" className="text-xl font-bold tracking-[-0.02em]">
            User journeys
          </h2>
          <p className="text-[13.5px] text-muted-foreground">No named journeys yet.</p>
        </section>
      ) : (
        <JourneyList rows={data.journeys} progress={progress} />
      )}
      <UnnamedChains chains={data.unnamedChains} />
    </>
  );
}
