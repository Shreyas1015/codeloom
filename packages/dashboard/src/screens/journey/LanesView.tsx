import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JourneyResult, Lane } from "@/api/types";
import { confidenceStroke } from "@/components/gallery/ConfidenceLine";
import { LaneColumn, type LaneStop } from "@/components/gallery/LaneColumn";
import { LANE_ORDER, type JourneyHop, type JourneyModel, type JourneyStop, stopTitle } from "./model";
import { fileLine } from "./words";

export interface LanesViewProps {
  result: JourneyResult;
  model: JourneyModel;
  selected?: number;
  onSelect: (n: number) => void;
}

const notAHop = (a: number, b: number) =>
  `No chain goes straight from stop ${a} to stop ${b}; they only share this lane.`;

/** One lane's stops for LaneColumn. The line above each stop is the hop from the stop above it, when a chain
 * makes that hop; when two neighbours are not a hop, the line is dashed and says so (never drawn as fact). */
function laneStops(stops: JourneyStop[], hops: JourneyHop[]): LaneStop[] {
  return stops.map((s, i) => {
    const prev = stops[i - 1];
    const hop = prev && hops.find((h) => h.from === prev.n && h.to === s.n);
    const view = s.view;
    return {
      index: s.n,
      label: stopTitle(view),
      detail: fileLine(view.file, view.line),
      ...(view.op ? { note: view.op } : {}),
      unresolved: s.unresolved,
      ...(prev
        ? hop
          ? { confidence: hop.confidence, ...(hop.reason ? { reason: hop.reason } : {}) }
          : { confidence: "guess" as const, reason: notAHop(prev.n, s.n) }
        : {}),
    };
  });
}

interface Wire {
  hop: JourneyHop;
  d: string;
}

/** The hops LaneColumn does not draw itself: across lanes, or within a lane but skipping stops. */
function wireHops(model: JourneyModel): JourneyHop[] {
  const pos = new Map<number, { lane: Lane; i: number }>();
  for (const l of LANE_ORDER) model.lanes[l].forEach((s, i) => pos.set(s.n, { lane: l, i }));
  return model.hops.filter((h) => {
    const a = pos.get(h.from)!;
    const b = pos.get(h.to)!;
    return !(a.lane === b.lane && b.i === a.i + 1);
  });
}

/** UI / API / Code / DB (+ Queue) lanes, with SVG wires between stops in different lanes. */
export function LanesView({ result, model, selected, onSelect }: LanesViewProps) {
  const lanes = LANE_ORDER.filter((l) => l !== "queue" || model.showQueue);
  const hops = useMemo(() => wireHops(model), [model]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [wires, setWires] = useState<Wire[]>(() => hops.map((hop) => ({ hop, d: "M0 0" })));

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const o = el.getBoundingClientRect();
      const card = (n: number) => {
        const s = model.stops[n - 1]!;
        const i = model.lanes[s.view.lane].indexOf(s);
        const li = el.querySelectorAll(`[data-lane="${s.view.lane}"] ol > li`)[i];
        const r = (li?.lastElementChild ?? li)?.getBoundingClientRect();
        return r
          ? { l: r.left - o.left, r: r.right - o.left, y: r.top - o.top + Math.min(r.height / 2, 22) }
          : { l: 0, r: 0, y: 0 };
      };
      setSize({ w: o.width, h: o.height });
      setWires(
        hops.map((hop) => {
          const a = card(hop.from);
          const b = card(hop.to);
          if (model.stops[hop.from - 1]!.view.lane === model.stops[hop.to - 1]!.view.lane) {
            const x = a.r;
            return { hop, d: `M${x} ${a.y} C${x + 12} ${a.y} ${x + 12} ${b.y} ${x} ${b.y}` };
          }
          const right = b.l >= a.r;
          const x1 = right ? a.r : a.l;
          const x2 = right ? b.l : b.r;
          const mid = (x1 + x2) / 2;
          return { hop, d: `M${x1} ${a.y} C${mid} ${a.y} ${mid} ${b.y} ${x2} ${b.y}` };
        }),
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hops, model]);

  const subtitle = (l: Lane) => [...new Set(model.lanes[l].map((s) => s.view.repo))].sort().join(", ") || undefined;

  return (
    <div className="flex flex-col gap-4">
      <div ref={box} className="relative rounded-xl border border-border bg-card p-3.5">
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-visible" width={size.w} height={size.h}>
          {wires.map(({ hop, d }) => {
            const s = confidenceStroke(hop.confidence);
            return (
              <path
                key={`${hop.from}>${hop.to}`}
                data-slot="journey-wire"
                data-from={hop.from}
                data-to={hop.to}
                data-confidence={hop.confidence}
                d={d}
                fill="none"
                stroke={s.stroke}
                strokeWidth={s.strokeWidth}
                strokeDasharray={s.strokeDasharray}
                strokeLinecap="round"
              />
            );
          })}
        </svg>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}>
          {lanes.map((l) => (
            <LaneColumn
              key={l}
              lane={l}
              subtitle={subtitle(l)}
              stops={laneStops(model.lanes[l], model.hops)}
              selectedIndex={selected}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
      <UnresolvedList items={result.unresolved} />
    </div>
  );
}

export function UnresolvedList({ items, label = "Unresolved hops" }: { items: JourneyResult["unresolved"] | Array<Omit<JourneyResult["unresolved"][number], "chainId">>; label?: string }) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[12.5px] font-bold text-destructive">{label}</h3>
      <ul aria-label={label} className="flex flex-col gap-1.5">
        {items.map((u, i) => (
          <li key={i} className="flex flex-col rounded-lg border border-dashed border-destructive bg-card px-3 py-2">
            <span className="font-mono text-xs text-destructive">{`${u.at.repo} · ${fileLine(u.at.file, u.at.line)}`}</span>
            <span className="text-[13px] text-foreground">{u.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
