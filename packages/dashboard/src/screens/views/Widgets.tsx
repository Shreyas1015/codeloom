/** One renderer per view widget type. Every widget reads the same queries the built-in screens use, fails
 * locally (a card in its own place, never the shell), and handles a repo or journey that no longer exists
 * with an empty card. */
import { Link } from "@tanstack/react-router";
import { FileWarning, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, lazy, type ReactNode, Suspense, useId, useMemo } from "react";
import { MapStateError } from "@/api/client";
import { useJourneys, useOverview, useProgress, useSpecs } from "@/api/queries";
import type { JourneyProgressView, JourneyRow, JourneySpecRow, Widget } from "@/api/types";
import { Command } from "@/components/gallery/CopyCommand";
import { coverageSentence, SpecCoverageTable } from "@/components/gallery/SpecCoverage";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { SpecsError } from "@/components/gallery/SpecsError";
import { MATCH_SPECS, specMark } from "@/lib/specs";
import { LevelStrip, ProgressStrip } from "@/components/gallery/ProgressStrip";
import { displayLevel, stripCounts } from "@/lib/progress";
import { cn } from "@/lib/utils";
import { LaneCounts } from "@/screens/home/parts";
import { areaRows, recentChecks, repoRows } from "@/screens/progress/model";
import { NoteMarkdown } from "./NoteMarkdown";
import { countCells, filterViewJourneys, type JourneysWidget, sortViewJourneys } from "./model";
import { EmptyCard, H2, PANEL } from "./parts";

// React Flow is the biggest dependency in the app; a map widget loads it only when a view has one.
const MapWidget = lazy(() => import("./MapWidget").then((m) => ({ default: m.MapWidget })));

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const LINK =
  "rounded-sm underline-offset-3 outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring";
const CAPTION = "text-[13px] text-muted-foreground";

// ---- frame, states ------------------------------------------------------------------------------

/** A widget's own section: a headline, an optional caption, and its body. */
function Frame({ title, caption, children, className }: { title: string; caption?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className={H2}>
          {title}
        </h2>
        {caption && <p className={CAPTION}>{caption}</p>}
      </div>
      {children}
    </section>
  );
}

function Loading({ label, height = "h-24" }: { label: string; height?: string }) {
  return <div aria-busy="true" aria-label={label} className={cn("rounded-xl bg-muted motion-safe:animate-pulse", height)} />;
}

/** The widget's data could not load. A bad .codeloom file names the fix; anything else says what failed. */
function WidgetError({ error, what, file }: { error: Error; what: string; file: string }) {
  const bad = error instanceof MapStateError && error.code === "bad-data";
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-destructive bg-card px-5 py-4 text-[13.5px]">
      <b className="flex items-center gap-1.5 text-destructive">
        <FileWarning aria-hidden className="size-4 shrink-0" />
        {bad ? `${what} can't be read` : `${what} could not load`}
      </b>
      {bad ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            <span className="font-mono text-[12.5px]">{file}</span> is damaged or was edited by hand. Check it with
          </span>
          <Command text="codeloom doctor" />
        </span>
      ) : null}
      <span className="text-[12.5px] break-words text-muted-foreground">{error.message}</span>
    </div>
  );
}

/** Keeps one widget's render failure inside its own place. */
export class WidgetBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {}
  render() {
    if (this.state.error)
      return (
        <p role="alert" className="flex items-center gap-1.5 rounded-xl border border-dashed border-destructive bg-card px-5 py-4 text-[13.5px]">
          <TriangleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
          This widget could not be shown: {this.state.error.message}
        </p>
      );
    return this.props.children;
  }
}

// ---- dispatcher ---------------------------------------------------------------------------------

