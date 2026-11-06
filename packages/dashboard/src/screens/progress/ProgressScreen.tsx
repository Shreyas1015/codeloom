import { Link } from "@tanstack/react-router";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { MapStateError } from "@/api/client";
import { useProgress, useTour } from "@/api/queries";
import type { JourneyProgressView, ProgressResponse } from "@/api/types";
import { Command } from "@/components/gallery/CopyCommand";
import { ProgressLegend, ProgressStrip } from "@/components/gallery/ProgressStrip";
import { ScreenError } from "@/components/shell/StateBanner";
import { Breakable } from "@/lib/breakable";
import { displayLevel, LEVEL_WORD, nextTourStop, stripCounts } from "@/lib/progress";
import { cn } from "@/lib/utils";
import { AgentHint } from "@/screens/home/parts";
import { parseKey } from "@/screens/tour/model";
import { areaRows, nextSuggested, recentChecks, repoRows, reWalks, whatsLeft } from "./model";

export const WRITE_TOUR = "/mcp__codeloom__write-tour";

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const H2 = "text-xl font-bold tracking-[-0.02em]";
const PANEL = "rounded-xl border border-border bg-card";
const LINK =
  "rounded-sm underline-offset-3 outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring";

function Skeleton() {
  const bar = "rounded-md bg-muted motion-safe:animate-pulse";
  return (
    <div data-testid="progress-loading" aria-busy="true" aria-label="Loading your progress" className="flex flex-col gap-5">
      <div className={`${bar} h-10 w-2/3`} />
      <div className={`${bar} h-48`} />
      <div className={`${bar} h-24`} />
    </div>
  );
}

/** A corrupt progress file is the viewer's own file: say so and how to check it, without blocking the map. */
function ProgressError({ error }: { error: Error }) {
  if (!(error instanceof MapStateError && error.code === "bad-data")) return <ScreenError error={error} fallback="Something went wrong loading your progress." />;
  return (
    <section role="alert" aria-labelledby="progress-bad" className="flex max-w-[64ch] flex-col items-start gap-3 py-2">
      <h2 id="progress-bad" className={H2}>
        Your progress file can't be read
      </h2>
      <p className="text-[13.5px] text-muted-foreground">
        codeloom leaves it as it is, so nothing you earned is lost. Check it with:
      </p>
      <div className="flex items-center rounded-xl border border-border bg-card py-2 pr-2 pl-3">
        <span aria-hidden className="mr-2 font-mono text-[12.5px] text-muted-foreground select-none">
          $
        </span>
        <Command text="codeloom doctor" />
      </div>
      <p className="max-w-full rounded-lg bg-muted px-3 py-2 text-[12.5px] break-words text-muted-foreground">
        <span className="font-semibold text-foreground">codeloom said: </span>
        {error.message}
      </p>
    </section>
  );
}

/** Progress (`/progress`): how much of the workspace you understand, per repo and area, what has gone
 * stale since, your recent checks and what is left. */
export function ProgressScreen() {
  const { data, error } = useProgress();
  return (
    <section data-testid="screen-progress" aria-labelledby="progress-title" className="flex flex-col gap-5.5">
      {error ? (
        <>
          <h1 id="progress-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em]">
            Progress
          </h1>
          <ProgressError error={error} />
        </>
      ) : !data ? (
        <>
          <h1 id="progress-title" className="sr-only">
            Progress
          </h1>
          <Skeleton />
        </>
      ) : data.totals.all.total === 0 ? (
        <Empty />
      ) : (
        <Body p={data} />
      )}
    </section>
  );
}

function Empty() {
  return (
    <div className="flex max-w-[70ch] flex-col items-start gap-3">
      <h1 id="progress-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
        No journeys to understand yet
      </h1>
      <p className="text-[13.5px] text-muted-foreground">
        Progress counts the user journeys you have opened, toured and passed a check on. Name the journeys first.
      </p>
      <AgentHint />
    </div>
  );
}

