import { type DisplayLevel, LEVEL_STEPS, LEVEL_WORD, type StripCounts } from "@/lib/progress";
import { cn } from "@/lib/utils";

const pct = (n: number, of: number) => `${of > 0 ? Math.round((n / of) * 10000) / 100 : 0}%`;
const journeys = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "journey" : "journeys"}`;

const SEGMENTS = [
  { key: "understood", cls: "bg-progress-understood" },
  { key: "toured", cls: "bg-progress-toured" },
  { key: "seen", cls: "bg-progress-seen" },
] as const;

/** Three segments (understood, toured, seen) of a set of journeys. Strips that share a `scale` (the largest
 * total among them) share a baseline: each track starts at the same left edge and is as long as its total,
 * so a repo with more journeys draws a longer bar. One image; its name reads every count. */
export function ProgressStrip({ counts, scale = counts.total, className }: { counts: StripCounts; scale?: number; className?: string }) {
  const parts = SEGMENTS.filter((s) => counts[s.key] > 0);
  const label =
    counts.total === 0
      ? "No journeys"
      : `${parts.length ? parts.map((s) => `${counts[s.key].toLocaleString("en-US")} ${s.key}`).join(", ") : "none started"}, of ${journeys(counts.total)}`;
  return (
    <div role="img" aria-label={label} title={label} className={cn("w-full", className)}>
      <div
        data-slot="progress-track"
        style={{ width: pct(counts.total, Math.max(scale, counts.total)) }}
        className="flex h-3.5 min-w-1 gap-px overflow-hidden rounded-[3px] bg-muted"
      >
        {parts.map((s) => (
          <i key={s.key} data-segment={s.key} style={{ width: pct(counts[s.key], counts.total) }} className={cn("block h-full", s.cls)} />
        ))}
      </div>
    </div>
  );
}

/** The legend for ProgressStrip's three colours. */
export function ProgressLegend({ className }: { className?: string }) {
  return (
    <ul aria-label="Legend" className={cn("flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground", className)}>
      {SEGMENTS.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <i aria-hidden className={cn("size-2.5 rounded-[2px]", s.cls)} />
          {LEVEL_WORD[s.key]}
        </li>
      ))}
    </ul>
  );
}

const stops = (n: number) => `${n} stop${n === 1 ? "" : "s"}`;

/** One journey's level as three steps (seen, toured, understood) with the word under them. A journey that
 * needs a re-walk fills two steps, dashed in deep ochre, and says how many stops to re-walk. */
export function LevelStrip({ level, changed = 0, className }: { level: DisplayLevel; changed?: number; className?: string }) {
  const filled = LEVEL_STEPS[level];
  const rewalk = level === "re-walk";
  return (
    <span data-level={level} className={cn("grid w-30 grid-cols-3 gap-0.75", className)}>
      {[0, 1, 2].map((i) => (
        <i
          key={i}
          aria-hidden
          data-step={i < filled ? "on" : "off"}
          className={cn(
            "h-2 rounded-[2px] border",
            i >= filled
              ? "border-border bg-muted"
              : rewalk
                ? "border-dashed border-ring bg-accent-soft"
                : "border-progress-understood bg-progress-understood",
          )}
        />
      ))}
      <small className="col-span-3 text-xs text-muted-foreground">{rewalk ? `Re-walk ${stops(changed)}` : LEVEL_WORD[level]}</small>
    </span>
  );
}

const BADGE: Record<Exclude<DisplayLevel, "none">, string> = {
  seen: "bg-secondary text-foreground",
  toured: "bg-progress-seen text-foreground",
  understood: "bg-success-soft text-foreground",
  "re-walk": "border border-dashed border-ring bg-accent-soft text-accent-foreground",
};

/** The Journey nameplate's level pill. Nothing before the journey was opened. */
export function LevelBadge({ level, changed = 0, className }: { level: DisplayLevel; changed?: number; className?: string }) {
  if (level === "none") return null;
  return (
    <span
      data-level={level}
      className={cn("inline-flex items-center rounded-[4px] px-1.75 py-px text-[11.5px] font-semibold", BADGE[level], className)}
    >
      {level === "re-walk" ? `${LEVEL_WORD[level]} · ${stops(changed)} changed` : LEVEL_WORD[level]}
    </span>
  );
}
