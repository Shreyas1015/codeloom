import { cn } from "@/lib/utils";

export interface Counts {
  files: number;
  pages: number;
  routes: number;
  tables: number;
  queues: number;
  journeys: number;
}

const CELLS: Array<{ key: keyof Counts; caption: string }> = [
  { key: "files", caption: "Files" },
  { key: "pages", caption: "UI pages" },
  { key: "routes", caption: "API routes" },
  { key: "tables", caption: "DB tables" },
  { key: "queues", caption: "Queues" },
  { key: "journeys", caption: "User journeys" },
];

const fmt = new Intl.NumberFormat("en-US");

/** Hairline six-cell grid of workspace totals: a heavy ink rule on top, hairlines between cells. */
export function CountStrip({ counts, className, label = "Totals" }: { counts: Counts; className?: string; label?: string }) {
  return (
    <ul
      aria-label={label}
      data-slot="count-strip"
      className={cn(
        "grid grid-cols-3 border-t-2 border-b border-t-foreground border-b-border lg:grid-cols-6",
        "[&>li]:border-border max-lg:[&>li:nth-child(-n+3)]:border-b max-lg:[&>li:nth-child(3n)]:border-r-0 lg:[&>li:last-child]:border-r-0",
        className,
      )}
    >
      {CELLS.map(({ key, caption }) => (
        <li key={key} className="flex flex-col gap-0.5 border-r px-4 py-[11px]">
          <span data-slot="count-value" className="text-2xl leading-tight font-bold tracking-[-0.02em] tabular-nums">
            {fmt.format(counts[key])}
          </span>
          <span data-slot="count-caption" className="text-[12.5px] text-muted-foreground">
            {caption}
          </span>
        </li>
      ))}
    </ul>
  );
}
