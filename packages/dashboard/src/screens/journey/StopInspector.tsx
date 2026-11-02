import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { useCode, useNeighbors, useNode } from "@/api/queries";
import type { Neighbor } from "@/api/types";
import { CodeBlock } from "@/components/code/CodeBlock";
import { StopRoundel } from "@/components/gallery/StopRoundel";
import { type JourneyStop, stopTitle } from "./model";
import { fileLine, KIND_WORD } from "./words";

const CONTEXT = 12;
const MAX_LINKS = 8;
const SETTLE_MS = 150;

const h4 = "text-xs font-semibold text-muted-foreground";
const section = "flex flex-col gap-2 border-b border-border px-4.5 py-3.5 last:border-b-0";
const quiet = "text-[13px] text-muted-foreground";
const link =
  "rounded-sm underline-offset-3 outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring";

/** The right panel: what the selected stop is, its code, and (for stops on a graph node) its neighbourhood. */
export function StopInspector({ stop, journeyId }: { stop: JourneyStop | undefined; journeyId: string }) {
  return (
    <aside
      aria-label="Stop inspector"
      className="flex min-w-0 flex-col self-start overflow-hidden rounded-xl border border-border bg-card lg:sticky lg:top-0"
    >
      {stop ? <StopDetails stop={stop} journeyId={journeyId} /> : <p className={`${quiet} p-4.5`}>Pick a stop to see its code.</p>}
    </aside>
  );
}

/** `value` once it has stayed the same for `ms`; the first value at once. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, settled, ms]);
  return settled;
}

/** The header follows the selection at once; the requests (code, node, neighbours) wait until the selection
 * has rested for SETTLE_MS, so holding ←/→ across stops does not fetch every stop on the way. */
function StopDetails({ stop, journeyId }: { stop: JourneyStop; journeyId: string }) {
  const settled = useSettled(stop.n, SETTLE_MS);
  const v = stop.view;
  const title = stopTitle(v);
  return (
    <>
      <header className="flex items-start gap-3 border-b border-border px-4.5 py-4">
        <StopRoundel n={stop.n} label={title} state="selected" decorative className="mt-0.5" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[15px] leading-snug font-bold break-words">{title}</h2>
          <span className="font-mono text-xs break-all text-muted-foreground">{fileLine(v.file, v.line)}</span>
          <span className="text-xs text-muted-foreground">
            {KIND_WORD[v.kind] ?? v.kind} · <span className="font-mono">{v.repo}</span>
            {v.op ? ` · ${v.op}` : ""}
          </span>
        </div>
      </header>
      {settled === stop.n ? (
        <StopRequests key={stop.n} stop={stop} journeyId={journeyId} />
      ) : (
        <section className={section}>
          <p className={quiet}>Loading code…</p>
        </section>
      )}
    </>
  );
}

function StopRequests({ stop, journeyId }: { stop: JourneyStop; journeyId: string }) {
  const v = stop.view;
  const code = useCode(v.repo, v.file, Math.max(1, v.line - CONTEXT), v.line + CONTEXT);
  return (
    <>
      <section className={section}>
        {code.data ? (
          <CodeBlock code={code.data.text} startLine={code.data.startLine} highlight={{ from: v.line, to: v.line }} file={v.file} />
        ) : code.error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {code.error.message}
          </p>
        ) : (
          <p className={quiet}>Loading code…</p>
        )}
      </section>
      {v.ref ? <NodeSections nodeRef={v.ref} journeyId={journeyId} /> : null}
    </>
  );
}

function NodeSections({ nodeRef, journeyId }: { nodeRef: string; journeyId: string }) {
  const node = useNode(nodeRef);
  const near = useNeighbors(nodeRef, 1, "both");
  const calls = (dir: "in" | "out") => (near.data?.neighbors ?? []).filter((n) => n.via.type === "calls" && n.via.direction === dir);
  const others = (node.data?.journeys ?? []).filter((j) => j.id !== journeyId);
  return (
    <>
      {node.data?.summary ? (
        <section className={section}>
          <h3 className={h4}>What happens here</h3>
          <p className="max-w-[60ch] text-[13.5px]">{node.data.summary}</p>
        </section>
      ) : null}
      <section className={section}>
        <NeighborList title="Called by" items={calls("in")} loading={near.isPending} />
        <NeighborList title="Calls" items={calls("out")} loading={near.isPending} />
        <LinkList title="Also in journeys" loading={node.isPending} empty="No other journeys">
          {others.map((j) => (
            <li key={j.id}>
              <Link to="/journeys/$id" params={{ id: j.id }} className={`${link} text-[13px] font-semibold`}>
                {j.name}
              </Link>
            </li>
          ))}
        </LinkList>
      </section>
      <section className={section}>
        <Link to="/map" search={{ repo: nodeRef.split("::")[0], node: nodeRef }} className={`${link} w-fit text-[13px] font-semibold text-primary`}>
          Show this stop on the map
        </Link>
      </section>
    </>
  );
}

function NeighborList({ title, items, loading }: { title: string; items: Neighbor[]; loading: boolean }) {
  return (
    <LinkList title={title} loading={loading} empty="None found" more={items.length - MAX_LINKS}>
      {items.slice(0, MAX_LINKS).map((n) => (
        <li key={n.ref} className="min-w-0 truncate">
          <Link to="/map" search={{ repo: n.ref.split("::")[0], node: n.ref }} className={`${link} font-mono text-xs`}>
            {n.name}
          </Link>
        </li>
      ))}
    </LinkList>
  );
}

function LinkList({ title, loading, empty, more = 0, children }: { title: string; loading: boolean; empty: string; more?: number; children: React.ReactNode[] }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <h3 id={id} className={h4}>
        {title}
      </h3>
      {loading ? (
        <p className={quiet}>Loading…</p>
      ) : children.length === 0 ? (
        <p className={quiet}>{empty}</p>
      ) : (
        <ul aria-labelledby={id} className="flex flex-col gap-0.5">
          {children}
          {more > 0 ? <li className={quiet}>and {more} more</li> : null}
        </ul>
      )}
    </div>
  );
}
