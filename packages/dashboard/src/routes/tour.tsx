import { useParams, useSearch } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// Tour mode brings Shiki (code highlighting); load it only when a tour is opened.
const TourScreen = lazy(() => import("@/screens/tour/TourScreen").then((m) => ({ default: m.TourScreen })));

/** Tour mode (`/journeys/$id/tour`, search `phase` = flow | data-journey | file-notes | check, `stop` = the
 * Flow stop's 1-based place in the tour, `stopId` = its line-free identity, resolved to the right `stop`
 * even when a link was built from a different stop order). */
export function TourRoute() {
  const { id } = useParams({ from: "/journeys/$id/tour" });
  const { phase, stop, stopId } = useSearch({ from: "/journeys/$id/tour" });
  return (
    <section data-testid="screen-tour" className="flex min-w-0 flex-1 flex-col">
      <Suspense
        fallback={
          <p role="status" aria-busy="true" className="text-[13px] text-muted-foreground">
            Loading tour…
          </p>
        }
      >
        <TourScreen key={id} id={id} phase={phase} stop={stop} stopId={stopId} />
      </Suspense>
    </section>
  );
}
