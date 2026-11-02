import { useId } from "react";
import type { ChainView } from "@/api/types";
import { ConfidenceLine } from "@/components/gallery/ConfidenceLine";
import { StopRoundel, stopLabel } from "@/components/gallery/StopRoundel";
import { cn } from "@/lib/utils";
import { UnresolvedList } from "./LanesView";
import { type JourneyModel, stopTitle } from "./model";
import { CONFIDENCE_WORD, fileLine } from "./words";

export interface ChainsViewProps {
  chains: ChainView[];
  model: JourneyModel;
  selected?: number;
  onSelect: (n: number) => void;
}

/** Each chain as a numbered list of its stops, the hop into each stop drawn by its confidence. */
export function ChainsView({ chains, model, selected, onSelect }: ChainsViewProps) {
  return (
    <div className="flex flex-col gap-4">
      {chains.map((c) => (
        <ChainCard key={c.id} chain={c} nums={model.chainStops.get(c.id) ?? []} model={model} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function ChainCard({ chain, nums, model, selected, onSelect }: { chain: ChainView; nums: number[]; model: JourneyModel } & Omit<ChainsViewProps, "chains" | "model">) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={`${id}-h`} className="font-mono text-[13.5px] font-semibold">
          {chain.name}
        </h3>
        <p className="flex flex-wrap gap-x-3.5 text-xs text-muted-foreground">
          <span className="font-mono">{chain.entry}</span>
          <span>{CONFIDENCE_WORD[chain.confidence]}</span>
          <span>{chain.complete ? "Complete" : "Incomplete"}</span>
        </p>
      </header>
      <ol aria-label="Stops" className="flex flex-col">
        {chain.stops.map((s, i) => {
          const n = nums[i]!;
          const stop = model.stops[n - 1]!;
          const on = n === selected;
          const title = stopTitle(s);
          return (
            <li key={`${i}-${n}`} className="flex flex-col">
              {i > 0 ? <ConfidenceLine confidence={s.confidence} reason={s.reason} className="ml-[13px]" /> : null}
              <button
                type="button"
                aria-label={stopLabel(n, title, stop.unresolved)}
                aria-current={on ? "step" : undefined}
                onClick={() => onSelect(n)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors outline-offset-2 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none",
                  on && "bg-accent-soft",
                )}
              >
                <StopRoundel n={n} label={title} size="sm" state={stop.unresolved ? "unresolved" : on ? "selected" : "default"} decorative />
                <span className="min-w-0 truncate text-[13.5px] font-semibold">{title}</span>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{fileLine(s.file, s.line)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <UnresolvedList items={chain.unresolved} />
    </section>
  );
}
