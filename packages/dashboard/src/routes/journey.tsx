import { useParams, useSearch } from "@tanstack/react-router";
import { JourneyScreen } from "@/screens/journey/JourneyScreen";

/** One journey or chain (`/journeys/$id`, search `stop` = the selected stop's number, 1-based). */
export function JourneyRoute() {
  const { id } = useParams({ from: "/journeys/$id" });
  const { stop } = useSearch({ from: "/journeys/$id" });
  return (
    <section data-testid="screen-journey" className="flex min-w-0 flex-col gap-4">
      <JourneyScreen key={id} id={id} stop={stop} />
    </section>
  );
}
