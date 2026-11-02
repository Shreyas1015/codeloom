import { Link } from "@tanstack/react-router";
import type { ChainRow } from "@/api/types";
import { AgentHint, CompleteMark, ConfidenceMark, ShowMore, useLimit } from "./parts";

/** Chains no journey names yet, with the hint to let the agent name them. */
export function UnnamedChains({ chains }: { chains: ChainRow[] }) {
  const [limit, more] = useLimit("chains");
  if (chains.length === 0) return null;
  return (
    <section aria-labelledby="home-unnamed" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="home-unnamed" className="text-xl font-bold tracking-[-0.02em]">
          Unnamed chains <span className="font-mono text-sm font-semibold text-muted-foreground tabular">{chains.length}</span>
        </h2>
        <p className="max-w-[70ch] text-[13.5px] text-muted-foreground">
          Flows codeloom traced from an entry point that no journey names yet. Your agent can group and name them.
        </p>
        <AgentHint />
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <ul aria-label="Unnamed chains" className="divide-y divide-border">
          {chains.slice(0, limit).map((c) => (
            <li key={c.id}>
              <Link
                to="/journeys/$id"
                params={{ id: c.id }}
                className="flex flex-col gap-1.5 px-5 py-2.5 transition-colors outline-none hover:bg-muted/50 focus-visible:bg-accent-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center md:gap-4.5"
              >
                <span className="truncate font-mono text-[13px] font-semibold">{c.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{c.entry}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{c.repos.join(", ")}</span>
                <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <ConfidenceMark confidence={c.confidence} />
                  <CompleteMark complete={c.complete} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <ShowMore shown={Math.min(limit, chains.length)} total={chains.length} onMore={more} />
      </div>
    </section>
  );
}
