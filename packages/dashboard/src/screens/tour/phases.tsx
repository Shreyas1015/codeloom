import { Link } from "@tanstack/react-router";
import { AlertTriangle, CircleCheck, Info } from "lucide-react";
import { type ReactNode, useId } from "react";
import { useCode } from "@/api/queries";
import type { JourneyProgressView, TourFile } from "@/api/types";
import { CodeBlock } from "@/components/code/CodeBlock";
import { CopyButton } from "@/components/gallery/CopyCommand";
import { StopRoundel } from "@/components/gallery/StopRoundel";
import { Breakable } from "@/lib/breakable";
import { cn } from "@/lib/utils";
import { KIND_WORD } from "@/screens/journey/words";
import { Markdown } from "./markdown";
import type { DataStepItem, KeyFields, TourStopItem } from "./model";

const CONTEXT = 12;
const h3 = "text-xs font-semibold text-muted-foreground";
const panel = "flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5";
const mono = "font-mono text-xs leading-[1.6] whitespace-pre-wrap break-words";
const quiet = "text-[13px] text-muted-foreground";
const pill = "inline-flex items-center rounded-[4px] px-1.75 py-px text-xs font-semibold";

const fileLine = (f: KeyFields | null) => (f ? `${f.file}:${f.line}` : "");

/** The stand-in roundel for a stop no longer in the journey: hollow, dashed, no number. */
export function RemovedRoundel({ on = false, big = false }: { on?: boolean; big?: boolean }) {
  return (
    <span
      aria-hidden
      data-slot="removed-roundel"
      className={cn(
        "inline-block flex-none rounded-full border-[1.5px] border-dashed border-destructive bg-card",
        big ? "size-14" : "size-6",
        on && "ring-4 ring-destructive/20",
      )}
    />
  );
}

/** A labelled panel: the label is its heading, so it reads as a named region. */
function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn(panel, className)}>
      <h3 id={id} className={h3}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Markers({ stop }: { stop: Pick<TourStopItem, "stale" | "removed"> }) {
  if (!stop.stale && !stop.removed) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
      {stop.stale ? (
        <>
          <span className={cn(pill, "border border-dashed border-muted-foreground text-foreground")}>May be out of date</span>
          <span className="text-[12.5px] text-muted-foreground">This file changed since the tour was written. The code shown is today's.</span>
        </>
      ) : null}
      {stop.removed ? <span className={cn(pill, "border border-dashed border-destructive text-destructive")}>Removed</span> : null}
    </div>
  );
}

// ---- Flow -----------------------------------------------------------------------------------------

type Trap = TourFile["fileNotes"][number]["notes"][number];

/** One Flow stop: the big numbered heading, its explanation, the stop's code under it and the file's traps
 * ("Remember this"), with the stop's data-journey step beside them (mock 3). */
