import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, type RouterHistory } from "@tanstack/react-router";
import { useMapEvents } from "@/api/events";
import { useOverview } from "@/api/queries";
import { Rail } from "@/components/shell/Rail";
import { HomeRoute } from "@/routes/index";
import { JourneyRoute } from "@/routes/journey";
import { MapRoute } from "@/routes/map";

export interface RouterContext {
  queryClient: QueryClient;
}

/** The shell: viridian rail on the left, the screen on the gallery-white ground. */
function Shell() {
  const { data } = useOverview();
  const { paused } = useMapEvents();
  return (
    <div className="flex h-dvh min-h-0 bg-background">
      <Rail overview={data} livePaused={paused} />
      <main className="flex min-w-0 flex-1 flex-col gap-5.5 overflow-y-auto px-9 py-7">
        <Outlet />
      </main>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export interface JourneySearch {
  stop?: number;
}
export interface MapSearch {
  repo?: string;
  dir?: string;
  node?: string;
  overlay?: string;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Shell });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRoute });

const journeyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journeys/$id",
  validateSearch: (s: Record<string, unknown>): JourneySearch => {
    const stop = Number(s.stop);
    return Number.isInteger(stop) && stop >= 0 ? { stop } : {};
  },
  component: JourneyRoute,
});

const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/map",
  validateSearch: (s: Record<string, unknown>): MapSearch => {
    const out: MapSearch = {};
    for (const k of ["repo", "dir", "node", "overlay"] as const) {
      const v = str(s[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  },
  component: MapRoute,
});

export const routeTree = rootRoute.addChildren([indexRoute, journeyRoute, mapRoute]);

export function createAppRouter({ queryClient, history }: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: false, ...(history ? { history } : {}) });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
