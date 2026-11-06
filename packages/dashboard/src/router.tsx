import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, type RouterHistory } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SessionError } from "@/api/client";
import { useMapEvents } from "@/api/events";
import { useOverview, useProgress } from "@/api/queries";
import { Rail } from "@/components/shell/Rail";
import { understoodPercent } from "@/lib/progress";
import { isBlocking, MapStateScreen, StateBanners } from "@/components/shell/StateBanner";
import { HomeRoute } from "@/routes/index";
import { JourneyRoute } from "@/routes/journey";
import { MapRoute } from "@/routes/map";
import { ProgressRoute } from "@/routes/progress";
import { TourRoute } from "@/routes/tour";
import { isPhase } from "@/screens/tour/model";
import type { TourPhase } from "@/api/types";

export interface RouterContext {
  queryClient: QueryClient;
}

/** True once any request came back 401. Sticky: a lost session never comes back without a new link. */
function useSessionExpired(): boolean {
  const queryClient = useQueryClient();
  const [expired, setExpired] = useState(() => queryClient.getQueryCache().getAll().some((q) => q.state.error instanceof SessionError));
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((e) => {
        if (e.type === "updated" && e.query.state.error instanceof SessionError) setExpired(true);
      }),
    [queryClient],
  );
  return expired;
}

/** The shell: viridian rail on the left, the screen on the gallery-white ground. A blocking state (session
 * expired, not indexed, no workspace, bad data) replaces the screen; quiet banners sit above it. */
function Shell() {
  const { data, error } = useOverview();
  const progress = useProgress();
  const { paused } = useMapEvents();
  const expired = useSessionExpired();
  const blocking = expired ? new SessionError() : isBlocking(error) ? error : undefined;
  // Once a screen has been shown, a blocking state that replaces it takes focus (its heading), so keyboard
  // and screen-reader users are not left on an element that just disappeared. On first load it does not.
  const screenShown = useRef(false);
  const focusState = !!blocking && screenShown.current;
  useEffect(() => {
    if (!blocking && data) screenShown.current = true;
  });
  return (
    <div className="flex h-dvh min-h-0 bg-background">
      <Rail overview={data} failed={!!error} livePaused={paused} understood={progress.data ? understoodPercent(progress.data.totals.all) : undefined} />
      <main className="flex min-w-0 flex-1 flex-col gap-5.5 overflow-y-auto px-9 py-7">
        {blocking ? (
          <MapStateScreen error={blocking} focusOnShow={focusState} />
        ) : (
          <>
            {data && <StateBanners overview={data} />}
            <Outlet />
          </>
        )}
      </main>
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export interface JourneySearch {
  stop?: number;
}
export interface TourSearch {
  phase?: TourPhase;
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

const tourRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journeys/$id/tour",
  validateSearch: (s: Record<string, unknown>): TourSearch => {
    const stop = Number(s.stop);
    return { ...(isPhase(s.phase) ? { phase: s.phase } : {}), ...(Number.isInteger(stop) && stop >= 1 ? { stop } : {}) };
  },
  component: TourRoute,
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

const progressRoute = createRoute({ getParentRoute: () => rootRoute, path: "/progress", component: ProgressRoute });

export const routeTree = rootRoute.addChildren([indexRoute, journeyRoute, tourRoute, mapRoute, progressRoute]);

export function createAppRouter({ queryClient, history }: { queryClient: QueryClient; history?: RouterHistory }) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: false, ...(history ? { history } : {}) });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
