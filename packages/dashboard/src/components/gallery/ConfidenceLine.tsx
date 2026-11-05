import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** How sure codeloom is about one hop. `unresolved` = it could not follow the hop at all. `unverified` (call edges
 * only) = tree-sitter matched the call by name in a file codeloom's resolver does not read. */
export type Confidence = "exact" | "param" | "guess" | "unresolved" | "unverified";

const NAME: Record<Confidence, string> = {
  exact: "Exact link",
  param: "Matched with a path parameter",
  guess: "Guessed link",
  unresolved: "Unresolved hop",
  unverified: "Unverified call",
};

/** A call edge's `param`: the function is handed over or wired up, not called directly. */
export const LIKELY_CALL = "Likely call (passed or wired, not a direct call)";

const DEFAULT_REASON: Record<"guess" | "unresolved" | "unverified", string> = {
  guess: "Matched loosely, not proven. Check the code before you trust it.",
  unresolved: "codeloom could not find where this hop goes.",
  unverified: "Matched by name only; codeloom could not check this call.",
};

/** Stroke for SVG connectors (Journey lanes, Map overlay), so every connector reads the same.
 * Exact and param use the tan connector wire; guesses are dashed ink-grey; unresolved is dashed oxblood. */
export function confidenceStroke(c: Confidence): { stroke: string; strokeWidth: number; strokeDasharray: string | undefined } {
  switch (c) {
    case "exact":
      return { stroke: "var(--connector)", strokeWidth: 2, strokeDasharray: undefined };
    case "param":
      return { stroke: "var(--connector)", strokeWidth: 1.25, strokeDasharray: undefined };
    case "guess":
    case "unverified":
      return { stroke: "var(--muted-foreground)", strokeWidth: 1.5, strokeDasharray: "4 3" };
    case "unresolved":
      return { stroke: "var(--destructive)", strokeWidth: 1.5, strokeDasharray: "4 3" };
  }
}

const LINE: Record<Confidence, string> = {
  exact: "border-solid border-connector",
  param: "border-solid border-connector",
  guess: "border-dashed border-muted-foreground",
  unverified: "border-dashed border-muted-foreground",
  unresolved: "border-dashed border-destructive",
};

export interface ConfidenceLineProps {
  confidence: Confidence;
  /** Why a hop is a guess or unresolved; shown in the tooltip. Ignored for exact/param. */
  reason?: string;
  /** A call edge rather than a route hop: `param` then reads as a likely call, not a path parameter. */
  call?: boolean;
  orientation?: "vertical" | "horizontal";
  className?: string;
}

/** A connector between two stops: solid when exact, thinner when matched by a parameter,
 * dashed (with the reason on hover/focus) when it is a guess or could not be followed. Never shown as fact. */
export function ConfidenceLine({ confidence, reason, call, orientation = "vertical", className }: ConfidenceLineProps) {
  const doubtful = confidence === "guess" || confidence === "unresolved" || confidence === "unverified";
  const why = doubtful ? reason?.trim() || DEFAULT_REASON[confidence] : undefined;
  const name = call && confidence === "param" ? LIKELY_CALL : NAME[confidence];
  const vertical = orientation === "vertical";
  const width = confidence === "exact" ? 2 : confidence === "param" ? 1 : 1.5;

  const line = (
    <span
      role="img"
      aria-label={why ? `${name}: ${why}` : name}
      data-slot="confidence-line"
      data-confidence={confidence}
      data-stroke={doubtful ? "dashed" : confidence === "param" ? "thin" : "solid"}
      data-orientation={orientation}
      tabIndex={doubtful ? 0 : undefined}
      className={cn(
        "relative flex flex-none items-stretch justify-center",
        vertical ? "min-h-3.5 w-4 flex-col" : "h-4 min-w-3.5 flex-row items-center",
        doubtful && "cursor-help rounded-sm outline-offset-1 focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(vertical ? "h-full self-center" : "w-full", LINE[confidence])}
        style={vertical ? { borderLeftWidth: width, minHeight: "inherit" } : { borderTopWidth: width }}
      />
    </span>
  );

  if (!why) return line;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{line}</TooltipTrigger>
        <TooltipContent side={vertical ? "right" : "top"} className="max-w-64">
          <span className="font-semibold">{name}.</span> {why}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
