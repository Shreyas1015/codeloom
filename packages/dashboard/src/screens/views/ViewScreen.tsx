/** Views: a saved `.codeloom/views/<id>.json` laid out as its widgets, top to bottom. The dashboard only
 * reads views; Claude writes them through MCP (save_view). */
import { FileWarning, LayoutDashboard } from "lucide-react";
import { useId } from "react";
import { ApiError } from "@/api/client";
import { useOverview, useView } from "@/api/queries";
import type { ViewFile } from "@/api/types";
import { Command } from "@/components/gallery/CopyCommand";
import { ScreenError } from "@/components/shell/StateBanner";
import { WidgetBoundary, WidgetView } from "./Widgets";

export const MAKE_VIEW = "/mcp__codeloom__make-view";

const H1 = "text-[32px] leading-[1.1] font-bold tracking-[-0.03em] text-balance";

/** A valid view: its title and description as the nameplate, then every widget in order. */
export function ViewBody({ view, home = false }: { view: ViewFile; home?: boolean }) {
  const workspace = useOverview().data?.name;
  return (
    <section data-testid={home ? "screen-home" : "screen-view"} data-view={view.id} aria-labelledby="view-title" className="flex flex-col gap-5.5">
      <header className="flex flex-col gap-1">
        <h1 id="view-title" className={H1}>
          {view.title}
        </h1>
        {view.description && <p className="max-w-[70ch] text-[13.5px] text-muted-foreground">{view.description}</p>}
        <p className="text-[12.5px] text-muted-foreground">
          {home ? (
            <>
              {workspace ? `${workspace} · a` : "A"} custom Home made by your agent. <code className="font-mono text-[11.5px]">codeloom views reset home</code> brings back the built-in one.
            </>
          ) : (
            <>
              A view made by your agent, saved in <code className="font-mono text-[11.5px]">.codeloom/views/{view.id}.json</code>
            </>
          )}
        </p>
      </header>
      {view.widgets.length === 0 ? (
        <p className="max-w-[70ch] rounded-xl border border-border bg-card px-5 py-4 text-[13.5px] text-muted-foreground">
          This view has no widgets yet. Ask your agent to add some.
        </p>
      ) : (
        view.widgets.map((w, i) => (
          <WidgetBoundary key={`${i}:${w.type}`}>
            <WidgetView widget={w} />
          </WidgetBoundary>
        ))
      )}
    </section>
  );
}

/** A view file that exists but cannot be read: what codeloom said, and the command that checks it. */
export function ViewErrorCard({ id, error }: { id: string; error: string }) {
  const h = useId();
  return (
    <section role="alert" aria-labelledby={h} className="flex max-w-[64ch] flex-col items-start gap-3 rounded-xl border border-dashed border-destructive bg-card px-6 py-5">
      <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-destructive-soft text-destructive">
        <FileWarning className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 id={h} className="text-xl font-bold tracking-[-0.02em]">
          This view can't be read
        </h2>
        <p className="text-[13.5px] text-muted-foreground text-pretty">
          <code className="font-mono text-[12.5px] text-foreground">.codeloom/views/{id}.json</code> is damaged or was edited by hand. The rest of the
          dashboard works as usual. Check it with:
        </p>
      </div>
      <div className="flex items-center rounded-xl border border-border bg-card py-2 pr-2 pl-3">
        <span aria-hidden className="mr-2 font-mono text-[12.5px] text-muted-foreground select-none">
          $
        </span>
        <Command text="codeloom doctor" />
      </div>
      <p className="max-w-full rounded-lg bg-muted px-3 py-2 text-[12.5px] break-words text-muted-foreground">
        <span className="font-semibold text-foreground">codeloom said: </span>
        {error}
      </p>
    </section>
  );
}

function NotFound({ id }: { id: string }) {
  return (
    <div className="flex max-w-[70ch] flex-col items-start gap-3">
      <span aria-hidden className="grid size-10 place-items-center rounded-xl bg-lane-api-soft text-primary">
        <LayoutDashboard className="size-5" />
      </span>
      <h1 id="view-title" className={H1}>
        No view called {id}
      </h1>
      <p className="text-[13.5px] text-muted-foreground">
        Views live in <code className="font-mono text-[12.5px]">.codeloom/views/</code>. To make one, describe it to your agent:
      </p>
      <Command text={MAKE_VIEW} />
    </div>
  );
}

function Skeleton() {
  const bar = "rounded-md bg-muted motion-safe:animate-pulse";
  return (
    <div data-testid="view-loading" aria-busy="true" aria-label="Loading the view" className="flex flex-col gap-5.5">
      <div className={`${bar} h-10 w-1/2`} />
      <div className={`${bar} h-16`} />
      <div className={`${bar} h-48`} />
    </div>
  );
}

/** `/views/$id`. */
export function ViewScreen({ id }: { id: string }) {
  const { data, error } = useView(id);
  if (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return <NotFound id={id} />;
    return (
      <section data-testid="screen-view" aria-labelledby="view-title" className="flex flex-col gap-5.5">
        <h1 id="view-title" className={H1}>
          {id}
        </h1>
        <ScreenError error={error} fallback="Something went wrong loading this view." />
      </section>
    );
  }
  if (!data) return <Skeleton />;
  if (data.view) return <ViewBody view={data.view} />;
  return (
    <section data-testid="screen-view" aria-labelledby="view-title" className="flex flex-col gap-5.5">
      <h1 id="view-title" className={H1}>
        {id}
      </h1>
      <ViewErrorCard id={id} error={data.error ?? "The view file is empty."} />
    </section>
  );
}
