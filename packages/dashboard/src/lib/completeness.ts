import type { StopView } from "@/api/types";

/** Tooltip for the "API → DB" mark: codeloom check's "API → DB only (no UI caller)". */
export const API_ONLY_TITLE = "Reaches the database, but no UI code calls it";

/** Same rule as codeloom's linker/completeness.ts: reaches a db or publish stop, with no page or call stop. */
export function isApiOnly(stops: Pick<StopView, "kind">[]): boolean {
  const store = stops.some((s) => s.kind === "db" || s.kind === "publish");
  const ui = stops.some((s) => s.kind === "page" || s.kind === "call");
  return store && !ui;
}
