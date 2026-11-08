import { FileText, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useDoc, useJourneySpecs } from "@/api/queries";
import type { JourneySpecsResponse, SpecDocCandidate, SpecLink, SpecTicketCandidate } from "@/api/types";
import { CodeBlock } from "@/components/code/CodeBlock";
import { Command } from "@/components/gallery/CopyCommand";
import { SpecBadge } from "@/components/gallery/SpecBadge";
import { SpecsError } from "@/components/gallery/SpecsError";
import { Button } from "@/components/ui/button";
import { Breakable } from "@/lib/breakable";
import { MATCH_SPECS, parseDocRef, specMark } from "@/lib/specs";
import { cn } from "@/lib/utils";

/** The doc open in the viewer, and the line to mark (a candidate's evidence). */
interface OpenDoc {
  repo: string;
  file: string;
  line?: number;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const H3 = "text-[15px] font-bold";
const PANEL = "rounded-xl border border-border bg-card";
// a doc name is a link to read it beside the list: underlined at rest (hairline), darker on hover
const OPEN =
  "rounded-sm text-left underline decoration-border decoration-1 underline-offset-3 outline-offset-2 transition-colors hover:decoration-foreground motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring aria-[current=true]:decoration-foreground aria-[current=true]:decoration-2";
/** Prose docs wrap in the viewer; anything else keeps its lines. */
const isProse = (file: string) => /\.(md|mdx|markdown|txt)$/i.test(file) || !/\.[a-z0-9]+$/i.test(file.split("/").pop() ?? "");

const EVIDENCE_WORD: Record<SpecDocCandidate["evidence"][number]["kind"], string> = {
  route: "Route",
  page: "Page",
  table: "Table",
  queue: "Queue",
  symbol: "Code name",
};

/** The Journey screen's Specs tab: the docs and tickets Claude linked (with its reason), or before a check,
 * the candidates codeloom found and why; a doc opens read-only beside the list. */
export function SpecsTab({ journeyId }: { journeyId: string }) {
  const { data, error, isPending } = useJourneySpecs(journeyId);
  const [open, setOpen] = useState<OpenDoc | null>(null);

  if (error) return <SpecsError error={error} />;
  if (isPending) return <p className="text-[13px] text-muted-foreground">Loading spec links…</p>;

  return (
    <div className={cn("grid items-start gap-5", open ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : "max-w-[86ch]")}>
      <div className="flex min-w-0 flex-col gap-5">
        <Summary s={data} />
        {data.links.length > 0 ? <Linked links={data.links} open={open} onOpen={setOpen} /> : null}
        {!data.checked ? <Candidates s={data} open={open} onOpen={setOpen} /> : null}
      </div>
      {open ? <DocViewer doc={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function Summary({ s }: { s: JourneySpecsResponse }) {
  const mark = specMark(s);
  const found = s.candidates.docs.length + s.candidates.tickets.length;
  const text: Record<typeof mark, ReactNode> = {
    linked: `Claude linked ${linkedWhat(s.links)}${s.checkedAt ? ` on ${day(s.checkedAt)}` : ""}. Each says why it fits.`,
    none: `Checked${s.checkedAt ? ` on ${day(s.checkedAt)}` : ""}: no doc or ticket describes this journey.`,
    candidates: `Not checked yet. codeloom found ${plural(s.candidates.docs.length, "doc")} and ${plural(s.candidates.tickets.length, "ticket")} that mention this journey's routes, pages, tables or code. Claude decides which really describe it.`,
    unchecked: s.candidatesIndexed
      ? "Not checked yet, and no doc or ticket mentions this journey's routes, pages, tables or code."
      : "Not checked yet. codeloom looks for candidate docs and tickets when it indexes: run codeloom index.",
  };
  return (
    <section aria-label="Spec state" className="flex flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <SpecBadge state={s.state} checked={s.checked} />
        <p className="max-w-[70ch] text-[13.5px] text-muted-foreground">{text[mark]}</p>
      </div>
      {s.checked || found > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[13px] text-foreground">
            {s.checked ? "To check it again, ask Claude:" : "To check the candidates, ask Claude (it saves only the ones that fit):"}
          </p>
          <div className="flex w-fit items-center rounded-xl border border-border bg-card py-1.5 pr-1.5 pl-3">
            <Command text={`${MATCH_SPECS} ${s.journeyId}`} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** "1 doc and 2 tickets": what Claude linked, by kind. */
function linkedWhat(links: SpecLink[]): string {
  const docs = links.filter((l) => l.kind === "doc").length;
  const tickets = links.length - docs;
  return [docs ? plural(docs, "doc") : "", tickets ? plural(tickets, "ticket") : ""].filter(Boolean).join(" and ");
}

type Opener = { open: OpenDoc | null; onOpen: (d: OpenDoc) => void };

function DocButton({ repo, file, line, open, onOpen, children, className }: OpenDoc & Opener & { children: ReactNode; className?: string }) {
  // the doc's own name is current while that doc is open; an evidence line is current while open at it
  const current = !!open && open.repo === repo && open.file === file && (line === undefined || open.line === line);
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      aria-label={line === undefined ? `Open ${file}` : `Open ${file} at line ${line}`}
      title={`${repo}/${file}${line === undefined ? "" : `:${line}`}`}
      onClick={() => onOpen({ repo, file, ...(line === undefined ? {} : { line }) })}
      className={cn(OPEN, className)}
    >
      {children}
    </button>
  );
}

function Linked({ links, open, onOpen }: { links: SpecLink[] } & Opener) {
  const docs = links.filter((l) => l.kind === "doc");
  const tickets = links.filter((l) => l.kind === "ticket");
  return (
    <>
      {docs.length > 0 ? (
        <section aria-labelledby="specs-docs" className="flex flex-col gap-2">
          <h3 id="specs-docs" className={H3}>
            Linked docs
          </h3>
          <ul aria-labelledby="specs-docs" className={cn(PANEL, "divide-y divide-border")}>
            {docs.map((l) => {
              const ref = parseDocRef(l.ref);
              return (
                <li key={l.ref} className="flex flex-col gap-1 px-4.5 py-3">
                  {ref ? (
                    <DocButton repo={ref.repo} file={ref.file} open={open} onOpen={onOpen}>
                      <span className="flex items-start gap-1.5 font-mono text-[12.5px] font-semibold">
                        <FileText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                        <Breakable text={ref.file} />
                      </span>
                    </DocButton>
                  ) : (
                    <span className="font-mono text-[12.5px] font-semibold">{l.ref}</span>
                  )}
                  {ref ? <span className="font-mono text-[11.5px] text-muted-foreground">{ref.repo}</span> : null}
                  <p className="max-w-[68ch] text-[13.5px]">{l.reason}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {tickets.length > 0 ? (
        <section aria-labelledby="specs-tickets" className="flex flex-col gap-2">
          <h3 id="specs-tickets" className={H3}>
            Linked tickets
          </h3>
          <ul aria-labelledby="specs-tickets" className={cn(PANEL, "divide-y divide-border")}>
            {tickets.map((l) => (
              <li key={l.ref} className="flex flex-col gap-1 px-4.5 py-3">
                <span className="font-mono text-[12.5px] font-semibold">{l.ref}</span>
                <p className="max-w-[68ch] text-[13.5px]">{l.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Candidates({ s, open, onOpen }: { s: JourneySpecsResponse } & Opener) {
  const { docs, tickets } = s.candidates;
  if (docs.length + tickets.length === 0) return null;
  return (
    <>
      {docs.length > 0 ? (
        <section aria-labelledby="specs-cand-docs" className="flex flex-col gap-2">
          <h3 id="specs-cand-docs" className={H3}>
            Candidate docs <span className="font-mono text-[12.5px] font-semibold text-muted-foreground tabular-nums">{docs.length}</span>
          </h3>
          <ul aria-label="Candidate docs" className={cn(PANEL, "divide-y divide-border")}>
            {docs.map((d) => (
              <DocCandidate key={d.ref} d={d} open={open} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ) : null}
      {tickets.length > 0 ? (
        <section aria-labelledby="specs-cand-tickets" className="flex flex-col gap-2">
          <h3 id="specs-cand-tickets" className={H3}>
            Candidate tickets <span className="font-mono text-[12.5px] font-semibold text-muted-foreground tabular-nums">{tickets.length}</span>
          </h3>
          <ul aria-label="Candidate tickets" className={cn(PANEL, "divide-y divide-border")}>
            {tickets.map((t) => (
              <TicketCandidate key={t.ref} t={t} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function DocCandidate({ d, open, onOpen }: { d: SpecDocCandidate } & Opener) {
  const more = d.count - d.evidence.length;
  return (
    <li className="flex flex-col gap-1.5 px-4.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <DocButton repo={d.repo} file={d.file} open={open && open.line === undefined ? open : null} onOpen={onOpen}>
          <span className="flex items-start gap-1.5 font-mono text-[12.5px] font-semibold">
            <FileText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <Breakable text={d.file} />
          </span>
        </DocButton>
        <span className="text-[12.5px] text-muted-foreground">
          {plural(d.count, "mention")} · <span className="font-mono text-[11.5px]">{d.repo}</span>
        </span>
      </div>
      <ul aria-label={`Why ${d.file}`} className="flex flex-col gap-0.5">
        {d.evidence.map((e) => (
          <li key={`${e.kind}:${e.term}:${e.line}`} className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-baseline gap-x-3 text-[12.5px]">
            <span className="text-muted-foreground">{EVIDENCE_WORD[e.kind]}</span>
            <span className="min-w-0 font-mono text-[11.5px]" title={e.term}>
              <Breakable text={e.term} />
            </span>
            <DocButton repo={d.repo} file={e.file} line={e.line} open={open} onOpen={onOpen} className="text-[12.5px] whitespace-nowrap text-muted-foreground">
              line <span className="font-mono text-[11.5px] tabular-nums">{e.line}</span>
            </DocButton>
          </li>
        ))}
      </ul>
      {more > 0 ? <small className="text-[12.5px] text-muted-foreground">and {plural(more, "more mention")}</small> : null}
    </li>
  );
}

function TicketCandidate({ t }: { t: SpecTicketCandidate }) {
  const more = t.count - t.evidence.length;
  return (
    <li className="flex flex-col gap-1.5 px-4.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-mono text-[12.5px] font-semibold">{t.ref}</span>
        <span className="text-[12.5px] text-muted-foreground">{plural(t.count, "commit")}</span>
      </div>
      <ul aria-label={`Commits that name ${t.ref}`} className="flex flex-col gap-1">
        {t.evidence.map((e) => (
          <li key={`${e.repo}:${e.commit}:${e.file}`} className="flex flex-col text-[12.5px]">
            <span>
              <span className="font-mono text-[11.5px] text-muted-foreground">{e.commit}</span> {e.subject}
            </span>
            <span className="font-mono text-[11.5px] text-muted-foreground" title={`${e.repo}/${e.file}`}>
              {e.repo} · <Breakable text={e.file} />
            </span>
          </li>
        ))}
      </ul>
      {more > 0 ? <small className="text-[12.5px] text-muted-foreground">and {plural(more, "more commit")}</small> : null}
    </li>
  );
}

/** A doc's whole text, read only, with the evidence line marked and scrolled to. */
function DocViewer({ doc, onClose }: { doc: OpenDoc; onClose: () => void }) {
  const { data, error, isPending } = useDoc(doc.repo, doc.file);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  const ready = !!data;
  useEffect(() => {
    if (!ready || doc.line === undefined) return;
    box.current?.querySelector(`[data-line="${doc.line}"]`)?.scrollIntoView?.({ block: "center" });
  }, [ready, doc.line]);

  return (
    <aside aria-labelledby={id} className={cn(PANEL, "flex min-w-0 flex-col gap-2.5 px-4 py-3.5 lg:sticky lg:top-0")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={id} className="font-mono text-[12.5px] font-semibold">
            <Breakable text={doc.file} />
          </h3>
          <span className="text-[12.5px] text-muted-foreground">
            <span className="font-mono text-[11.5px]">{doc.repo}</span> · read only
          </span>
        </div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close doc" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X aria-hidden />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          This doc can't be opened: {error.message}
        </p>
      ) : isPending ? (
        <p className="text-[13px] text-muted-foreground">Opening…</p>
      ) : (
        <div ref={box} className="max-h-[70vh] overflow-y-auto">
          <CodeBlock code={data.text} file={data.file} wrap={isProse(data.file)} highlight={doc.line === undefined ? undefined : { from: doc.line, to: doc.line }} />
        </div>
      )}
    </aside>
  );
}
