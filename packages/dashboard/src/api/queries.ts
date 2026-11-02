import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client.js";
import type { Overview } from "./types.js";

/** Query keys (contract in the Plan 3 registry). Later tasks add the rest. */
export const queryKeys = {
  overview: () => ["overview"] as const,
};

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview(), queryFn: () => apiGet<Overview>("/api/overview") });
}
