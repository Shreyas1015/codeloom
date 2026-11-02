import { useSearch } from "@tanstack/react-router";

/** Map (`/map`, search `repo`, `dir`, `node`, `overlay`). Task 9 builds the graph here. */
export function MapRoute() {
  const { repo } = useSearch({ strict: false });
  return (
    <section data-testid="screen-map" aria-labelledby="map-title">
      <h1 id="map-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em]">
        Map
      </h1>
      {repo && <p className="mt-1 font-mono text-[12.5px] text-muted-foreground">{repo}</p>}
    </section>
  );
}
