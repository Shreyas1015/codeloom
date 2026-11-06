import { Link } from "@tanstack/react-router";
import { useProgress } from "@/api/queries";
import type { JourneyResult } from "@/api/types";
import { LevelBadge } from "@/components/gallery/ProgressStrip";
import { displayLevel } from "@/lib/progress";
import { API_ONLY_TITLE } from "@/lib/completeness";
import { cn } from "@/lib/utils";
import type { JourneyModel } from "./model";
import { CONFIDENCE_WORD, plural } from "./words";

const pill = "inline-flex items-center rounded-[4px] px-1.75 py-px text-[11.5px] font-semibold";

/** One "calls <name>" note per other service the journey's pages call (already sorted by name); the
 * title lists each call and where it is made. */
function externalNotes(result: JourneyResult): Array<{ name: string; title: string }> {
  const byName = new Map<string, string[]>();
  for (const e of result.external ?? []) {
    byName.set(e.name, [...(byName.get(e.name) ?? []), `${e.method} ${e.path} (${e.repo}/${e.file}:${e.line})`]);
  }
  return [...byName].map(([name, lines]) => ({ name, title: lines.join("\n") }));
}

/** The fixed wall label of one journey (or one chain not yet in a journey). */
export function Nameplate({ result, model }: { result: JourneyResult; model: JourneyModel }) {
  const j = result.journey;
  const chain = j ? undefined : result.chains[0];
  const name = j?.name ?? chain?.name ?? "Chain";
  // Your level on this journey (chains have none); absent until progress loads, or when it cannot.
  const { data: progress } = useProgress();
  const mine = j ? progress?.journeys.find((v) => v.journeyId === j.id) : undefined;
  const facts = [
    plural(model.stops.length, "stop"),
    plural(model.repos.length, "repo"),
    plural(result.tables.length, "table"),
    ...(result.queues.length ? [plural(result.queues.length, "queue")] : []),
  ].join(" · ");

  return (
    <header className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">{name}</h1>
        {j?.note ? <p className="mt-1.5 max-w-[68ch] text-[14px] text-muted-foreground">{j.note}</p> : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4.5 gap-y-1.5 text-[13px] text-muted-foreground">
          {j ? (
            <>
              {j.area ? (
                <span>
                  Area <b className="font-semibold text-foreground">{j.area}</b>
                </span>
              ) : null}
              <span>{plural(result.chains.length + result.missingChainIds.length, "chain")}</span>
            </>
          ) : (
            <>
              <span className={cn(pill, "bg-accent-soft text-accent-foreground")}>Not in a journey yet</span>
              {chain ? <span className="font-mono text-xs">{chain.entry}</span> : null}
            </>
          )}
          <span>{facts}</span>
          {externalNotes(result).map((e) => (
            <span key={e.name} title={e.title}>
              calls {e.name}
            </span>
          ))}
          {model.confidence ? (
            <span
              data-confidence={model.confidence}
              className={cn(pill, model.confidence === "guess" ? "border border-dashed border-muted-foreground text-foreground" : "bg-secondary text-foreground")}
            >
              {CONFIDENCE_WORD[model.confidence]}
            </span>
          ) : null}
          <span
            className={cn(pill, model.complete ? "bg-success-soft text-foreground" : "bg-secondary text-foreground")}
            title={!model.complete && model.apiOnly ? API_ONLY_TITLE : undefined}
          >
            {model.complete ? "Complete" : model.apiOnly ? "API → DB" : "Incomplete"}
          </span>
          {mine ? <LevelBadge level={displayLevel(mine)} changed={mine.needsReWalk.length} /> : null}
          {j?.status === "orphaned" ? <span className={cn(pill, "bg-destructive-soft text-destructive")}>Orphaned</span> : null}
        </div>
      </div>
      {j && model.stops.length > 0 ? (
        <Link
          to="/map"
          search={{ overlay: `journey:${j.id}` }}
          className="inline-flex flex-none items-center rounded-lg border border-border bg-card px-3.5 py-2 text-[13px] font-semibold text-foreground transition-colors outline-offset-2 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          Show on map
        </Link>
      ) : null}
    </header>
  );
}
