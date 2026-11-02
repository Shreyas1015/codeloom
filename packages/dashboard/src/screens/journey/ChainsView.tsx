import { useId } from "react";
import type { ChainView } from "@/api/types";
import { ConfidenceLine } from "@/components/gallery/ConfidenceLine";
import { StopRoundel, stopLabel } from "@/components/gallery/StopRoundel";
import { cn } from "@/lib/utils";
import { UnresolvedList } from "./LanesView";
import { stopFrom } from "@/lib/journey-stops";
import { type JourneyModel, stopTitle } from "./model";
import { CONFIDENCE_WORD, fileLine, HOP_WORD } from "./words";

export interface ChainsViewProps {
  chains: ChainView[];
  model: JourneyModel;
  selected?: number;
  onSelect: (n: number) => void;
}

/** Each chain as a numbered list of its stops, with the hop the linker recorded into each stop. */
export function ChainsView({ chains, model, selected, onSelect }: ChainsViewProps) {
  return (
    <div className="flex flex-col gap-4">
      {chains.map((c) => (
        <ChainCard key={c.id} chain={c} nums={model.chainStops.get(c.id) ?? []} selected={selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function ChainCard({ chain, nums, selected, onSelect }: { chain: ChainView; nums: number[] } & Omit<ChainsViewProps, "chains" | "model">) {
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
          const on = n === selected;
          const title = stopTitle(s);
          const from = stopFrom(s);
          // a line only for a hop recorded from the stop right above; a hop from further up is said in words;
          // a stop with no recorded hop gets neither
          const fromAbove = i > 0 && from === i - 1;
          const fromStop = from !== undefined && from !== i && !fromAbove ? nums[from] : undefined;
          return (
            <li key={`${i}-${n}`} className="flex flex-col">
              {i === 0 ? null : fromAbove ? (
                <ConfidenceLine confidence={s.confidence} reason={s.reason} className="ml-[13px]" />
              ) : (
                <span aria-hidden="true" data-slot="lane-gap" className="block h-3" />
              )}
              <button
                type="button"
                aria-label={stopLabel(n, title)}
                aria-current={on ? "step" : undefined}
                onClick={() => onSelect(n)}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors outline-offset-2 hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none",
                  on && "bg-accent-soft",
                )}
              >
                <StopRoundel n={n} label={title} size="sm" state={on ? "selected" : "default"} decorative />
                <span className="min-w-0 truncate text-[13.5px] font-semibold">{title}</span>
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{fileLine(s.file, s.line)}</span>
              </button>
              {fromStop !== undefined ? (
                <p className={cn("pl-9 text-xs", s.confidence === "guess" ? "text-foreground" : "text-muted-foreground")}>
                  {`From stop ${fromStop} · ${HOP_WORD[s.confidence]}${s.reason ? `. ${s.reason}` : ""}`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
      <UnresolvedList items={chain.unresolved} />
    </section>
  );
}