function Body({ p }: { p: ProgressResponse }) {
  const all = stripCounts(p.totals.all);
  const left = p.totals.all.total - all.understood;
  const reposLeft = repoRows(p).filter((r) => r.left > 0).length;
  const next = nextSuggested(p);
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 id="progress-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
            You understand {fmt(all.understood)} of {plural(p.totals.all.total, "journey")}
          </h1>
          <p className="max-w-[70ch] text-[13.5px] text-muted-foreground">
            Understood means you passed the journey's check in Claude. {plural(left, "journey")} left
            {reposLeft > 0 ? ` across ${plural(reposLeft, "repo")}` : ""}.
          </p>
          <p className="text-[12.5px] text-muted-foreground">
            Kept on this computer only: <span className="font-mono text-[11.5px] break-all">{p.path}</span>
          </p>
        </div>
        <ProgressLegend />
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <div className="flex min-w-0 flex-col gap-5.5">
          <RepoTable p={p} />
          <Areas p={p} />
          <WhatsLeft p={p} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ReWalkPanel p={p} />
          <RecentChecks p={p} />
          {next ? (
            <Link
              to="/journeys/$id"
              params={{ id: next.journeyId }}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors outline-offset-2 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring motion-reduce:transition-none"
            >
              Next suggested: {next.name}
              <ArrowRight aria-hidden className="size-4 shrink-0" />
            </Link>
          ) : null}
          <OlderJourneys ids={p.olderJourneys} />
        </div>
      </div>
    </>
  );
}

