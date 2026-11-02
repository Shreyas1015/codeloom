import { useOverview } from "@/api/queries";

/** Home (`/`). Task 6 builds the count strip and journey list here. */
export function HomeRoute() {
  const { data } = useOverview();
  return (
    <section data-testid="screen-home" aria-labelledby="home-title">
      <h1 id="home-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
        {data?.name ?? "Home"}
      </h1>
    </section>
  );
}
