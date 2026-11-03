import { useId } from "react";
import { Breakable } from "@/lib/breakable";
import { cn } from "@/lib/utils";
import { type Confidence, ConfidenceLine } from "./ConfidenceLine";
import { StopRoundel, stopLabel } from "./StopRoundel";

export type Lane = "ui" | "api" | "code" | "db" | "queue";

export interface LaneStop {
  /** Stop number in chain order (1-based), shared across lanes. */
  index: number;
  label: string;
  /** `file:line`, a table op, … — shown in mono. */
  detail?: string;
  note?: string;
  /** Confidence of the hop that arrives at this stop from the stop above it in this lane. Default exact. */
  confidence?: Confidence;
  /** Why that hop is a guess or unresolved. */
  reason?: string;
  unresolved?: boolean;
  /** False when no hop leads from the stop above to this one (they only share the lane): no connector is
   * drawn, just a plain gap. Default true. */
  connected?: boolean;
}

export const LANE_NAME: Record<Lane, string> = { ui: "UI", api: "API", code: "Code", db: "DB", queue: "Queue" };

// header ink in the lane hue (each ≥ 4.5:1 on its soft ground); the queue lane reads in the DB umber family
const LANE_STYLE: Record<Lane, { ground: string; ink: string }> = {
  ui: { ground: "bg-lane-ui-soft", ink: "text-lane-ui" },
  api: { ground: "bg-lane-api-soft", ink: "text-lane-api" },
  code: { ground: "bg-lane-code-soft", ink: "text-lane-code" },
  db: { ground: "bg-lane-db-soft", ink: "text-lane-db" },
  queue: { ground: "bg-lane-queue-soft", ink: "text-lane-db" },
};

export interface LaneColumnProps {
  lane: Lane;
  /** Repo or store shown beside the lane name, e.g. "core-service" or "Postgres". */
  subtitle?: string;
  stops: LaneStop[];
  selectedIndex?: number;
  /** When given, each stop is a button. */
  onSelect?: (index: number) => void;
  className?: string;
}

/** One lane of a journey: a hued header, then the lane's stops stacked in order with connectors between them. */
export function LaneColumn({ lane, subtitle, stops, selectedIndex, onSelect, className }: LaneColumnProps) {
  const id = useId();
  const name = LANE_NAME[lane];
  const style = LANE_STYLE[lane];
  return (
    <section
      aria-labelledby={`${id}-h`}
      data-slot="lane-column"
      data-lane={lane}
      className={cn("flex min-w-0 flex-col gap-3 rounded-[10px] p-2.5", style.ground, className)}
    >
      <h3 className={cn("flex items-baseline justify-between gap-2 text-[12.5px] font-bold", style.ink)}>
        <span id={`${id}-h`}>{name}</span>
        {subtitle ? <span className="truncate font-mono text-xs font-normal">{subtitle}</span> : null}
      </h3>
      {stops.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">No stops in this lane</p>
      ) : (
        <ol aria-label={`${name} stops`} className="flex flex-col">
          {stops.map((s, i) => {
            const selected = s.index === selectedIndex;
            const detailId = `${id}-d${s.index}`;
            const body = (
              <>
                <StopRoundel
                  n={s.index}
                  label={s.label}
                  state={s.unresolved ? "unresolved" : selected ? "selected" : "default"}
                  decorative={!!onSelect}
                  className={s.unresolved && selected ? "shadow-[0_0_0_4px_rgb(227_167_47_/_0.35)]" : undefined}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  {/* names and paths wrap at "/", "." and word humps (title two lines at most, path three), never mid-segment;
                      the full text is the tooltip */}
                  <span title={s.label} className="line-clamp-2 text-[13px] leading-[1.3] font-semibold wrap-break-word text-foreground">
                    <Breakable text={s.label} />
                  </span>
                  {s.detail ? (
                    <>
                      <span aria-hidden={onSelect ? true : undefined} title={s.detail} className="line-clamp-3 font-mono text-[11.5px] leading-[1.35] wrap-break-word text-muted-foreground">
                        <Breakable text={s.detail} />
                      </span>
                      {/* a button's description: the plain path (the wrap points above are for the eye only) */}
                      {onSelect ? (
                        <span id={detailId} className="sr-only">
                          {s.detail}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {s.note ? <span className="mt-0.5 text-xs text-muted-foreground">{s.note}</span> : null}
                </span>
              </>
            );
            // like the roundel, "unresolved" wins the border: a selected unresolved stop keeps its dashed
            // oxblood edge, and the selection sits outside it as the ochre ring
            const card = cn(
              "relative flex w-full items-start gap-2 rounded-[9px] border bg-card px-2.5 py-2 text-left shadow-[0_1px_2px_rgb(20_40_35_/_0.06)]",
              s.unresolved ? "border-dashed border-destructive" : selected ? "border-accent-foreground" : "border-border",
              selected && "shadow-[0_0_0_3px_rgb(227_167_47_/_0.4)]",
            );
            return (
              <li key={s.index} className="flex flex-col">
                {i === 0 ? null : s.connected === false ? (
                  <span aria-hidden="true" data-slot="lane-gap" className="block h-3.5" />
                ) : (
                  <ConfidenceLine confidence={s.confidence ?? "exact"} reason={s.reason} className="ml-[15px]" />
                )}
                {onSelect ? (
                  <button
                    type="button"
                    aria-label={stopLabel(s.index, s.label, s.unresolved)}
                    aria-describedby={s.detail ? detailId : undefined}
                    aria-current={selected ? "step" : undefined}
                    onClick={() => onSelect(s.index)}
                    className={cn(
                      card,
                      "cursor-pointer transition-colors outline-offset-2 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none",
                    )}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={card}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
