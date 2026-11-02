import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ApiError } from "@/api/client";
import { useJourney, useOverview } from "@/api/queries";
import { stopLabel } from "@/components/gallery/StopRoundel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { rememberLastJourney } from "@/screens/home/lastJourney";
import { ChainsView } from "./ChainsView";
import { LanesView } from "./LanesView";
import { buildJourneyModel, stopTitle } from "./model";
import { Nameplate } from "./Nameplate";
import { StopInspector } from "./StopInspector";


/** Keys that belong to whatever has focus: typing, tabs, scrolling code. */
function ownsArrows(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || !!t.closest("input, textarea, select, pre, [role='tablist'], [role='slider']");
}

export function JourneyScreen({ id, stop }: { id: string; stop?: number }) {
  const { data, error, isPending } = useJourney(id);
  const overview = useOverview();
  const navigate = useNavigate();
  const model = useMemo(() => (data ? buildJourneyModel(data) : undefined), [data]);
  const count = model?.stops.length ?? 0;
  const selected = count === 0 ? undefined : stop !== undefined && stop >= 1 && stop <= count ? stop : 1;

  const select = useCallback(
    (n: number) => void navigate({ to: "/journeys/$id", params: { id }, search: { stop: n }, replace: true }),
    [navigate, id],
  );

  // a ?stop= outside the journey is put right in the URL once the journey is known
  useEffect(() => {
    if (!model || stop === undefined || stop === selected) return;
    void navigate({ to: "/journeys/$id", params: { id }, search: selected === undefined ? {} : { stop: selected }, replace: true });
  }, [model, stop, selected, navigate, id]);

  // held or fast keys fire before the URL change re-renders: step from the last stop asked for
  const body = useRef<HTMLDivElement>(null);
  const at = useRef(selected);
  at.current = selected;
  useEffect(() => {
    if (count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || ownsArrows(e.target)) return;
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const from = at.current ?? 1;
      const next = Math.min(count, Math.max(1, from + step));
      e.preventDefault();
      if (next === from) return;
      at.current = next;
      select(next);
      // focus follows the selection: the stop's button in the open tab
      body.current?.querySelector<HTMLElement>(`button[aria-label^="Stop ${next}:"]`)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, select]);

  const workspace = overview.data?.name;
  const loadedId = data ? (data.journey?.id ?? data.chains[0]?.id) : undefined;
  useEffect(() => {
    if (workspace && loadedId) rememberLastJourney(workspace, loadedId);
  }, [workspace, loadedId]);

  if (isPending) return <p className="text-[13px] text-muted-foreground">Loading journey…</p>;

  if (error) {
    if (error instanceof ApiError && error.status === 404) {
      return (
        <section aria-labelledby="journey-missing" className="flex max-w-[60ch] flex-col gap-2">
          <h1 id="journey-missing" className="text-[24px] font-bold tracking-[-0.02em]">
            Journey not found
          </h1>
          <p className="text-[14px] text-muted-foreground">
            Nothing in this map is called <span className="font-mono text-foreground">{id}</span>. It may have been renamed or deleted.
          </p>
          <Link to="/" className="w-fit text-[14px] font-semibold text-primary underline-offset-3 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            Back to all journeys
          </Link>
        </section>
      );
    }
    return (
      <p role="alert" className="text-[14px] text-destructive">
        {error.message}
      </p>
    );
  }

  const m = model!;
  const current = selected === undefined ? undefined : m.stops[selected - 1];
  const orphaned = data.journey?.status === "orphaned";
  const missing = data.missingChainIds.length;

  return (
    <>
      <Nameplate result={data} model={m} />
      {orphaned ? (
        <p role="status" className="rounded-lg bg-destructive-soft px-4 py-3 text-[14px] text-foreground">
          <b className="text-destructive">This journey's code is gone.</b> Re-name or delete it through your agent.
        </p>
      ) : missing > 0 ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          {missing === 1 ? "1 chain of this journey is" : `${missing} chains of this journey are`} no longer in the map.
        </p>
      ) : null}
      {m.stops.length > 0 ? (
        <Tabs defaultValue="lanes" className="gap-4">
          <TabsList variant="line" className="h-auto w-full justify-start gap-5.5 border-b border-border p-0 pb-2">
            <TabsTrigger value="lanes" className="flex-none px-0 text-[14px]">
              Lanes
            </TabsTrigger>
            <TabsTrigger value="chains" className="flex-none px-0 text-[14px]">
              Chains
            </TabsTrigger>
          </TabsList>
          <div className="grid min-h-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div ref={body} className="min-w-0">
              <TabsContent value="lanes">
                <LanesView result={data} model={m} selected={selected} onSelect={select} />
              </TabsContent>
              <TabsContent value="chains">
                <ChainsView chains={data.chains} model={m} selected={selected} onSelect={select} />
              </TabsContent>
            </div>
            <StopInspector stop={current} journeyId={data.journey?.id ?? id} />
          </div>
          <p role="status" aria-live="polite" aria-label="Selected stop" className="sr-only">
            {current ? stopLabel(current.n, stopTitle(current.view)) : ""}
          </p>
        </Tabs>
      ) : orphaned ? null : (
        <p className="text-[13px] text-muted-foreground">This journey has no stops yet.</p>
      )}
    </>
  );
}
