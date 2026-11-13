/** Review (`/review`): the start page in a hosted PR snapshot — the impact of this PR (counts, affected
 * journeys, changed files). A later task fills this in; for now, a minimal placeholder so static mode has
 * somewhere to land. */
export function ReviewRoute() {
  return (
    <section data-testid="screen-review" aria-labelledby="review-title" className="flex flex-col gap-2">
      <h1 id="review-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
        This PR
      </h1>
    </section>
  );
}
