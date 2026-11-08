import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const H2 = "text-xl font-bold tracking-[-0.02em]";
export const PANEL = "rounded-xl border border-border bg-card";

/** Nothing to show here: a repo or journey the widget names is gone, or the filter matches nothing. */
export function EmptyCard({ children }: { children: ReactNode }) {
  return <p className={cn(PANEL, "px-5 py-4 text-[13.5px] text-muted-foreground")}>{children}</p>;
}
