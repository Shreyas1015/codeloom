import { Link, useRouterState } from "@tanstack/react-router";
import { House, Map as MapIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { Overview, RepoRole } from "@/api/types";
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

function NavItem({ to, icon, label, count, countLabel, current }: { to: "/" | "/map"; icon: ReactNode; label: string; count?: number; countLabel: string; current: boolean }) {
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
          {fmt(count)}
          <span className="sr-only"> {countLabel}</span>
        </span>
      )}
    </Link>
  );
}

/** The painted gallery wall: brand, workspace, nav with counts, repo list, agent status. */
export function Rail({ overview }: { overview: Overview | undefined }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onMap = pathname === "/map" || pathname.startsWith("/map/");
  const files = overview?.repos.reduce((s, r) => s + r.files, 0);
  const repoCount = overview?.repos.length ?? 0;
  const iconCls = "size-[17px] shrink-0";

  return (
    <aside aria-label="codeloom" className="flex w-58 shrink-0 flex-col gap-6 overflow-y-auto bg-rail px-4 pt-6 pb-4.5 text-rail-foreground [scrollbar-color:var(--rail-border)_transparent]">
      <div className="flex items-center gap-2.5 px-1.5">
        <LoomMark className="size-5.5 text-accent" />
        <span className="text-[21px] leading-none font-bold tracking-[-0.02em] text-rail-strong">codeloom</span>
      </div>

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

      <nav aria-label="Main" className="flex flex-col gap-0.5">
        <NavItem to="/" icon={<House className={iconCls} strokeWidth={1.6} />} label="Home" count={overview?.journeys.total} countLabel="journeys" current={!onMap} />
        <NavItem to="/map" icon={<MapIcon className={iconCls} strokeWidth={1.6} />} label="Map" count={files} countLabel="files" current={onMap} />
      </nav>

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

      {overview && (
        <div className="mt-auto flex items-center gap-2 rounded-[9px] bg-rail-deep px-3 py-2.5 text-[12.5px]">
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
    </aside>
  );
}
