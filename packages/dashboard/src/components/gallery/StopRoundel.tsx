import { cn } from "@/lib/utils";

export type StopState = "default" | "selected" | "unresolved";
export type StopSize = "sm" | "md";

/** The one accessible name a stop has everywhere: "Stop 3: POST /api/customers". */
export function stopLabel(n: number, label: string, unresolved = false): string {
  return `Stop ${n}: ${label}${unresolved ? " (unresolved)" : ""}`;
}

export interface StopRoundelProps {
  n: number;
  label: string;
  state?: StopState;
  size?: StopSize;
  /** Inside a control that already carries the stop's name: hide the roundel from assistive tech. */
  decorative?: boolean;
  className?: string;
}

const SIZE: Record<StopSize, string> = {
  sm: "size-5 text-[9.5px]",
  md: "size-6 text-[11px]",
};

const STATE: Record<StopState, string> = {
  // the audio-guide number: ochre disc, dark ochre ink
  default: "border-accent bg-accent text-accent-foreground",
  // the stop you are standing at: ochre with a soft ochre halo and a dark rim
  selected: "border-accent-foreground bg-accent text-accent-foreground shadow-[0_0_0_4px_rgb(227_167_47_/_0.35)]",
  // a hop codeloom could not follow: hollow, dashed oxblood ring
  unresolved: "border-dashed border-destructive bg-card text-destructive",
};

/** Ochre numbered roundel for one stop of a journey. */
export function StopRoundel({ n, label, state = "default", size = "md", decorative = false, className }: StopRoundelProps) {
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": stopLabel(n, label, state === "unresolved"), "aria-current": state === "selected" ? "step" : undefined } as const);
  return (
    <span
      data-slot="stop-roundel"
      data-state={state}
      data-size={size}
      className={cn(
        "inline-grid flex-none place-items-center rounded-full border-[1.5px] font-mono leading-none font-semibold tabular-nums select-none",
        SIZE[size],
        STATE[state],
        className,
      )}
      {...a11y}
    >
      {n}
    </span>
  );
}
