import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { SessionError } from "@/api/client";
import { useJourneys, useOverview } from "@/api/queries";
import type { JourneysResponse, Overview } from "@/api/types";
import { CountStrip, type Counts } from "@/components/gallery/CountStrip";
import { Button } from "@/components/ui/button";
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

/** Guards against a response that is not the journeys shape (an older server, a test stub). */
function asJourneys(d: unknown): JourneysResponse {
  const o = (d ?? {}) as Partial<JourneysResponse>;
  return { journeys: Array.isArray(o.journeys) ? o.journeys : [], unnamedChains: Array.isArray(o.unnamedChains) ? o.unnamedChains : [] };
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
  const o = overview.data;
  const error = overview.error ?? journeys.error;

  return (
    <section data-testid="screen-home" aria-labelledby="home-title" className="flex flex-col gap-5.5">
      <header className="flex flex-col gap-1">
        <h1 id="home-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
          {o?.name ?? "Home"}
        </h1>
        {o && (
          <p className="text-[13.5px] text-muted-foreground tabular">
            {plural(o.journeys.total, "journey")} · {plural(o.chains.total, "chain")}, {fmt(o.chains.complete)} complete
          </p>
        )}
      </header>

      {error ? (
        <p role="alert" className="max-w-[70ch] rounded-xl border border-destructive/40 bg-destructive-soft px-5 py-4 text-[13.5px] text-foreground">
          {error instanceof SessionError ? error.message : error.message || "Something went wrong loading the journeys."}
        </p>
      ) : !o || !journeys.data ? (
        <Skeleton />
      ) : (
        <HomeBody overview={o} data={asJourneys(journeys.data)} />
      )}
    </section>
  );
}

function HomeBody({ overview, data }: { overview: Overview; data: JourneysResponse }) {
  const nothing = data.journeys.length === 0 && data.unnamedChains.length === 0;
  return (
    <>
      <CountStrip counts={counts(overview)} />
      <ContinueBand workspace={overview.name} data={data} />
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
        <JourneyList rows={data.journeys} />
      )}
      <UnnamedChains chains={data.unnamedChains} />
    </>
  );
}
