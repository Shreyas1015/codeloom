import { useState } from "react";
import type { Confidence, JourneyRow, Lane } from "@/api/types";
import { CopyButton } from "@/components/gallery/CopyCommand";
import { LANE_NAME } from "@/components/gallery/LaneColumn";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LANES } from "./filter";

/** Lists render this many rows, then "Show more" adds the next batch. */
export const PAGE = 200;

export const NAME_JOURNEYS = "/codeloom:name-journeys";

const LANE_CHIP: Record<Lane, string> = {
  ui: "bg-lane-ui-soft text-lane-ui",
  api: "bg-lane-api-soft text-lane-api",
  code: "bg-lane-code-soft text-lane-code",
  db: "bg-lane-db-soft text-lane-db",
  queue: "bg-lane-queue-soft text-lane-db",
};

/** Stops per lane, in lane order (UI → API → Code → DB → Queue); empty lanes are left out. */
export function LaneCounts({ stops, className }: { stops: JourneyRow["stops"]; className?: string }) {
  const lanes = LANES.filter((l) => (stops[l] ?? 0) > 0);
  if (lanes.length === 0) return <span className="text-[12.5px] text-muted-foreground">No stops</span>;
  return (
    <span className={cn("flex flex-wrap items-center gap-y-1", className)}>
      {lanes.map((l, i) => {
        const n = stops[l];
        return (
          <span key={l} className="flex items-center">
            {i > 0 && <i aria-hidden className="h-px w-2 bg-connector" />}
            <span
              role="img"
              aria-label={`${n} ${LANE_NAME[l]} stop${n === 1 ? "" : "s"}`}
              data-lane={l}
              className={cn("inline-flex items-baseline gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-semibold", LANE_CHIP[l])}
            >
              {LANE_NAME[l]}
              <span className="font-mono tabular">{n}</span>
            </span>
          </span>
        );
      })}
    </span>
  );
}

const CONF_WORD: Record<Confidence, string> = { exact: "Exact", param: "Param", guess: "Guess" };
const CONF_LINE: Record<Confidence, string> = {
  exact: "border-t-2 border-solid border-connector",
  param: "border-t border-solid border-connector",
  guess: "border-t-[1.5px] border-dashed border-muted-foreground",
};
const CONF_TITLE: Record<Confidence, string> = {
  exact: "Every hop is an exact link",
  param: "Some hops matched with a path parameter",
  guess: "Some hops are guesses, not proven",
};

/** The worst confidence over a journey's hops, drawn as the same line the Journey screen uses. */
export function ConfidenceMark({ confidence }: { confidence: Confidence }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px]" title={CONF_TITLE[confidence]} data-confidence={confidence}>
      <i aria-hidden className={cn("w-4", CONF_LINE[confidence])} />
      <span className={confidence === "guess" ? "text-muted-foreground italic" : undefined}>{CONF_WORD[confidence]}</span>
    </span>
  );
}

export function CompleteMark({ complete }: { complete: boolean }) {
  return complete ? (
    <span className="text-[12.5px] text-foreground">Complete</span>
  ) : (
    <span className="text-[12.5px] text-muted-foreground">Incomplete</span>
  );
}

/** "Ask your agent: /codeloom:name-journeys" with a copy button. */
export function AgentHint({ className, tone = "default" }: { className?: string; tone?: "default" | "quiet" }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]", tone === "quiet" && "text-muted-foreground", className)}>
      <span>
        Ask your agent: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px] text-foreground select-all">{NAME_JOURNEYS}</code>
      </span>
      <CopyButton text={NAME_JOURNEYS} />
    </p>
  );
}

/** How many rows of a list to render; grows by PAGE. */
export function useLimit(resetKey: string) {
  const [state, setState] = useState({ key: resetKey, limit: PAGE });
  const limit = state.key === resetKey ? state.limit : PAGE;
  return [limit, () => setState({ key: resetKey, limit: limit + PAGE })] as const;
}

export function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null;
  const next = Math.min(PAGE, total - shown);
  return (
    <div className="flex items-center justify-center gap-3 border-t border-border px-5 py-3 text-[12.5px] text-muted-foreground">
      <span className="tabular">
        Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onMore}>
        Show more ({next.toLocaleString("en-US")})
      </Button>
    </div>
  );
}
