import type { SpecState } from "@/api/types";
import { type SpecMark, SPEC_WORD, specMark } from "@/lib/specs";
import { cn } from "@/lib/utils";

/** Linked: viridian on the API wash. Candidates: deep-ochre edge and ochre ink on the ochre wash (ochre fill
 * is a stop's alone). No spec: oxblood ink, always with a dashed edge and the word. Not checked: muted. */
const TONE: Record<SpecMark, string> = {
  linked: "border-transparent bg-lane-api-soft text-primary",
  candidates: "border-ring bg-accent-soft text-accent-foreground",
  // on white: oxblood reads 5.3:1 there (4.3:1 on its own wash, under the 4.5 floor for 11.5px text)
  none: "border-dashed border-destructive bg-card text-destructive",
  unchecked: "border-transparent bg-secondary text-muted-foreground",
};

/** A journey's spec state as a small pill, in words. Render it only once the state is known: never a placeholder. */
export function SpecBadge({ state, checked, title, className }: { state: SpecState; checked: boolean; title?: string; className?: string }) {
  const mark = specMark({ state, checked });
  return (
    <span
      data-spec={mark}
      title={title}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-[4px] border px-1.75 py-px text-[11.5px] leading-[1.35] font-semibold whitespace-nowrap",
        TONE[mark],
        className,
      )}
    >
      {SPEC_WORD[mark]}
    </span>
  );
}
