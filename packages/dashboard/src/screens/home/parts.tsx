import { useState } from "react";
import type { Confidence, JourneyRow, Lane } from "@/api/types";
import { CopyButton } from "@/components/gallery/CopyCommand";
import { LANE_NAME } from "@/components/gallery/LaneColumn";
import { Button } from "@/components/ui/button";
import { API_ONLY_TITLE } from "@/lib/completeness";
import { cn } from "@/lib/utils";
import { LANES } from "./filter";

/** Lists render this many rows, then "Show more" adds the next batch. */
export const PAGE = 200;

export const NAME_JOURNEYS = "/mcp__codeloom__name-journeys";

/** A roundel's ring and number in its lane's hue; the queue lane reads in the DB umber family. */
const LANE_RING: Record<Lane, string> = {
  ui: "border-lane-ui text-lane-ui",
  api: "border-lane-api text-lane-api",
  code: "border-lane-code text-lane-code",
  db: "border-lane-db text-lane-db",
  queue: "border-lane-queue text-lane-db",
};

/** At most this many roundels in a row; past it the rest fold into one dashed "+N". */
export const MAX_ROUNDELS = 8;

const ROUNDEL =
  "inline-grid h-[22px] min-w-[22px] flex-none place-items-center rounded-full border-[1.5px] bg-card font-mono text-[10px] leading-none font-semibold tabular-nums";

/** A journey's stops as a row of numbered roundels ringed in their lane's hue, in lane order
 * (UI → API → Code → DB → Queue); empty lanes are left out. Hollow on purpose: on Home a roundel names a stop,
 * it never claims you walked it. Each lane's run carries its count for assistive tech ("2 UI stops"). */
export function LaneCounts({ stops, className }: { stops: JourneyRow["stops"]; className?: string }) {
  const lanes = LANES.filter((l) => (stops[l] ?? 0) > 0);
  if (lanes.length === 0) return <span className="text-[12.5px] text-muted-foreground">No stops</span>;
  const total = lanes.reduce((sum, l) => sum + stops[l], 0);
  const room = total > MAX_ROUNDELS ? MAX_ROUNDELS - 1 : MAX_ROUNDELS;
  const runs = lanes.map((l, i) => {
    const before = lanes.slice(0, i).reduce((sum, p) => sum + stops[p], 0);
    return { lane: l, count: stops[l], first: before + 1, shown: Math.max(0, Math.min(stops[l], room - before)) };
  });
  return (
    <span data-slot="stop-row" title={lanes.map((l) => `${LANE_NAME[l]} ${stops[l]}`).join(" · ")} className={cn("flex flex-wrap items-center gap-y-1", className)}>
      {runs.map(({ lane, count, first, shown }) => (
        <span key={lane} role="img" aria-label={`${count} ${LANE_NAME[lane]} stop${count === 1 ? "" : "s"}`} data-lane={lane} className="flex items-center">
          {Array.from({ length: shown }, (_, k) => (
            <span key={k} aria-hidden className="flex items-center">
              {first + k > 1 && <i className="h-px w-1.5 bg-connector" />}
              <span className={cn(ROUNDEL, LANE_RING[lane])}>{first + k}</span>
            </span>
          ))}
        </span>
      ))}
      {total > room && (
        <span aria-hidden className="flex items-center">
          <i className="h-px w-1.5 bg-connector" />
          <span className={cn(ROUNDEL, "border-dashed border-muted-foreground px-1 text-muted-foreground")}>+{total - room}</span>
        </span>
      )}
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

/** Complete = a UI stop and a database or queue stop. "API → DB" = reaches the database or a queue,
 * but no UI code calls it (codeloom check's "API → DB only"). Anything else is incomplete. */
export function CompleteMark({ complete, apiOnly }: { complete: boolean; apiOnly: boolean }) {
  if (complete) return <span className="text-[12.5px] text-foreground">Complete</span>;
  if (apiOnly) {
    return (
      <span className="text-[12.5px] text-foreground" title={API_ONLY_TITLE}>
        API → DB
      </span>
    );
  }
  return <span className="text-[12.5px] text-muted-foreground">Incomplete</span>;
}

/** "Ask your agent: /mcp__codeloom__name-journeys" with a copy button. */
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
      <span>
        Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onMore}>
        Show more ({next.toLocaleString("en-US")})
      </Button>
    </div>
  );
}
