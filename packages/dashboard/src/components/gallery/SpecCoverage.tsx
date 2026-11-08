import type { SpecCoverage, SpecsResponse } from "@/api/types";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { coverageParts, SPEC_MARKS, type SpecMark } from "@/lib/specs";
import { cn } from "@/lib/utils";

const fmt = (n: number) => n.toLocaleString("en-US");

/** The badge each column counts (its header doubles as the legend). */
const BADGE: Record<SpecMark, { state: "linked" | "candidates" | "none"; checked: boolean }> = {
  linked: { state: "linked", checked: true },
  candidates: { state: "candidates", checked: false },
  none: { state: "none", checked: true },
  unchecked: { state: "none", checked: false },
};

/** "n of N journeys have a linked spec" for a coverage total. */
export function coverageSentence(c: SpecCoverage): string {
  return `${fmt(c.linked)} of ${fmt(c.total)} ${c.total === 1 ? "journey" : "journeys"} ${c.total === 1 ? "has" : "have"} a linked spec`;
}

/** Spec coverage per repo or per area: linked, candidates waiting, no spec and not checked, which add up to
 * the journeys in that row. A journey in two repos counts in both. */
export function SpecCoverageTable({ specs, by, className }: { specs: SpecsResponse; by: "repo" | "area"; className?: string }) {
  const groups = by === "repo" ? specs.totals.byRepo : specs.totals.byArea;
  const rows = Object.keys(groups)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => ({ key: k, c: groups[k]! }));
  const th = "px-4 py-2 text-left text-xs font-semibold text-muted-foreground";
  const td = "px-4 py-2.5 align-middle tabular-nums";
  return (
    <div className={cn("overflow-x-auto rounded-xl border border-border bg-card", className)}>
      <table aria-label={`Spec coverage by ${by}`} className="w-full min-w-[560px] border-collapse text-[13.5px]">
        <thead className="border-b border-border bg-muted/40">
          <tr>
            <th scope="col" className={th}>
              {by === "repo" ? "Repo" : "Area"}
            </th>
            {SPEC_MARKS.map((m) => (
              <th key={m} scope="col" className={cn(th, "w-[130px]")}>
                <SpecBadge {...BADGE[m]} />
              </th>
            ))}
            <th scope="col" className={cn(th, "w-[90px]")}>
              Journeys
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-4 text-muted-foreground">
                No journeys yet.
              </td>
            </tr>
          ) : (
            rows.map(({ key, c }) => {
              const parts = coverageParts(c);
              return (
                <tr key={key}>
                  <td className={cn(td, by === "repo" ? "font-mono text-[12.5px] font-semibold" : "font-semibold")}>{key || "No area"}</td>
                  {SPEC_MARKS.map((m) => (
                    <td key={m} className={cn(td, parts[m] === 0 && "text-muted-foreground")}>
                      {fmt(parts[m])}
                    </td>
                  ))}
                  <td className={cn(td, "font-semibold")}>{fmt(c.total)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
