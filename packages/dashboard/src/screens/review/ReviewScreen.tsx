import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useOverview, useReview } from "@/api/queries";
import { getSnapshot } from "@/api/static";
import type { Review, ReviewJourney, ReviewNodeChange, ReviewStop, SpecState } from "@/api/types";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { stopLabel } from "@/components/gallery/StopRoundel";
import { ScreenError } from "@/components/shell/StateBanner";
import { cn } from "@/lib/utils";
import { ReviewCodePanel, type ReviewLaneStop, StopNum } from "./ReviewCodePanel";

const LANE_ORDER = ["ui", "api", "code", "db", "queue"] as const;
const LANE_NAME: Record<string, string> = { ui: "UI", api: "API", code: "Code", db: "DB", queue: "Queue" };

const fmt = new Intl.NumberFormat("en-US");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Own-key lookup only: chain ids come from review.json (a PR's own data), and one named like an
 * inherited Object.prototype property ("toString") must never resolve to that inherited function. */
const own = <T,>(record: Record<string, T>, key: string): T | undefined => (Object.hasOwn(record, key) ? record[key] : undefined);

/** The stops of `chains` (a journey's touched chains, or one chain), deduped by ref and numbered 1..N in
 * lane order (UI, API, Code, DB, Queue) — the same board shape the approved mockup draws, just assembled
 * from `Review.chainStops` instead of a live journey's own stop list. */
function rowStops(review: Review, chains: readonly string[]): ReviewLaneStop[] {
  const byRef = new Map<string, ReviewStop>();
  for (const chainId of chains) {
    for (const s of own(review.chainStops, chainId) ?? []) {
      if (!byRef.has(s.ref)) byRef.set(s.ref, s);
    }
  }
  const ordered = LANE_ORDER.flatMap((lane) => [...byRef.values()].filter((s) => s.lane === lane));
  return ordered.map((s, i) => ({ ...s, n: i + 1 }));
}

/** One selectable row on Review: an affected journey, or — when no journey is named for any of them
 * (final review I4) — an affected chain standing in for one. Either way it opens on `/journeys/$id`
 * (the Journey screen takes a chain id too) and lays out the same lanes and code panel. */
interface ReviewRow {
  kind: "journey" | "chain";
  id: string;
  name: string;
  chains: string[];
  changed: number;
  spec?: ReviewJourney["spec"];
}

function reviewRows(review: Review): ReviewRow[] {
  if (review.journeys.length > 0) {
    return review.journeys.map((j) => ({ kind: "journey", id: j.id, name: j.name, chains: j.chains, changed: j.changedStops.length, spec: j.spec }));
  }
  return review.chains.map((id) => {
    const name = own(review.chainNames, id);
    const changed = new Set((own(review.chainStops, id) ?? []).filter((s) => s.changed).map((s) => s.ref)).size;
    return { kind: "chain", id, name: typeof name === "string" && name !== "" ? name : id, chains: [id], changed };
  });
}

function specBadgeProps(mark: ReviewJourney["spec"]): { state: SpecState; checked: boolean } {
  if (mark === "unchecked") return { state: "none", checked: false };
  if (mark === "none") return { state: "none", checked: true };
  return { state: mark, checked: true };
}

/** Review ("This PR", `/review`): the start page of a hosted snapshot — every changed file and function,
 * the journeys they touch (or, with none named, the chains), and (once a row and a stop are picked) that
 * stop's code. */
export function ReviewScreen() {
  const { data, error } = useReview();
  const overview = useOverview();
  const [rowId, setRowId] = useState<string | undefined>(undefined);
  const [stopRef, setStopRef] = useState<string | undefined>(undefined);

  const rows = useMemo(() => (data ? reviewRows(data) : []), [data]);
  useEffect(() => {
    if (rowId === undefined && rows.length > 0) setRowId(rows[0]!.id);
  }, [rows, rowId]);

  const row = rows.find((r) => r.id === rowId);
  const stops = useMemo(() => (data && row ? rowStops(data, row.chains) : []), [data, row]);
  const nodeByRef = useMemo(() => new Map((data?.nodes ?? []).map((n): [string, ReviewNodeChange] => [n.ref, n])), [data]);
  const journeyNameById = useMemo(() => new Map((data?.journeys ?? []).map((j) => [j.id, j.name])), [data]);
  const selectedStop = stops.find((s) => s.ref === stopRef);
  const repoPath = (repo: string) => overview.data?.repos.find((r) => r.id === repo)?.path;

  const selectRow = (id: string) => {
    setRowId(id);
    setStopRef(undefined);
  };

  return (
    <section data-testid="screen-review" aria-labelledby="review-title" className="flex flex-col gap-5.5">
      <h1 id="review-title" className="text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance">
        What this PR touches
      </h1>

      {error ? (
        <ScreenError error={error} fallback="Something went wrong loading this PR's review." />
      ) : !data ? (
        <p role="status" aria-busy="true" className="text-[13px] text-muted-foreground">
          Loading this PR's review…
        </p>
      ) : (
        <>
          <CountsRow review={data} />

          <RowsSection rows={rows} selectedId={row?.id} onSelect={selectRow} />

          {row && (
            <div className="grid min-h-0 grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
              <ReviewLanes stops={stops} selectedRef={selectedStop?.ref} onSelect={setStopRef} />
              {selectedStop ? (
                <ReviewCodePanel
                  key={selectedStop.ref}
                  stop={selectedStop}
                  node={nodeByRef.get(selectedStop.ref)}
                  journeyId={row.id}
                  journeyNameById={journeyNameById}
                  repoPath={repoPath(selectedStop.repo)}
                  snapshot={getSnapshot()}
                />
              ) : (
                <aside aria-label="Code panel" className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-0">
                  <p className="text-[13px] text-muted-foreground">Pick a stop to see its code.</p>
                </aside>
              )}
            </div>
          )}

          <FilesSection files={data.files} />
        </>
      )}
    </section>
  );
}

const CELLS: Array<{ key: "files" | "functions" | "journeys" | "tables" | "queues"; singular: string; pluralWord: string }> = [
  { key: "files", singular: "file changed", pluralWord: "files changed" },
  { key: "functions", singular: "function", pluralWord: "functions" },
  { key: "journeys", singular: "journey", pluralWord: "journeys" },
  { key: "tables", singular: "table", pluralWord: "tables" },
  { key: "queues", singular: "queue", pluralWord: "queues" },
];

function CountsRow({ review }: { review: Review }) {
  const counts = {
    files: review.files.length,
    functions: review.nodes.length,
    journeys: review.journeys.length,
    tables: review.tables.length,
    queues: review.queues.length,
  };
  return (
    <ul aria-label="PR totals" className="flex flex-wrap gap-2">
      {CELLS.map(({ key, singular, pluralWord }) => {
        const n = counts[key];
        return (
          <li key={key} className="flex min-w-[84px] flex-col gap-0.5 rounded-[10px] border border-border bg-card px-3 py-2">
            <span data-slot="count-value" className="text-xl leading-tight font-bold tracking-[-0.02em] tabular-nums">
              {fmt.format(n)}
            </span>
            <span data-slot="count-caption">{` ${n === 1 ? singular : pluralWord}`}</span>
          </li>
        );
      })}
    </ul>
  );
}

function RowsSection({ rows, selectedId, onSelect }: { rows: ReviewRow[]; selectedId: string | undefined; onSelect: (id: string) => void }) {
  const chains = rows.length > 0 && rows[0]!.kind === "chain";
  const title = chains ? "Chains affected" : "Journeys affected";
  return (
    <section aria-labelledby="review-journeys-title" className="flex flex-col gap-2">
      <h2 id="review-journeys-title" className="text-xl font-bold tracking-[-0.02em]">
        {title}
      </h2>
      {chains && <p className="text-[13.5px] text-muted-foreground">No journeys are named for these yet, so each chain is shown on its own.</p>}
      {rows.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No journeys or chains touched by this PR.</p>
      ) : (
        <ul aria-label={title} className="flex flex-col gap-1.5">
          {rows.map((r) => {
            const selected = r.id === selectedId;
            const badge = r.spec !== undefined ? specBadgeProps(r.spec) : undefined;
            const what = r.kind === "chain" ? "chain" : "journey";
            return (
              <li key={r.id} className="flex items-stretch gap-2">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(r.id)}
                  className={cn(
                    "flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[10px] border bg-card px-3.5 py-2.5 text-left text-[13.5px] transition-colors outline-offset-2 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                    // the same selection halo as LaneColumn's selected stop card (Elevation's Selection halo)
                    selected ? "border-accent-foreground shadow-[0_0_0_3px_rgb(227_167_47_/_0.4)]" : "border-border",
                  )}
                >
                  <b className="font-bold break-words">{r.name}</b>
                  <span className="flex items-center gap-2">
                    <span className="inline-flex w-fit items-center rounded-[4px] bg-accent-soft px-1.75 py-px text-[11.5px] font-semibold whitespace-nowrap text-accent-foreground">
                      {plural(r.changed, "stop")} changed
                    </span>
                    {badge && <SpecBadge state={badge.state} checked={badge.checked} />}
                  </span>
                </button>
                <Link
                  to="/journeys/$id"
                  params={{ id: r.id }}
                  aria-label={`Open ${what} ${r.name}`}
                  className="flex shrink-0 items-center rounded-[10px] px-2 text-[12.5px] font-semibold whitespace-nowrap text-primary underline-offset-3 outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Open {what} →
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ReviewLanes({
  stops,
  selectedRef,
  onSelect,
}: {
  stops: ReviewLaneStop[];
  selectedRef: string | undefined;
  onSelect: (ref: string) => void;
}) {
  const lanes = LANE_ORDER.map((lane) => ({ lane, items: stops.filter((s) => s.lane === lane) })).filter((g) => g.items.length > 0);
  if (lanes.length === 0) return null;
  return (
    // the approved mockup's plain white board: lanes as rows on dashed hairlines, not the Journey screen's
    // coloured per-lane washes — here ochre is reserved for "changed" alone (review-maps-constraints.md)
    <div className="min-w-0 overflow-x-auto rounded-xl border border-border bg-card p-3">
      <div className="flex flex-col">
        {lanes.map(({ lane, items }, li) => (
          <div
            key={lane}
            role="region"
            aria-label={LANE_NAME[lane]}
            data-lane={lane}
            className={cn("flex flex-wrap items-center gap-2.5 py-2.5", li > 0 && "border-t border-dashed border-border")}
          >
            <h3 className="w-12 flex-none text-[12.5px] font-bold text-muted-foreground uppercase">{LANE_NAME[lane]}</h3>
            <div className="flex flex-wrap items-center gap-2">
              {items.map((s, i) => (
                <div key={s.ref} className="flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden className="text-muted-foreground">
                      →
                    </span>
                  )}
                  <button
                    type="button"
                    data-changed={s.changed ? "true" : "false"}
                    aria-label={stopLabel(s.n, s.label)}
                    aria-pressed={s.ref === selectedRef}
                    onClick={() => onSelect(s.ref)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] transition-colors outline-offset-2 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-ring",
                      s.changed ? "border-2 border-accent bg-accent-soft font-semibold" : "border-border",
                      s.ref === selectedRef && "shadow-[0_0_0_3px_rgb(227_167_47_/_0.4)]",
                    )}
                  >
                    <StopNum n={s.n} changed={s.changed} size="sm" />
                    {s.changed ? `✏️ ${s.label}` : s.label}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesSection({ files }: { files: Review["files"] }) {
  return (
    <section aria-labelledby="review-files-title" className="flex flex-col gap-2">
      <h2 id="review-files-title" className="text-xl font-bold tracking-[-0.02em]">
        Files changed
      </h2>
      {files.length === 0 ? (
        <p className="text-[13.5px] text-muted-foreground">No files changed.</p>
      ) : (
        <ul aria-label="Files changed" className="flex flex-wrap gap-2 font-mono text-xs">
          {files.map((f) => (
            <li key={`${f.repo}:${f.file}`} className="rounded-[7px] border border-border bg-card px-2 py-1">
              {f.file}
              {f.added > 0 && <span className="text-success"> +{f.added}</span>}
              {f.removed > 0 && <span className="text-destructive"> −{f.removed}</span>}
              {!f.onChain && <span className="text-muted-foreground"> · not on any mapped chain</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