function RepoTable({ p }: { p: ProgressResponse }) {
  const rows = repoRows(p);
  const scale = Math.max(0, ...rows.map((r) => r.counts.total));
  const th = "px-5 py-2 text-left text-xs font-semibold text-muted-foreground";
  const td = "px-5 py-3 align-middle";
  return (
    <div className={cn(PANEL, "overflow-x-auto")}>
      <table aria-label="Progress by repo" className="w-full min-w-[560px] border-collapse text-[13.5px]">
        <thead className="border-b border-border bg-muted/40">
          <tr>
            <th scope="col" className={cn(th, "w-[170px]")}>
              Repo
            </th>
            <th scope="col" className={th}>
              Journeys, on one scale
            </th>
            <th scope="col" className={cn(th, "w-[90px]")}>
              Understood
            </th>
            <th scope="col" className={cn(th, "w-[90px]")}>
              Toured
            </th>
            <th scope="col" className={cn(th, "w-[110px]")}>
              Left
            </th>
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
              <td className={cn(td, "tabular-nums")}>
                {fmt(r.touredOrMore)} / {fmt(r.counts.total)}
              </td>
              <td className={cn(td, r.counts.total === 0 && "text-muted-foreground")}>{r.counts.total === 0 ? "No journeys" : plural(r.left, "journey")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Areas({ p }: { p: ProgressResponse }) {
  const areas = areaRows(p);
  if (areas.length === 0) return null;
  return (
    <section aria-labelledby="progress-areas" className="flex flex-col gap-2.5">
      <h2 id="progress-areas" className={H2}>
        By area
      </h2>
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
    </section>
  );
}

function WhatsLeft({ p }: { p: ProgressResponse }) {
  const groups = whatsLeft(p);
  return (
    <section aria-labelledby="progress-left" className="flex flex-col gap-2.5">
      <h2 id="progress-left" className={H2}>
        What's left
      </h2>
      {groups.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">Nothing: you understand every journey.</p>
      ) : (
        <div className={cn(PANEL, "divide-y divide-border")}>
          {groups.map(({ area, journeys }) => (
            <div key={area} className="flex flex-col gap-1.5 px-5 py-3.5">
              <h3 className="text-xs font-semibold text-muted-foreground">{area || "No area"}</h3>
              <ul aria-label={area || "No area"} className="flex flex-col">
                {journeys.map((v) => (
                  <li key={v.journeyId} className="flex items-baseline justify-between gap-4 py-1">
                    <Link to="/journeys/$id" params={{ id: v.journeyId }} className={cn(LINK, "min-w-0 text-[14px] font-semibold")}>
                      {v.name}
                    </Link>
                    <span className="shrink-0 text-[12.5px] text-muted-foreground">{LEVEL_WORD[displayLevel(v)]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReWalkPanel({ p }: { p: ProgressResponse }) {
  const rows = reWalks(p);
  return (
    <section aria-labelledby="progress-rewalk" className={cn(PANEL, "flex flex-col gap-2.5 px-4.5 py-4")}>
      <h2 id="progress-rewalk" className={H2}>
        Needs a re-walk
      </h2>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing has changed under the journeys you understand.</p>
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">
            Code changed under journeys you understood. They count again once you re-walk the changed stops and pass the check.
          </p>
          <ul className="flex flex-col gap-2.5">
            {rows.map((v) => (
              <ReWalkRow key={v.journeyId} v={v} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** One stale journey: its changed stops, each linked to that stop in Tour mode (to the journey when it has
 * no tour), and a Re-walk link to the first of them. */
function ReWalkRow({ v }: { v: JourneyProgressView }) {
  const { data } = useTour(v.journeyId);
  const tour = data?.tour;
  const first = nextTourStop(tour, v, undefined);
  const stopNo = (key: string) => {
    const i = tour ? tour.stops.findIndex((s) => s.key === key) : -1;
    return i < 0 ? undefined : i + 1;
  };
  return (
    <li className="flex flex-col gap-2 rounded-[9px] border border-dashed border-ring bg-accent-soft px-3 py-2.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <b className="block text-[14px]">{v.name}</b>
          <small className="flex items-center gap-1 text-[12.5px] text-accent-foreground">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {plural(v.needsReWalk.length, "stop")} changed
          </small>
        </div>
        {first ? (
          <Link
            to="/journeys/$id/tour"
            params={{ id: v.journeyId }}
            search={{ phase: first.phase, stop: first.stop }}
            aria-label={`Re-walk ${v.name}`}
            className={REWALK}
          >
            Re-walk
          </Link>
        ) : (
          <Link to="/journeys/$id" params={{ id: v.journeyId }} aria-label={`Re-walk ${v.name}`} className={REWALK}>
            Re-walk
          </Link>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {v.needsReWalk.map((key) => {
          const f = parseKey(key);
          const n = stopNo(key);
          const text = (
            <>
              <span className="block text-[13px] font-semibold">{f?.symbol || f?.file || "A stop"}</span>
              {f ? <span className="block font-mono text-[11.5px] text-muted-foreground"><Breakable text={`${f.file}:${f.line}`} /></span> : null}
            </>
          );
          return (
            <li key={key}>
              {n !== undefined ? (
                <Link
                  to="/journeys/$id/tour"
                  params={{ id: v.journeyId }}
                  search={{ phase: "flow", stop: n }}
                  className={cn(LINK, "block")}
                  title={f ? `${f.repo}/${f.file}:${f.line}` : undefined}
                >
                  {text}
                </Link>
              ) : (
                <div title={f ? `${f.repo}/${f.file}:${f.line}` : undefined}>{text}</div>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

const REWALK =
  "ml-auto inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-[12.5px] font-semibold text-primary-foreground transition-colors outline-offset-2 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring motion-reduce:transition-none";

function RecentChecks({ p }: { p: ProgressResponse }) {
  const rows = recentChecks(p);
  return (
    <section aria-labelledby="progress-checks" className={cn(PANEL, "flex flex-col gap-1.5 px-4.5 pt-4 pb-3")}>
      <h2 id="progress-checks" className={H2}>
        Recent checks
      </h2>
      {rows.length === 0 ? (
        <p className="pb-1 text-[13px] text-muted-foreground">
          No checks yet. In your agent, run <code className="font-mono text-[12px]">/mcp__codeloom__check-me</code> on a journey you toured.
        </p>
      ) : (
        <ul aria-label="Recent checks" className="flex flex-col divide-y divide-border">
          {rows.map((v) => {
            const c = v.lastCheck!;
            const pass = c.verdict === "pass";
            return (
              <li key={v.journeyId} className="flex items-baseline justify-between gap-4 py-2">
                <Link to="/journeys/$id" params={{ id: v.journeyId }} className={cn(LINK, "min-w-0 text-[13.5px] font-semibold")}>
                  {v.name}
                </Link>
                <span data-verdict={c.verdict} className={cn("shrink-0 text-[12.5px]", pass ? "text-muted-foreground" : "font-semibold text-destructive")}>
                  {pass ? "Passed" : "Not passed"} · {day(c.at)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OlderJourneys({ ids }: { ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <section aria-labelledby="progress-older" className={cn(PANEL, "flex flex-col gap-2 px-4.5 py-4")}>
      <h2 id="progress-older" className="text-[15px] font-bold">
        For older journeys
      </h2>
      <p className="text-[13px] text-muted-foreground">
        These journeys were renamed, merged or split. Your progress on them is kept. To tour the new journey, ask your agent:
      </p>
      <Command text={WRITE_TOUR} />
      <ul className="flex flex-col gap-0.5 font-mono text-[11.5px] text-muted-foreground">
        {ids.map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
    </section>
  );
}

