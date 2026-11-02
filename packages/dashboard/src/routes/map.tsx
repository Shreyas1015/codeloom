import { lazy, Suspense } from "react";

// React Flow is the biggest dependency in the app; load it only when the Map is opened.
const MapScreen = lazy(() => import("@/screens/map/MapScreen").then((m) => ({ default: m.MapScreen })));

/** Map (`/map`, search `repo`, `dir`, `node`, `overlay`). */
export function MapRoute() {
  return (
    <Suspense
      fallback={
        <section data-testid="screen-map" aria-busy="true" aria-label="Map" className="flex flex-1 items-center justify-center">
          <p role="status" className="text-[14px] text-muted-foreground">
            Loading the map…
          </p>
        </section>
      }
    >
      <MapScreen />
    </Suspense>
  );
}
