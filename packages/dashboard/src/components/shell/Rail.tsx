import { Link, useRouterState } from "@tanstack/react-router";
import { ChartNoAxesColumn, GitPullRequest, House, LayoutDashboard, Map as MapIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { isSnapshot } from "@/api/static";
import type { Overview, RepoRole, ViewSummary } from "@/api/types";
import { cn } from "@/lib/utils";

const fmt = (n: number) => n.toLocaleString("en-US");

/** The codeloom mark: three warp threads crossed by a stepped weft. */
function LoomMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v18M12 3v18M18 3v18" strokeWidth={1.6} />
      <path d="M3 8h6M9 12h6M15 16h6" strokeWidth={2.4} />
    </svg>
  );
}

const DOT: Record<RepoRole, string> = {
  ui: "bg-rail-dot-ui",
  api: "bg-rail-dot-api",
  worker: "bg-rail-dot-worker",
  lib: "bg-rail-dot-lib",
};

function NavItem({
  to,
  icon,
  label,
  count,
  countLabel,
  current,
}: {
  to: "/" | "/map" | "/progress" | "/review";
  icon: ReactNode;
  label: string;
  /** A number (grouped) or ready text such as "34%". */
  count?: number | string;
  countLabel?: string;
  current: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-rail-foreground transition-colors hover:bg-rail-active/60 hover:text-rail-strong focus-visible:outline-rail-ring",
        current && "bg-rail-active font-semibold text-rail-strong hover:bg-rail-active",
      )}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span className={cn("ml-auto font-mono text-xs tabular", current ? "text-rail-strong" : "text-rail-muted")}>
          {typeof count === "number" ? fmt(count) : count}
          <span className="sr-only"> {countLabel}</span>
        </span>
      )}
    </Link>
  );
}

