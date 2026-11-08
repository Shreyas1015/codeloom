import { Link } from "@tanstack/react-router";
import { Search, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { JourneyProgressView, JourneyRow, JourneySpecRow, ProgressResponse, SpecsResponse } from "@/api/types";
import { LevelStrip } from "@/components/gallery/ProgressStrip";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { displayLevel } from "@/lib/progress";
import { SPEC_MARKS, SPEC_SHORT, type SpecMark, specMark } from "@/lib/specs";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { type CompleteFilter, facets, filterJourneys, type JourneyFilter, NO_FILTER, type SortKey, sortJourneys } from "./filter";
import { CompleteMark, ConfidenceMark, LaneCounts, ShowMore, useLimit } from "./parts";

const COLS = "md:grid md:grid-cols-[minmax(0,2.3fr)_minmax(0,.9fr)_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,.9fr)] md:gap-4.5";
/** With your progress: a sixth column for it. */
const COLS_PROGRESS =
  "md:grid md:grid-cols-[minmax(0,2.3fr)_minmax(0,.9fr)_minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,.9fr)_120px] md:gap-4.5";

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
}

/** j / k move focus through the rows (Enter opens the focused one: rows are links). Ignored while typing. */
function useRowKeys(list: React.RefObject<HTMLUListElement | null>) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key !== "j" && e.key !== "k") || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const rows = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>("a[data-row]") ?? []);
      if (rows.length === 0) return;
      e.preventDefault();
      const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
      const next = at < 0 ? 0 : e.key === "j" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
      const el = rows[next]!;
      el.focus();
      el.scrollIntoView?.({ block: "nearest" });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [list]);
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = `home-${label.toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">
        {label}
      </label>
      {children(id)}
    </div>
  );
}

const SELECT =
  "h-9 rounded-md border border-input bg-card px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring";

function Select({ id, value, onChange, options }: { id: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}

function Row({ r, level, spec }: { r: JourneyRow; level?: JourneyProgressView | null; spec?: JourneySpecRow }) {
  const orphaned = r.status === "orphaned";
  return (
    <li>
      <Link
        to="/journeys/$id"
        params={{ id: r.id }}
        data-row
        data-name={r.name}
        className={cn(
          "flex flex-col gap-2 px-5 py-3 transition-colors outline-none hover:bg-muted/50 focus-visible:bg-accent-soft focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring md:items-center",
          level === undefined ? COLS : COLS_PROGRESS,
        )}
      >
        <span className="flex min-w-0 flex-col">
          <b className="flex flex-wrap items-center gap-x-2 text-[15px] leading-snug font-bold">
            {r.name}
            {orphaned && (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive-soft px-2 py-px text-[11.5px] font-semibold text-destructive">
                <TriangleAlert aria-hidden className="size-3" />
                Orphaned
              </span>
            )}
            {spec && <SpecBadge state={spec.state} checked={spec.checked} title={specTitle(spec)} />}
          </b>
          {r.note && <small className="truncate text-[12.5px] text-muted-foreground">{r.note}</small>}
          {r.external?.length ? (
            <small className="truncate text-[12.5px] text-muted-foreground" title="Other services its pages call">
              calls {r.external.join(", ")}
            </small>
          ) : null}
        </span>
        <span className="text-[13.5px]">{r.area || <span className="text-muted-foreground">No area</span>}</span>
        <LaneCounts stops={r.stops} />
        <span className="truncate font-mono text-xs text-muted-foreground">{r.repos.join(", ")}</span>
        <span className="flex flex-col items-start gap-0.5">
          <ConfidenceMark confidence={r.confidence} />
          <CompleteMark complete={r.complete} apiOnly={r.apiOnly} />
        </span>
        {level !== undefined && (
          <LevelStrip level={level ? displayLevel(level) : "none"} changed={level?.needsReWalk.length ?? 0} />
        )}
      </Link>
    </li>
  );
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What a badge's tooltip adds: how many links, or how many candidates wait. */
function specTitle(s: JourneySpecRow): string | undefined {
  if (s.state === "linked") return count(s.links.length, "linked spec");
  if (s.state === "candidates") return `${count(s.candidates.docs, "candidate doc")}, ${count(s.candidates.tickets, "candidate ticket")}`;
  return undefined;
}

/** The journey list as wall labels, with search, filters, sort, j/k and "Show more". `specs` (optional, like
 * progress) adds each journey's spec badge and the Spec filter. */
export function JourneyList({ rows, progress, specs }: { rows: JourneyRow[]; progress?: ProgressResponse; specs?: SpecsResponse }) {
  const levels = useMemo(() => (progress ? new Map(progress.journeys.map((v) => [v.journeyId, v])) : undefined), [progress]);
  const specRows = useMemo(() => (specs ? new Map(specs.journeys.map((s) => [s.journeyId, s])) : undefined), [specs]);
  const marks = useMemo(
    () => (specRows ? new Map([...specRows].map(([id, s]): [string, SpecMark] => [id, specMark(s)])) : undefined),
    [specRows],
  );
  const [f, setF] = useState<JourneyFilter>(NO_FILTER);
  const [sort, setSort] = useState<SortKey>("name");
  const list = useRef<HTMLUListElement>(null);
  useRowKeys(list);

  const { areas, repos } = useMemo(() => facets(rows), [rows]);
  // A live update can remove the area or repo a menu is set to: fall back to "All" rather than keep
  // filtering by a value the menu no longer lists.
  const stale = (f.area !== "" && !areas.includes(f.area)) || (f.repo !== "" && !repos.includes(f.repo));
  // Setting state during render is React's "adjust state when a prop changes" (derived state) pattern.
  if (stale) setF({ ...f, area: areas.includes(f.area) ? f.area : "", repo: repos.includes(f.repo) ? f.repo : "" });
  const shown = useMemo(() => sortJourneys(filterJourneys(rows, f, marks), sort), [rows, f, marks, sort]);
  const [limit, more] = useLimit(JSON.stringify([f, sort]));
  const set = <K extends keyof JourneyFilter>(k: K) => (v: string) => setF((p) => ({ ...p, [k]: v as JourneyFilter[K] }));

  return (
    <section aria-labelledby="home-journeys" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <h2 id="home-journeys" className="mr-auto self-center text-xl font-bold tracking-[-0.02em]">
          User journeys <span className="font-mono text-sm font-semibold text-muted-foreground tabular">{rows.length}</span>
        </h2>
        <div className="relative w-full sm:w-64">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search journeys"
            placeholder="Search names, areas, notes, tables"
            value={f.q}
            onChange={(e) => set("q")(e.target.value)}
            className="bg-card pl-8"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Area">
          {(id) => <Select id={id} value={f.area} onChange={set("area")} options={[["", "All areas"], ...areas.map((a): [string, string] => [a, a])]} />}
        </Field>
        <Field label="Repo">
          {(id) => <Select id={id} value={f.repo} onChange={set("repo")} options={[["", "All repos"], ...repos.map((r): [string, string] => [r, r])]} />}
        </Field>
        <Field label="Confidence">
          {(id) => (
            <Select
              id={id}
              value={f.confidence}
              onChange={set("confidence")}
              options={[
                ["", "Any"],
                ["exact", "Exact"],
                ["param", "Param"],
                ["guess", "Guess"],
              ]}
            />
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select
              id={id}
              value={f.complete}
              onChange={(v) => set("complete")(v as CompleteFilter)}
              options={[
                ["", "Any"],
                ["complete", "Complete"],
                ["api-only", "API → DB"],
                ["incomplete", "Incomplete"],
              ]}
            />
          )}
        </Field>
        {marks && (
          <Field label="Spec">
            {(id) => (
              <Select
                id={id}
                value={f.spec}
                onChange={set("spec")}
                options={[["", "Any"], ...SPEC_MARKS.map((m): [string, string] => [m, SPEC_SHORT[m]])]}
              />
            )}
          </Field>
        )}
        <div className="ml-auto">
          <Field label="Sort">
            {(id) => (
              <Select
                id={id}
                value={sort}
                onChange={(v) => setSort(v as SortKey)}
                options={[
                  ["name", "Name"],
                  ["area", "Area"],
                  ["stops", "Most stops"],
                  ["confidence", "Surest first"],
                ]}
              />
            )}
          </Field>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div aria-hidden className={cn("hidden border-b border-border bg-muted/40 px-5 py-2 text-xs font-semibold text-muted-foreground", levels ? COLS_PROGRESS : COLS)}>
          <span>Journey</span>
          <span>Area</span>
          {/* the lane words in their roundel hues: the header doubles as the legend */}
          <span>
            Stops · <span className="text-lane-ui">UI</span> · <span className="text-lane-api">API</span> · <span className="text-lane-code">Code</span> ·{" "}
            <span className="text-lane-db">DB</span> · <span className="text-lane-db">Queue</span>
          </span>
          <span>Repos</span>
          <span>Confidence</span>
          {levels && <span>Your progress</span>}
        </div>
        {shown.length === 0 ? (
          <p className="px-5 py-6 text-[13.5px] text-muted-foreground">No journeys match these filters.</p>
        ) : (
          <ul ref={list} aria-label="User journeys" className="divide-y divide-border">
            {shown.slice(0, limit).map((r) => (
              <Row key={r.id} r={r} level={levels ? (levels.get(r.id) ?? null) : undefined} spec={specRows?.get(r.id)} />
            ))}
          </ul>
        )}
        <ShowMore shown={Math.min(limit, shown.length)} total={shown.length} onMore={more} />
      </div>
      <p className="text-xs text-muted-foreground">
        Press <kbd className="font-mono">j</kbd> / <kbd className="font-mono">k</kbd> to move through journeys, <kbd className="font-mono">Enter</kbd> to open one.
      </p>
    </section>
  );
}
