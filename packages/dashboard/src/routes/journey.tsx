import { useParams } from "@tanstack/react-router";

/** One journey (`/journeys/$id`, search `stop`). Task 7 builds the lanes here. */
export function JourneyRoute() {
  const { id } = useParams({ strict: false });
  return (
    <section data-testid="screen-journey" aria-labelledby="journey-title">
      <h1 id="journey-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em]">
        Journey
      </h1>
      <p className="mt-1 font-mono text-[12.5px] text-muted-foreground">{id}</p>
    </section>
  );
}