/** The painted gallery wall: brand, workspace, nav with counts, repo list, live-updates and agent status. */
export function Rail({
  overview,
  failed = false,
  livePaused = false,
  understood,
  views,
}: {
  overview: Overview | undefined;
  failed?: boolean;
  livePaused?: boolean;
  /** Understood journeys as a whole percent (Progress's count); left out until progress loads. */
  understood?: number;
  /** The saved views (GET /api/views); the section is left out while there are none. */
  views?: ViewSummary[];
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const onMap = under("/map");
  const onProgress = under("/progress");
  const onViews = under("/views");
  const onReview = under("/review");
  // Tour mode is a journey, not Home: no rail item is current there
  const onTour = /^\/journeys\/[^/]+\/tour\/?$/.test(pathname);
  const files = overview?.repos.reduce((s, r) => s + r.files, 0);
  const repoCount = overview?.repos.length ?? 0;
  const iconCls = "size-[17px] shrink-0";

  return (
    <aside aria-label="codeloom" className="flex w-58 shrink-0 flex-col gap-6 overflow-y-auto bg-rail px-4 pt-6 pb-4.5 text-rail-foreground [scrollbar-color:var(--rail-border)_transparent]">
      <div className="flex items-center gap-2.5 px-1.5">
        <LoomMark className="size-5.5 text-accent" />
        <span className="text-[21px] leading-none font-bold tracking-[-0.02em] text-rail-strong">codeloom</span>
      </div>

      {/* while loading the card holds its place; when the overview cannot load (not indexed) it is left out,
          not drawn as an empty frame */}
      {failed && !overview ? null : (
        <div className="min-h-[54px] rounded-[9px] border border-rail-border px-3 py-2" aria-busy={!overview}>
          {overview && (
            <>
              <div className="truncate font-semibold text-rail-strong" title={overview.name}>
                {overview.name}
              </div>
              <div className="text-xs text-rail-muted">
                workspace · {repoCount} {repoCount === 1 ? "repo" : "repos"}
              </div>
            </>
          )}
        </div>
      )}

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {/* a hosted PR snapshot's own start page (spec §7): first in the rail, as both approved mockups
            show, current only there — so Home below is never lit up while you're on it */}
        {isSnapshot() && (
          <NavItem to="/review" icon={<GitPullRequest className={iconCls} strokeWidth={1.6} />} label="This PR" current={onReview} />
        )}
        <NavItem
          to="/"
          icon={<House className={iconCls} strokeWidth={1.6} />}
          label="Home"
          count={overview?.journeys.total}
          countLabel="journeys"
          current={!onMap && !onProgress && !onTour && !onViews && !onReview}
        />
        <NavItem to="/map" icon={<MapIcon className={iconCls} strokeWidth={1.6} />} label="Map" count={files} countLabel="files" current={onMap} />
        {/* A snapshot never has progress (review-maps-constraints.md): no nav item to a screen with nothing to show. */}
        {!isSnapshot() && (
          <NavItem
            to="/progress"
            icon={<ChartNoAxesColumn className={iconCls} strokeWidth={1.6} />}
            label="Progress"
            count={understood === undefined ? undefined : `${understood}%`}
            countLabel="understood"
            current={onProgress}
          />
        )}
      </nav>

      {views && views.length > 0 && <ViewsList views={views} pathname={pathname} />}

      {overview && overview.repos.length > 0 && (
        <div>
          <h2 id="rail-repos" className="px-2.5 pb-1.5 text-xs font-semibold text-rail-muted">
            Repos
          </h2>
          <ul aria-labelledby="rail-repos" className="flex flex-col gap-px">
            {overview.repos.map((r) => (
              <li key={r.id}>
                <Link
                  to="/map"
                  search={{ repo: r.id }}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors hover:bg-rail-active/60 hover:text-rail-strong focus-visible:outline-rail-ring"
                >
                  <i aria-hidden="true" className={cn("size-2 shrink-0 rounded-[2px]", r.role ? DOT[r.role] : DOT.lib)} />
                  <span className="truncate">{r.id}</span>
                  <span className="ml-auto font-mono text-xs text-rail-muted tabular">
                    {fmt(r.files)}
                    <span className="sr-only"> files</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2">
        {/* A polite live region that is always there, so screen readers hear the chip appear. */}
        <div role="status">
          {livePaused && (
            <div className="flex items-center gap-2 px-3 text-xs text-rail-muted" title="Lost the connection to codeloom dashboard. Reconnecting…">
              <i aria-hidden="true" className="size-1.5 shrink-0 rounded-full border border-rail-muted" />
              Live updates paused
            </div>
          )}
        </div>
        {overview && (
          <div className="flex items-center gap-2 rounded-[9px] bg-rail-deep px-3 py-2.5 text-[12.5px]">
            <i aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", overview.mcpConnected ? "bg-rail-dot-api" : "border border-rail-muted")} />
            <div>
              <div className="text-rail-strong">{overview.mcpConnected ? "MCP set up" : "MCP not set up"}</div>
              <div className="text-rail-muted">
                {overview.mcpConnected ? (
                  <>
                    codeloom in <code className="text-[11.5px]">.mcp.json</code>
                  </>
                ) : (
                  <>
                    Run <code className="text-[11.5px]">codeloom init</code>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** The views your agent saved, by id. A view whose file cannot be read stays listed, marked, and opens its
 * error card. The `home` view lives at `/`, so it links there. */
function ViewsList({ views, pathname }: { views: ViewSummary[]; pathname: string }) {
  return (
    <div>
      <h2 id="rail-views" className="px-2.5 pb-1.5 text-xs font-semibold text-rail-muted">
        Views
      </h2>
      <ul aria-labelledby="rail-views" className="flex flex-col gap-px">
        {views.map((v) => {
          const broken = "error" in v;
          const current = v.url !== "/" && pathname === v.url;
          return (
            <li key={v.id}>
              <Link
                {...(v.url === "/" ? { to: "/" as const } : { to: "/views/$id" as const, params: { id: v.id } })}
                aria-current={current ? "page" : undefined}
                title={broken ? v.error : (v.description ?? v.title)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors hover:bg-rail-active/60 hover:text-rail-strong focus-visible:outline-rail-ring",
                  current && "bg-rail-active font-semibold text-rail-strong hover:bg-rail-active",
                )}
              >
                {broken ? (
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-rail-muted" />
                ) : (
                  <LayoutDashboard aria-hidden className="size-3.5 shrink-0" strokeWidth={1.6} />
                )}
                <span className="truncate">{broken ? v.id : v.title}</span>
                {broken ? (
                  <span className="ml-auto shrink-0 text-xs text-rail-muted">can't be read</span>
                ) : v.url === "/" ? (
                  <span className="ml-auto shrink-0 text-xs text-rail-muted">Home</span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
