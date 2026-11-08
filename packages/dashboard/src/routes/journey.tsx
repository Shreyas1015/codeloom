import { useParams, useSearch } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

// The Journey screen brings Shiki (code highlighting); load it only when a journey is opened.
const JourneyScreen = lazy(() => import("@/screens/journey/JourneyScreen").then((m) => ({ default: m.JourneyScreen })));

/** One journey or chain (`/journeys/$id`, search `stop` = the selected stop's number, 1-based; `tab` = the open tab). */
export function JourneyRoute() {
  const { id } = useParams({ from: "/journeys/$id" });
  const { stop, tab } = useSearch({ from: "/journeys/$id" });
  return (
    <section data-testid="screen-journey" className="flex min-w-0 flex-col gap-4">
      <Suspense
        fallback={
          <p role="status" aria-busy="true" className="text-[13px] text-muted-foreground">
            Loading journey…
          </p>
        }
      >
        <JourneyScreen key={id} id={id} stop={stop} tab={tab} />
      </Suspense>
    </section>
  );
}