export function WidgetView({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "note":
      return <NoteWidget markdown={widget.markdown} />;
    case "counts":
      return <CountsWidget show={widget.show} />;
    case "journeys":
      return <JourneysWidgetView widget={widget} />;
    case "map":
      return (
        <Suspense fallback={<Loading label={`Loading the map of ${widget.repo}`} height="h-[420px]" />}>
          <MapWidget repo={widget.repo} overlay={widget.overlay} dir={widget.dir} />
        </Suspense>
      );
    case "progress":
      return <ProgressWidget by={widget.by ?? "repo"} />;
    case "checks":
      return <ChecksWidget limit={widget.limit ?? 8} />;
    case "specCoverage":
      return <SpecCoverageWidget by={widget.by ?? "repo"} />;
    default:
      return <EmptyCard>This dashboard does not know the widget type "{String((widget as { type?: unknown }).type)}". Update codeloom.</EmptyCard>;
  }
}

// ---- note ---------------------------------------------------------------------------------------

function NoteWidget({ markdown }: { markdown: string }) {
  return <NoteMarkdown text={markdown} className="max-w-[70ch] text-[14px] leading-[1.55] text-pretty" />;
}

// ---- counts -------------------------------------------------------------------------------------

function CountsWidget({ show }: { show: Extract<Widget, { type: "counts" }>["show"] }) {
  const overview = useOverview();
  const needProgress = !!show?.includes("understood");
  const needSpecs = !!show?.includes("specLinked");
  const progress = useProgress();
  const specs = useSpecs();
  if (overview.error) return <WidgetError error={overview.error} what="The totals" file=".codeloom" />;
  if (!overview.data) return <Loading label="Loading the totals" height="h-16" />;
  const understood = progress.data ? stripCounts(progress.data.totals.all).understood : undefined;
  const cells = countCells(overview.data, show, {
    ...(needProgress && understood !== undefined ? { understood } : {}),
    ...(needSpecs && specs.data ? { specLinked: specs.data.totals.all.linked } : {}),
  });
  return (
    <ul
      aria-label="Totals"
      data-slot="count-strip"
      className="grid border-t-2 border-b border-t-foreground border-b-border [&>li]:border-border [&>li]:border-r [&>li:last-child]:border-r-0"
      style={{ gridTemplateColumns: `repeat(${Math.min(cells.length, 6)}, minmax(0, 1fr))` }}
    >
      {cells.map((c) => (
        <li key={c.key} className="flex flex-col gap-0.5 px-4 py-[11px]">
          <span data-slot="count-value" className="text-2xl leading-tight font-bold tracking-[-0.02em] tabular-nums">
            {c.value === undefined ? <span className="text-muted-foreground">–</span> : fmt(c.value)}
          </span>
          <span data-slot="count-caption" className="text-[12.5px] text-muted-foreground">
            {c.caption}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- journeys -----------------------------------------------------------------------------------

function JourneysWidgetView({ widget }: { widget: JourneysWidget }) {
  const journeys = useJourneys();
  const progress = useProgress();
  const specs = useSpecs();
  const levels = useMemo(() => (progress.data ? new Map(progress.data.journeys.map((v) => [v.journeyId, v])) : undefined), [progress.data]);
  const specRows = useMemo(() => (specs.data ? new Map(specs.data.journeys.map((r) => [r.journeyId, r])) : undefined), [specs.data]);
  const specStates = useMemo(() => (specRows ? new Map([...specRows].map(([id, r]) => [id, specMark(r)])) : undefined), [specRows]);
  const title = widget.title ?? "User journeys";
  const rows = useMemo(() => {
    if (!journeys.data) return [];
    const facts = { ...(levels ? { levels } : {}), ...(specStates ? { specs: specStates } : {}) };
    return sortViewJourneys(filterViewJourneys(journeys.data.journeys, widget.filter, facts), widget.sort, facts);
  }, [journeys.data, levels, specStates, widget.filter, widget.sort]);
  const limit = widget.limit ?? 200;
  const shown = rows.slice(0, limit);

  if (journeys.error) return <Frame title={title}><WidgetError error={journeys.error} what="The journeys" file=".codeloom/journeys.json" /></Frame>;
  if (!journeys.data) return <Frame title={title}><Loading label="Loading journeys" /></Frame>;
  return (
    <Frame title={title} caption={rows.length > limit ? `Showing ${fmt(limit)} of ${fmt(rows.length)}` : undefined}>
      {widget.filter?.spec && specs.error ? <SpecsError error={specs.error} /> : null}
      {shown.length === 0 ? (
        <EmptyCard>No journeys match this widget's filter.</EmptyCard>
      ) : (
        <ul aria-label={title} className={cn(PANEL, "divide-y divide-border overflow-hidden")}>
          {shown.map((r) => (
            <JourneyItem
              key={r.id}
              r={r}
              spec={specRows?.get(r.id)}
              level={levels ? (levels.get(r.id) ?? null) : undefined}
              // a widget about specs opens each journey on its Specs tab
              specsTab={!!widget.filter?.spec || widget.sort === "spec"}
            />
          ))}
        </ul>
      )}
    </Frame>
  );
}

function JourneyItem({ r, spec, level, specsTab }: { r: JourneyRow; spec?: JourneySpecRow; level?: JourneyProgressView | null; specsTab: boolean }) {
  return (
    <li>
      <Link
        to="/journeys/$id"
        params={{ id: r.id }}
        search={specsTab ? { tab: "specs" } : {}}
        className="flex flex-col gap-2 px-5 py-3 transition-colors outline-none hover:bg-muted/50 focus-visible:bg-accent-soft focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,1fr)_120px] md:items-center md:gap-4.5"
      >
        <span className="flex min-w-0 flex-col">
          <b className="text-[15px] leading-snug font-bold">{r.name}</b>
          <small className="truncate text-[12.5px] text-muted-foreground">{r.area || "No area"}</small>
        </span>
        <LaneCounts stops={r.stops} />
        {/* the badge only once the state is known: never a placeholder */}
        <span>{spec ? <SpecBadge state={spec.state} checked={spec.checked} /> : null}</span>
        {level !== undefined ? <LevelStrip level={level ? displayLevel(level) : "none"} changed={level?.needsReWalk.length ?? 0} /> : <span />}
      </Link>
    </li>
  );
}

// ---- progress -----------------------------------------------------------------------------------

function ProgressWidget({ by }: { by: "repo" | "area" }) {
  const { data, error } = useProgress();
  const title = by === "repo" ? "Progress by repo" : "Progress by area";
  if (error) return <Frame title={title}><WidgetError error={error} what="Your progress" file="your progress file" /></Frame>;
  if (!data) return <Frame title={title}><Loading label="Loading your progress" /></Frame>;
  const all = stripCounts(data.totals.all);
  const caption = `You understand ${fmt(all.understood)} of ${plural(data.totals.all.total, "journey")}`;
  if (by === "repo") {
    const rows = repoRows(data);
    const scale = Math.max(0, ...rows.map((r) => r.counts.total));
    const th = "px-5 py-2 text-left text-xs font-semibold text-muted-foreground";
    const td = "px-5 py-3 align-middle";
    return (
      <Frame title={title} caption={caption}>
        <div className={cn(PANEL, "overflow-x-auto")}>
          <table aria-label="Progress by repo" className="w-full min-w-[480px] border-collapse text-[13.5px]">
            <thead className="border-b border-border bg-muted/40">
              <tr>
                <th scope="col" className={cn(th, "w-[170px]")}>Repo</th>
                <th scope="col" className={th}>Journeys, on one scale</th>
                <th scope="col" className={cn(th, "w-[110px]")}>Understood</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.repo}>
                  <td className={cn(td, "font-mono text-[12.5px] font-semibold")}>{r.repo}</td>
                  <td className={td}>
                    <ProgressStrip counts={stripCounts(r.counts)} scale={scale} />
                  </td>
                  <td className={cn(td, "font-semibold tabular-nums")}>
                    {fmt(r.understood)} / {fmt(r.counts.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Frame>
    );
  }
  const areas = areaRows(data);
  return (
    <Frame title={title} caption={caption}>
      {areas.length === 0 ? (
        <EmptyCard>No journeys have an area yet.</EmptyCard>
      ) : (
        <ul
          aria-label="Progress by area"
          className="grid grid-cols-2 border-t-2 border-t-foreground sm:grid-cols-3 xl:grid-cols-4 [&>li]:border-r [&>li]:border-b [&>li]:border-border"
        >
          {areas.map(({ area, counts }) => {
            const s = stripCounts(counts);
            return (
              <li key={area} className="flex min-w-0 flex-col gap-0.5 px-3.5 py-3">
                <b className="truncate text-[14px]" title={area || "No area"}>
                  {area || "No area"}
                </b>
                <span className="text-[12.5px] text-muted-foreground">
                  {fmt(s.understood)} of {fmt(counts.total)} understood
                </span>
                <ProgressStrip counts={s} className="mt-1.5 [&_[data-slot=progress-track]]:h-1.5" />
              </li>
            );
          })}
        </ul>
      )}
    </Frame>
  );
}

// ---- checks -------------------------------------------------------------------------------------

function ChecksWidget({ limit }: { limit: number }) {
  const { data, error } = useProgress();
  const title = "Recent checks";
  if (error) return <Frame title={title}><WidgetError error={error} what="Your progress" file="your progress file" /></Frame>;
  if (!data) return <Frame title={title}><Loading label="Loading your checks" /></Frame>;
  const rows = recentChecks(data, limit);
  return (
    <Frame title={title}>
      {rows.length === 0 ? (
        <EmptyCard>
          No checks yet. In your agent, run <code className="font-mono text-[12px] text-foreground">/mcp__codeloom__check-me</code> on a journey you toured.
        </EmptyCard>
      ) : (
        <ul aria-label="Recent checks" className={cn(PANEL, "flex flex-col divide-y divide-border px-5")}>
          {rows.map((v) => {
            const c = v.lastCheck!;
            const pass = c.verdict === "pass";
            return (
              <li key={v.journeyId} className="flex items-baseline justify-between gap-4 py-2.5">
                <Link to="/journeys/$id" params={{ id: v.journeyId }} className={cn(LINK, "min-w-0 text-[13.5px] font-semibold")}>
                  {v.name}
                </Link>
                <span data-verdict={c.verdict} className={cn("shrink-0 text-[12.5px]", pass ? "text-muted-foreground" : "font-semibold text-destructive")}>
                  {pass ? (displayLevel(v) === "re-walk" ? "Passed — needs re-walk" : "Passed") : "Not passed"} · {day(c.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Frame>
  );
}

// ---- spec coverage ------------------------------------------------------------------------------

/** Task 4's coverage table (the same one Progress shows), with the coverage sentence and the prompt that
 * checks the journeys nobody checked yet. */
function SpecCoverageWidget({ by }: { by: "repo" | "area" }) {
  const { data, error } = useSpecs();
  const title = by === "repo" ? "Spec coverage by repo" : "Spec coverage by area";
  if (error)
    return (
      <Frame title={title}>
        <SpecsError error={error} />
      </Frame>
    );
  if (!data)
    return (
      <Frame title={title}>
        <Loading label="Loading spec coverage" />
      </Frame>
    );
  const waiting = data.journeys.filter((j) => !j.checked).length;
  return (
    <Frame title={title} caption={`${coverageSentence(data.totals.all)}${data.candidatesIndexed ? "." : ". Run codeloom index to find candidate docs and tickets."}`}>
      <SpecCoverageTable specs={data} by={by} />
      {waiting > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
          To check every journey not checked yet, ask Claude: <Command text={MATCH_SPECS} />
        </p>
      ) : null}
    </Frame>
  );
}