export function FlowPhase({ stop, index, count, steps, traps }: { stop: TourStopItem; index: number; count: number; steps: DataStepItem[]; traps: Trap[] }) {
  const v = stop.view;
  const where = v ? `${v.repo} · ${KIND_WORD[v.kind] ?? v.kind}` : stop.fields?.repo;
  const step = steps.find((s) => s.key === stop.key);
  return (
    <div className={cn("grid min-w-0 grid-cols-1 items-start gap-6.5", step && "xl:grid-cols-[minmax(0,1fr)_360px]")}>
      <div className="flex min-w-0 flex-col gap-4.5">
        <div className="flex items-center gap-4">
          {stop.n !== undefined ? (
            <StopRoundel n={stop.n} label={stop.title} state="selected" decorative className="size-14 text-[22px]" />
          ) : (
            <RemovedRoundel big />
          )}
          <div className="min-w-0">
            <p className="text-[13px] text-muted-foreground">
              Tour stop {index} of {count}
              {where ? ` · ${where}` : ""}
            </p>
            <h2 className="text-[28px] leading-[1.15] font-bold tracking-[-0.02em] break-words text-balance">{stop.title}</h2>
            <p className="mt-0.5 font-mono text-xs wrap-break-word text-muted-foreground">
              <Breakable text={v ? `${v.file}:${v.line}` : fileLine(stop.fields)} />
            </p>
          </div>
        </div>
        <Markers stop={stop} />
        <Markdown text={stop.explanation} className="max-w-[68ch] text-[15.5px] leading-[1.6]" />
        {v ? (
          <StopCode key={stop.key} repo={v.repo} file={v.file} line={v.line} />
        ) : (
          <p className={cn(panel, "text-[13.5px]")}>
            This stop is no longer in this journey, so its code is not shown. When the tour was written it was at{" "}
            <span className="font-mono text-xs">{stop.fields ? `${stop.fields.repo}/${fileLine(stop.fields)}` : "an unknown place"}</span>.
          </p>
        )}
        {traps.length > 0 ? (
          <div role="note" aria-label="Remember this" className="flex gap-3 rounded-[10px] bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-foreground">
            <AlertTriangle aria-hidden className="mt-0.5 size-4.5 flex-none" />
            <div className="flex flex-col gap-1">
              {traps.map((t, i) => (
                <p key={i}>
                  {i === 0 ? <b>Remember this: </b> : null}
                  {t.text}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {step ? (
        <Panel title="In the data journey">
          <p className="text-[13.5px]">{step.note}</p>
          {step.sql ? <pre className={mono}>{step.sql}</pre> : null}
        </Panel>
      ) : null}
    </div>
  );
}

function StopCode({ repo, file, line }: { repo: string; file: string; line: number }) {
  const code = useCode(repo, file, Math.max(1, line - CONTEXT), line + CONTEXT);
  if (code.data) return <CodeBlock code={code.data.text} startLine={code.data.startLine} highlight={{ from: line, to: line }} file={file} />;
  if (code.error)
    return (
      <p role="alert" className="text-[13px] text-destructive">
        {code.error.message}
      </p>
    );
  return <p className={quiet}>Loading code…</p>;
}

// ---- Data journey ---------------------------------------------------------------------------------

export function DataJourneyPhase({ input, output, steps }: { input: string; output: string; steps: DataStepItem[] }) {
  const listId = useId();
  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-6.5 xl:grid-cols-[minmax(0,1fr)_470px]">
      <div className="flex min-w-0 flex-col gap-3">
        <h2 id={listId} className="text-[20px] font-bold tracking-[-0.02em]">
          Follow one request through the journey
        </h2>
        {steps.length === 0 ? (
          <p className={quiet}>This tour has no data steps.</p>
        ) : (
          <ol aria-label="Data journey steps" className="flex flex-col">
            {steps.map((s, i) => (
              <li key={`${s.key}-${i}`} className="flex gap-3.5">
                <div className="flex flex-none flex-col items-center">
                  {s.n !== undefined ? <StopRoundel n={s.n} label={s.title} decorative /> : <RemovedRoundel />}
                  {i < steps.length - 1 ? <span aria-hidden className="w-0.5 flex-1 bg-connector" /> : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 pb-5">
                  <div className="flex flex-wrap items-baseline gap-x-2.5">
                    <h3 className="text-[15px] font-bold break-words">{s.n !== undefined ? `Stop ${s.n} · ${s.title}` : s.title}</h3>
                    {s.removed ? <span className={cn(pill, "border border-dashed border-destructive text-destructive")}>Removed</span> : null}
                  </div>
                  <p className="font-mono text-[11.5px] wrap-break-word text-muted-foreground">
                    <Breakable text={s.view ? `${s.view.file}:${s.view.line}` : fileLine(s.fields)} />
                  </p>
                  <p className="max-w-[64ch] text-[14px]">{s.note}</p>
                  {s.sql ? (
                    <div className={cn(panel, "py-3")}>
                      <h4 className={h3}>SQL that runs</h4>
                      <pre className={mono}>{s.sql}</pre>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <Panel title="Sample input">
          <pre className={mono}>{input}</pre>
        </Panel>
        <Panel title="Output">
          <pre className={mono}>{output}</pre>
        </Panel>
      </div>
    </div>
  );
}

// ---- File notes -----------------------------------------------------------------------------------

export function FileNotesPhase({ notes }: { notes: TourFile["fileNotes"] }) {
  return (
    <div className="flex max-w-[86ch] min-w-0 flex-col gap-4">
      <h2 className="text-[20px] font-bold tracking-[-0.02em]">What to know about each file</h2>
      {notes.length === 0 ? <p className={quiet}>This tour has no file notes.</p> : null}
      {notes.map((f) => (
        <FileNotes key={`${f.repo}/${f.file}`} file={f} />
      ))}
    </div>
  );
}

function FileNotes({ file }: { file: TourFile["fileNotes"][number] }) {
  const id = useId();
  const path = `${file.repo}/${file.file}`;
  const traps = file.notes.filter((n) => n.kind === "trap");
  const rest = file.notes.filter((n) => n.kind !== "trap");
  return (
    <section aria-labelledby={id} className={cn(panel, "gap-2.5")}>
      <h3 id={id} aria-label={path} className="font-mono text-[12.5px] font-semibold wrap-break-word">
        <Breakable text={path} />
      </h3>
      <ul className="flex flex-col gap-2">
        {[...traps, ...rest].map((n, i) =>
          n.kind === "trap" ? (
            <li key={i} data-kind="trap" className="flex gap-3 rounded-[10px] bg-accent-soft px-3.5 py-3 text-[13.5px] text-accent-foreground">
              <AlertTriangle aria-hidden className="mt-0.5 size-4.5 flex-none" />
              <div>
                <b>Trap: </b>
                <span>{n.text}</span>
              </div>
            </li>
          ) : (
            <li key={i} data-kind="note" className="flex gap-3 px-3.5 py-1 text-[13.5px]">
              <Info aria-hidden className="mt-0.5 size-4.5 flex-none text-muted-foreground" />
              <div>
                <span className="sr-only">Note: </span>
                <span>{n.text}</span>
              </div>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

// ---- Check yourself -------------------------------------------------------------------------------

const day = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";

/** The end of the walk, said where it happens: toured (and what makes it understood), or understood. */
function WalkedNote({ walked, progress }: { walked: boolean; progress: JourneyProgressView | undefined }) {
  const understood = progress?.level === "understood" && progress.needsReWalk.length === 0;
  if (!walked && !understood) return null;
  return (
    <div role="status" aria-label="Tour walked" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] bg-success-soft px-3.5 py-2.5 text-[13.5px]">
      <CircleCheck aria-hidden className="size-4.5 flex-none text-success" />
      <span className="font-semibold">{understood ? "Understood. You passed this journey's check." : "Toured. Pass the check to count it as understood."}</span>
      <Link to="/progress" className="ml-auto rounded-sm font-semibold underline underline-offset-3 outline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring">
        See your progress
      </Link>
    </div>
  );
}

export function CheckPhase({
  id,
  check,
  progress,
  progressError,
  walked,
  canCheck,
}: {
  id: string;
  check: TourFile["check"];
  progress: JourneyProgressView | undefined;
  progressError: Error | null;
  walked: boolean;
  canCheck: boolean;
}) {
  const command = `/mcp__codeloom__check-me ${id}`;
  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-6.5 xl:grid-cols-[minmax(0,1fr)_470px]">
      <div className="flex min-w-0 flex-col gap-4">
        <h2 className="text-[20px] font-bold tracking-[-0.02em]">Can you answer these?</h2>
        <WalkedNote walked={walked} progress={progress} />
        <ol aria-label="Questions" className="flex flex-col gap-3">
          {check.map((q, i) => (
            <li key={i} className={cn(panel, "gap-2")}>
              <p className="text-[15px] font-semibold">
                <span className="mr-2 font-mono text-[13px] text-muted-foreground tabular-nums">{i + 1}</span>
                {q.question}
              </p>
            </li>
          ))}
        </ol>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {canCheck ? (
          <section aria-labelledby="check-me" className={panel}>
            <h3 id="check-me" className="text-[15px] font-bold">
              Check me in Claude
            </h3>
            <p className="text-[13.5px]">
              Claude asks you these questions one at a time and judges your answers against the code. Only a pass marks this journey understood.
            </p>
            <div className="flex flex-wrap items-center gap-2.5">
              <CopyButton text={command} label="Check me in Claude" visibleLabel variant="default" />
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12.5px] select-all">{command}</code>
            </div>
          </section>
        ) : null}
        <Panel title="Last check">
          {progressError ? (
            <p className={quiet}>Your progress could not be read: {progressError.message}</p>
          ) : !progress?.lastCheck ? (
            <p className={quiet}>No check yet.</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2 text-[13.5px]">
                <span className={cn(pill, progress.lastCheck.verdict === "pass" ? "bg-success-soft text-foreground" : "bg-secondary text-foreground")}>
                  {progress.lastCheck.verdict === "pass" ? "Passed" : "Not passed"}
                </span>
                <span className="text-muted-foreground">{day(progress.lastCheck.at)}</span>
              </p>
              {progress.lastCheck.notes ? <p className="text-[13.5px]">{progress.lastCheck.notes}</p> : null}
            </>
          )}
        </Panel>
        <Panel title="History">
          <History progress={progress} />
        </Panel>
      </div>
    </div>
  );
}

function History({ progress }: { progress: JourneyProgressView | undefined }) {
  const rows = [
    progress?.seenAt ? { what: "Seen", at: progress.seenAt } : null,
    progress?.touredAt ? { what: "Toured", at: progress.touredAt } : null,
    progress?.understoodAt ? { what: "Understood", at: progress.understoodAt } : null,
  ].filter((r) => r !== null);
  const rewalk = progress?.needsReWalk.length ?? 0;
  if (rows.length === 0) return <p className={quiet}>Nothing yet.</p>;
  return (
    <>
      <ul className="flex flex-col gap-1 text-[13.5px]">
        {rows.map((r) => (
          <li key={r.what} className="flex justify-between gap-4">
            <span>{r.what}</span>
            <span className="text-muted-foreground">{day(r.at)}</span>
          </li>
        ))}
      </ul>
      {rewalk > 0 ? (
        <p className="text-[13px]">
          {rewalk === 1 ? "1 stop changed" : `${rewalk} stops changed`} since you passed. Walk {rewalk === 1 ? "it" : "them"} again, then check again.
        </p>
      ) : null}
    </>
  );
}
